/**
 * Ground shadows for buildings.
 *
 * Not a shadow map. A shadow map for this would mean a second depth pass over
 * the terrain at a resolution fine enough to resolve a doorway, on a planet
 * where the visible ground spans four orders of magnitude of scale — and the
 * whole thing would exist to darken a few hundred square metres around each
 * town. The cost is in completely the wrong place.
 *
 * Instead each building projects a single quad: its footprint, sheared along
 * the ground away from the sun by height / tan(elevation), soft at the far end
 * and along the sides. It is geometrically a lie — the silhouette of a gabled
 * roof is not a parallelogram — and at the sizes involved nobody can tell,
 * because what the eye is actually reading is *contact*: which way the light
 * comes from, and that the building is standing on the ground rather than
 * floating a little above it.
 *
 * The shear is computed in the vertex shader from the sun direction, so the
 * shadows sweep round as the day passes with no CPU work at all. That is the
 * other half of why this is worth having: on a planet with a four-minute day,
 * static shadows would be worse than none.
 */

import * as THREE from 'three';
import type { SharedUniforms } from '../environment';
import type { Model } from './kit';

const vertexShader = /* glsl */ `
attribute float aTip;
attribute float aHeight;
attribute float aEdge;

attribute vec3 iOrigin;
attribute float iRot;
attribute vec3 iScale;

uniform vec3 uSunDir;
uniform float uFadeNear;
uniform float uFadeFar;

varying float vEdge;
varying float vTip;
varying float vFade;

void main() {
  vec3 up = normalize(iOrigin);
  vec3 ref = abs(up.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 east = normalize(cross(ref, up));
  vec3 north = cross(up, east);

  float c = cos(iRot);
  float s = sin(iRot);
  vec3 right = -(east * c + north * s);
  vec3 fwd = -east * s + north * c;

  float dist = length(cameraPosition - iOrigin);
  float grow = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);

  // The sun's direction along the ground, and how high it stands.
  float elevation = dot(uSunDir, up);
  vec3 sunFlat = uSunDir - up * elevation;
  float flatLen = length(sunFlat);

  vec3 local = position * iScale * vec3(grow, 1.0, grow);
  vec3 world = iOrigin + right * local.x + fwd * local.z;

  // Shadow length. Clamped hard: as the sun touches the horizon the true
  // length goes to infinity, and a shadow stretching to the next valley is a
  // worse lie than a short one.
  float lengthen = 0.0;
  if (aTip > 0.5 && flatLen > 1e-4) {
    float reach = aHeight * iScale.y * min(flatLen / max(elevation, 0.18), 3.2);
    world -= (sunFlat / flatLen) * reach * grow;
    lengthen = 1.0;
  }

  // Sit just off the ground, by about a pixel at any distance — the same
  // trick the roads use, and for the same reason.
  world += up * (0.06 + dist * 0.0009);

  vEdge = aEdge;
  vTip = lengthen;
  // Gone entirely once the sun is below the horizon; there is nothing to cast.
  vFade = grow * smoothstep(0.0, 0.16, elevation);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

uniform float uStrength;

varying float vEdge;
varying float vTip;
varying float vFade;

void main() {
  // Soft along the sides, softer still at the far end: a real shadow's
  // penumbra widens with distance from whatever cast it.
  float alpha = vEdge * mix(1.0, 0.35, vTip) * vFade * uStrength;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
}
`;

interface Pool {
  geometry: THREE.InstancedBufferGeometry;
  mesh: THREE.Mesh;
}

/**
 * One shadow pool per archetype, sharing the building layer's instance buffers.
 *
 * Sharing is the whole point: the shadow needs the same origin, rotation and
 * scale as the building, and duplicating those would double the upload cost of
 * every town for no information gain.
 */
export class ShadowLayer {
  readonly group = new THREE.Group();

  private material: THREE.ShaderMaterial;
  private pools = new Map<string, Pool>();

