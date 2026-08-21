/**
 * Chunked-LOD terrain.
 *
 * Six quadtrees, one per cube face, subdivided towards the camera. Patch
 * meshes are built in a worker pool and recycled through a geometry pool, so
 * flying from orbit to ground level allocates almost nothing after the first
 * few seconds.
 *
 * A node keeps rendering its own mesh until all four children have arrived,
 * which is what stops holes appearing in the planet during a fast zoom.
 */

import * as THREE from 'three';
import { faceUvToUnit } from './cubesphere';
import { buildPatchIndices } from './patchTypes';
import type { PatchRequestMessage, PatchResultMessage } from './patchTypes';
import { MAX_ELEVATION, PLANET_RADIUS } from './config';

interface PatchNode {
  face: number;
  level: number;
  u0: number;
  v0: number;
  size: number;
  /** Unit direction to the patch centre. */
  dir: THREE.Vector3;
  /** World-space patch centre. Estimated until the mesh arrives. */
  center: THREE.Vector3;
  /** Bounding radius around `center`. Estimated until the mesh arrives. */
  boundRadius: number;
  /** Angular radius on the sphere, for horizon culling. */
  angularRadius: number;
  /**
   * Worst height error introduced by rendering this patch instead of its
   * children, approximated by the patch's vertex spacing.
   */
  geomError: number;
  children: PatchNode[] | null;
  mesh: THREE.Mesh | null;
  requestId: number;
  /** Set while the node's mesh has been requested but not yet delivered. */
  pending: boolean;
}

export interface TerrainStats {
  visiblePatches: number;
  liveNodes: number;
  pending: number;
  queued: number;
  triangles: number;
  deepestLevel: number;
}

export interface TerrainOptions {
  seed: number;
  radius?: number;
  grid: number;
  maxLevel: number;
  /** Screen-space error budget in pixels. */
  pixelError: number;
  /** Soft ceiling on simultaneously visible patches. */
  patchBudget?: number;
  material: THREE.Material;
}

/** Angular allowance so peaks beyond the geometric horizon are not culled. */
const ELEVATION_HORIZON = Math.acos(PLANET_RADIUS / (PLANET_RADIUS + MAX_ELEVATION));

export class TerrainSystem {
  readonly group = new THREE.Group();

  private radius: number;
  private grid: number;
  private maxLevel: number;
  private pixelError: number;
  private patchBudget: number;
  /**
   * Multiplier applied to the error budget to keep the patch count near
   * `patchBudget`. A fixed pixel error is correct for image quality but says
   * nothing about cost: looking along a mountain range at low altitude can ask
   * for several times as much geometry as looking straight down from orbit.
   * This trades a little sharpness for a stable frame time.
   */
  private errorScale = 1;
  private material: THREE.Material;

  private roots: PatchNode[] = [];
  private workers: Worker[] = [];
  private workerLoad: number[] = [];
  private inFlight = new Map<number, PatchNode>();
  private nextRequestId = 1;

  private index: THREE.BufferAttribute;
  private vertexCount: number;
  private triangleCount: number;
  private meshPool: THREE.Mesh[] = [];

  private queue: PatchNode[] = [];
  private stats: TerrainStats = {
    visiblePatches: 0,
    liveNodes: 0,
    pending: 0,
    queued: 0,
    triangles: 0,
    deepestLevel: 0,
  };

  private tmpDir = new THREE.Vector3();
  private projScale = 1000;

  constructor(opts: TerrainOptions) {
    this.radius = opts.radius ?? PLANET_RADIUS;
    this.grid = opts.grid;
    this.maxLevel = opts.maxLevel;
    this.pixelError = opts.pixelError;
    this.patchBudget = opts.patchBudget ?? 260;
    this.material = opts.material;
    this.group.name = 'terrain';
    // Patches manage their own visibility, including horizon culling, and
    // their bounding spheres are set explicitly.
    this.group.matrixAutoUpdate = false;

    const border = 4 * (this.grid - 1);
    this.vertexCount = this.grid * this.grid + border;
    this.triangleCount = (this.grid - 1) * (this.grid - 1) * 2 + border * 2;
    this.index = new THREE.BufferAttribute(buildPatchIndices(this.grid), 1);

    this.spawnWorkers(opts.seed);

    for (let face = 0; face < 6; face++) {
      this.roots.push(this.makeNode(face, 0, -1, -1, 2));
    }
  }

  private spawnWorkers(seed: number): void {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 4 : 4;
    const count = Math.max(2, Math.min(6, cores - 1));
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('../workers/terrain.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.postMessage({ type: 'init', seed, radius: this.radius });
      worker.onmessage = (e: MessageEvent<PatchResultMessage>) => this.onPatch(i, e.data);
      this.workers.push(worker);
      this.workerLoad.push(0);
    }
  }