  constructor(shared: SharedUniforms) {
    this.material = new THREE.ShaderMaterial({
      name: 'building-shadows',
      vertexShader,
      fragmentShader,
      uniforms: {
        uSunDir: shared.uSunDir,
        uStrength: { value: 0.42 },
        uFadeNear: { value: 620 },
        uFadeFar: { value: 1100 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.group.name = 'building-shadows';
    // Between the roads and the buildings: a shadow falls on the road.
    this.group.renderOrder = 3;
  }

  /**
   * The shadow quad for one archetype.
   *
   * Six vertices, not four: the footprint's two down-sun corners are shared
   * between the footprint quad and the sheared tail, so the two stay joined
   * however far the tail stretches.
   */
  private quadFor(model: Model): THREE.BufferGeometry {
    const w = model.width * 0.46;
    const d = model.depth * 0.46;
    const geometry = new THREE.BufferGeometry();

    // A ring of eight: the footprint corners with a soft margin outside them.
    const position: number[] = [];
    const tip: number[] = [];
    const edge: number[] = [];
    const height: number[] = [];
    const index: number[] = [];

    const push = (x: number, z: number, isTip: number, e: number): number => {
      const i = position.length / 3;
      position.push(x, 0, z);
      tip.push(isTip);
      edge.push(e);
      height.push(model.height);
      return i;
    };

    // Inner footprint quad, fully opaque, plus a fading skirt around it.
    const margin = 0.55;
    const inner = [
      push(-w, -d, 0, 1),
      push(w, -d, 0, 1),
      push(w, d, 1, 1),
      push(-w, d, 1, 1),
    ];
    const outer = [
      push(-w - margin, -d - margin, 0, 0),
      push(w + margin, -d - margin, 0, 0),
      push(w + margin, d + margin, 1, 0),
      push(-w - margin, d + margin, 1, 0),
    ];

    index.push(inner[0], inner[1], inner[2], inner[0], inner[2], inner[3]);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      index.push(inner[i], outer[i], outer[j], inner[i], outer[j], inner[j]);
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute('aTip', new THREE.Float32BufferAttribute(tip, 1));
    geometry.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
    geometry.setAttribute('aHeight', new THREE.Float32BufferAttribute(height, 1));
    geometry.setIndex(index);
    return geometry;
  }

  /**
   * Attach a shadow to an archetype's instance buffers.
   *
   * Called once per archetype, the first time it is drawn. The attributes are
   * the building layer's own objects, so nothing has to be kept in step.
   */
  attach(
    name: string,
    model: Model,
    attributes: {
      origin: THREE.InstancedBufferAttribute;
      rot: THREE.InstancedBufferAttribute;
      scale: THREE.InstancedBufferAttribute;
    },
  ): void {
    let pool = this.pools.get(name);
    if (!pool) {
      const geometry = new THREE.InstancedBufferGeometry();
      const quad = this.quadFor(model);
      geometry.index = quad.index;
      for (const key of ['position', 'aTip', 'aEdge', 'aHeight']) {
        geometry.setAttribute(key, quad.getAttribute(key));
      }
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
      geometry.instanceCount = 0;
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.frustumCulled = false;
      mesh.name = `shadow:${name}`;
      mesh.renderOrder = 3;
      this.group.add(mesh);
      pool = { geometry, mesh };
      this.pools.set(name, pool);
    }
    // Re-bound every time, because the building layer replaces its attribute
    // objects wholesale when a pool grows.
    pool.geometry.setAttribute('iOrigin', attributes.origin);
    pool.geometry.setAttribute('iRot', attributes.rot);
    pool.geometry.setAttribute('iScale', attributes.scale);
  }

  setCount(name: string, count: number): void {
    const pool = this.pools.get(name);
    if (!pool) return;
    pool.geometry.instanceCount = count;
    pool.mesh.visible = count > 0;
  }

  setRange(near: number, far: number): void {
    this.material.uniforms.uFadeNear.value = near;
    this.material.uniforms.uFadeFar.value = far;
  }

  setStrength(value: number): void {
    this.material.uniforms.uStrength.value = value;
  }

  dispose(): void {
    for (const pool of this.pools.values()) pool.geometry.dispose();
    this.pools.clear();
    this.material.dispose();
  }
}