  private makeNode(
    face: number,
    level: number,
    u0: number,
    v0: number,
    size: number,
  ): PatchNode {
    const unit = new Float64Array(3);
    faceUvToUnit(face, u0 + size * 0.5, v0 + size * 0.5, unit);
    const dir = new THREE.Vector3(unit[0], unit[1], unit[2]);

    // Until the real mesh arrives, estimate the extent from the patch's arc
    // size. A quarter turn spans two units of face space, hence pi/4.
    const arcHalf = (size * 0.5 * Math.SQRT2 * this.radius * Math.PI) / 4;
    // Allow for terrain relief inside the patch, but scale it with the patch:
    // a two-metre patch cannot contain a whole mountain, and pretending it can
    // inflates its bounding radius enough to distort the split test.
    const relief = Math.min(MAX_ELEVATION, arcHalf * 0.5);
    const boundRadius = arcHalf + relief;

    return {
      face,
      level,
      u0,
      v0,
      size,
      dir,
      center: dir.clone().multiplyScalar(this.radius),
      boundRadius,
      angularRadius: arcHalf / this.radius,
      // Vertex spacing under-states the real error, and the silhouette against
      // the sky is where any under-tessellation shows first, so bias upward.
      geomError: ((arcHalf * 2) / (this.grid - 1)) * 1.6,
      children: null,
      mesh: null,
      requestId: 0,
      pending: false,
    };
  }

  // --- Frame update -------------------------------------------------------

  /**
   * @param projScale viewport height divided by twice the tangent of the half
   *   field of view — converts a world-space size at unit distance into pixels.
   */
  update(cameraWorldPos: THREE.Vector3, projScale: number): void {
    this.projScale = projScale;
    this.queue.length = 0;
    this.stats.visiblePatches = 0;
    this.stats.liveNodes = 0;
    this.stats.triangles = 0;
    this.stats.deepestLevel = 0;

    const camDist = cameraWorldPos.length();
    // Shrink the occluder slightly: the horizon should be computed against the
    // lowest ground, not sea level, or coastal terrain pops out of view.
    const occluder = this.radius * 0.99;
    const horizonAngle =
      camDist > occluder ? Math.acos(Math.min(1, occluder / camDist)) : Math.PI;
    this.tmpDir.copy(cameraWorldPos).normalize();

    for (const root of this.roots) {
      this.traverse(root, cameraWorldPos, horizonAngle);
    }

    // Nudge the error budget towards the patch ceiling. Deliberately slow, and
    // slower to tighten than to relax, so the geometry never visibly pumps.
    // The dead zone matters: without it the budget hunts around the target
    // forever, and the LOD tree never stops queueing and dropping patches.
    const ratio = this.stats.visiblePatches / this.patchBudget;
    if (ratio > 1.05) this.errorScale = Math.min(4, this.errorScale * 1.03);
    else if (ratio < 0.85) this.errorScale = Math.max(1, this.errorScale * 0.985);

    this.stats.pending = this.inFlight.size;
    this.stats.queued = this.queue.length;
    this.dispatch(cameraWorldPos);
  }

  private traverse(node: PatchNode, camPos: THREE.Vector3, horizonAngle: number): void {
    this.stats.liveNodes++;

    // Distance to the nearest point of the patch, not to its centre. Using the
    // centre makes large patches look far away even when the camera is right
    // above one of their corners, and the top of the tree never subdivides.
    const dist = Math.max(0.001, node.center.distanceTo(camPos) - node.boundRadius);
    const screenError = (node.geomError * this.projScale) / dist;
    const budget = this.pixelError * this.errorScale;
    const wantSplit = node.level < this.maxLevel && screenError > budget;

    if (wantSplit) {
      if (!node.children) this.createChildren(node);
      const kids = node.children!;
      let allReady = true;
      for (const kid of kids) {
        if (!kid.mesh) {
          allReady = false;
          this.want(kid);
        }
      }
      if (allReady) {
        this.hide(node);
        for (const kid of kids) this.traverse(kid, camPos, horizonAngle);
        return;
      }
      // Fall through and keep showing this node's own mesh while we wait.
    } else if (node.children) {
      this.collapse(node);
    }

    this.want(node);
    this.show(node, camPos, horizonAngle);
  }

  private createChildren(node: PatchNode): void {
    const half = node.size * 0.5;
    node.children = [
      this.makeNode(node.face, node.level + 1, node.u0, node.v0, half),
      this.makeNode(node.face, node.level + 1, node.u0 + half, node.v0, half),
      this.makeNode(node.face, node.level + 1, node.u0, node.v0 + half, half),
      this.makeNode(node.face, node.level + 1, node.u0 + half, node.v0 + half, half),
    ];
  }

  /** Drop a node's subtree, recycling its meshes and cancelling its requests. */
  private collapse(node: PatchNode): void {
    if (!node.children) return;
    for (const kid of node.children) {
      this.collapse(kid);
      if (kid.mesh) {
        this.release(kid.mesh);
        kid.mesh = null;
      }
      if (kid.pending) {
        this.inFlight.delete(kid.requestId);
        kid.pending = false;
      }
    }
    node.children = null;
  }

  private want(node: PatchNode): void {
    if (node.mesh || node.pending) return;
    this.queue.push(node);
  }

  private show(node: PatchNode, camPos: THREE.Vector3, horizonAngle: number): void {
    if (!node.mesh) return;

    // Horizon culling. Frustum culling alone leaves the entire far side of the
    // planet in the draw list whenever the camera looks along the surface.
    const cosAngle = Math.max(-1, Math.min(1, this.tmpDir.dot(node.dir)));
    const angle = Math.acos(cosAngle);
    const visible = angle < horizonAngle + node.angularRadius + ELEVATION_HORIZON;

    node.mesh.visible = visible;
    if (visible) {
      this.stats.visiblePatches++;
      this.stats.triangles += this.triangleCount;
      if (node.level > this.stats.deepestLevel) this.stats.deepestLevel = node.level;
    }
    void camPos;
  }

  private hide(node: PatchNode): void {
    if (node.mesh) node.mesh.visible = false;
  }

  // --- Worker dispatch ----------------------------------------------------

  private dispatch(camPos: THREE.Vector3): void {
    const capacity = this.workers.length * 3 - this.inFlight.size;
    if (capacity <= 0 || this.queue.length === 0) return;

    // Nearest first: the patches the player is looking at should resolve before
    // the ones behind them.
    this.queue.sort(
      (a, b) => a.center.distanceToSquared(camPos) - b.center.distanceToSquared(camPos),
    );

    const n = Math.min(capacity, this.queue.length);
    for (let i = 0; i < n; i++) {
      const node = this.queue[i];
      const id = this.nextRequestId++;
      node.requestId = id;
      node.pending = true;
      this.inFlight.set(id, node);

      // Least-loaded worker, so one slow patch cannot stall a whole queue.
      let best = 0;
      for (let w = 1; w < this.workerLoad.length; w++) {
        if (this.workerLoad[w] < this.workerLoad[best]) best = w;
      }
      this.workerLoad[best]++;

      const msg: PatchRequestMessage = {
        type: 'patch',
        id,
        face: node.face,
        level: node.level,
        u0: node.u0,
        v0: node.v0,
        size: node.size,
        grid: this.grid,
      };
      this.workers[best].postMessage(msg);
    }
  }

  private onPatch(workerIndex: number, result: PatchResultMessage): void {
    this.workerLoad[workerIndex] = Math.max(0, this.workerLoad[workerIndex] - 1);

    const node = this.inFlight.get(result.id);
    this.inFlight.delete(result.id);
    // The node may have been collapsed while its patch was in flight.
    if (!node) return;

    node.pending = false;
    const mesh = this.acquire();
    const geom = mesh.geometry;

    (geom.getAttribute('position') as THREE.BufferAttribute).copyArray(result.positions);
    (geom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geom.getAttribute('normal') as THREE.BufferAttribute).copyArray(result.normals);
    (geom.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
    (geom.getAttribute('aData') as THREE.BufferAttribute).copyArray(result.data);
    (geom.getAttribute('aData') as THREE.BufferAttribute).needsUpdate = true;

    mesh.position.set(result.center[0], result.center[1], result.center[2]);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);

    if (!geom.boundingSphere) geom.boundingSphere = new THREE.Sphere();
    geom.boundingSphere.center.set(0, 0, 0);
    geom.boundingSphere.radius = result.boundRadius;

    node.center.set(result.center[0], result.center[1], result.center[2]);
    node.boundRadius = result.boundRadius;
    node.mesh = mesh;
    mesh.visible = false;
    this.group.add(mesh);
  }

  // --- Mesh pool ----------------------------------------------------------

  private acquire(): THREE.Mesh {
    const pooled = this.meshPool.pop();
    if (pooled) return pooled;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(this.vertexCount * 3), 3),
    );
    geom.setAttribute(
      'normal',
      new THREE.BufferAttribute(new Float32Array(this.vertexCount * 3), 3),
    );
    geom.setAttribute(
      'aData',
      new THREE.BufferAttribute(new Float32Array(this.vertexCount * 3), 3),
    );
    geom.setIndex(this.index.clone());
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);

    const mesh = new THREE.Mesh(geom, this.material);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = true;
    return mesh;
  }

  private release(mesh: THREE.Mesh): void {
    this.group.remove(mesh);
    mesh.visible = false;
    this.meshPool.push(mesh);
  }

  /**
   * Forget the adaptive error budget.
   *
   * The budget is an estimate of how much geometry the current view costs, and
   * a teleport invalidates it: jumping from a low pass over a mountain range to
   * an orbital view would otherwise arrive carrying the mountain range's
   * pessimism and render the planet coarse for a second or two.
   */
  resetBudget(): void {
    this.errorScale = 1;
  }

  getStats(): Readonly<TerrainStats> {
    return this.stats;
  }

  /** True once every root patch has arrived, so the planet is never seen half-built. */
  isReady(): boolean {
    return this.roots.every((r) => r.mesh !== null);
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    for (const root of this.roots) {
      this.collapse(root);
      if (root.mesh) this.release(root.mesh);
    }
    for (const mesh of this.meshPool) mesh.geometry.dispose();
    this.meshPool.length = 0;
    this.group.clear();
  }
}
