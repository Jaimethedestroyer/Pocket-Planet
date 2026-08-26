/**
 * Application root: owns the renderer, the planet and the frame loop.
 */

import * as THREE from 'three';
import { PLANET_RADIUS, QUALITY, detectQuality } from './planet/config';
import type { QualityTier } from './planet/config';
import { PlanetField } from './planet/heightfield';
import { TerrainSystem } from './planet/terrainSystem';
import { Environment } from './render/environment';
import { CameraRig } from './render/cameraRig';
import { createTerrainMaterial, updateTerrainDetail } from './render/materials/terrain';
import { RenderPipeline } from './render/post/pipeline';
import { SettlementLayer } from './render/settlements';
import { GroundDetail } from './render/ground/detail';
import { spritesReady } from './render/ground/sheets';
import { SimClient } from './game/simClient';
import { PERSIST_BY_DEFAULT } from './game/save';
import { hashSeed } from './core/rng';

export interface AppOptions {
  canvas: HTMLCanvasElement;
  seed?: string;
  /** Simulation cells. Never drawn; see src/sim/world.ts. */
  cellCount?: number;
  /** Years of history per real second. */
  speed?: number;
  quality?: QualityTier;
  /** Extra multiplier on the internal render resolution. */
  renderScale?: number;
  /** Override the quality tier's screen-space error budget, in pixels. */
  pixelError?: number;
  /** Override bloom strength. Zero disables it. */
  bloom?: number;
  /** Cloud coverage, 0 clear to 1 overcast. */
  clouds?: number;
  /** Multiplier on how far ground detail is built. Zero switches it off. */
  detail?: number;
  /**
   * Whether this session continues the stored world or starts a new one.
   * Defaults to save.ts's PERSIST_BY_DEFAULT.
   */
  persist?: boolean;
}

export interface ViewState {
  /** Latitude in degrees. */
  lat?: number;
  /** Longitude in degrees. */
  lon?: number;
  /** Altitude above the terrain, in metres. */
  altitude?: number;
  /** Compass heading in degrees. */
  heading?: number;
  /** Sun angle in degrees; fixes the day/night cycle in place. */
  sun?: number;
  /**
   * Extra tilt in radians on top of the automatic altitude-driven tilt.
   *
   * Negative levels the camera back towards straight down. That matters more
   * than it sounds for anything aimed at a *place*: the rig looks along its
   * heading from above the target, so by the time the automatic tilt has opened
   * out past half the field of view — which it has by a couple of hundred
   * metres up — the thing you asked to look at is below the bottom of the
   * frame, underneath you rather than in front of you.
   */
  tilt?: number;
  /**
   * Put the given lat/lon in the middle of the frame rather than under the
   * camera. See CameraRig.framedTarget — anything aimed at a *place* wants
   * this; a shot of a landscape does not care.
   */
  frame?: boolean;
  autoRotate?: boolean;
}

export class PocketPlanetApp {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly environment = new Environment();
  readonly field: PlanetField;
  readonly rig: CameraRig;
  readonly terrain: TerrainSystem;
  readonly pipeline: RenderPipeline;
  readonly sim: SimClient;
  readonly settlements: SettlementLayer;
  readonly ground: GroundDetail;

  readonly seed: number;
  private quality = QUALITY.high;
  private terrainMaterial: THREE.ShaderMaterial;
  private clock = new THREE.Clock();
  private detachInput: () => void;
  private running = false;
  private frameHandle = 0;

  /** Rolling frame time average, in milliseconds. */
  private frameMs = 16;
  private fps = 60;

  constructor(opts: AppOptions) {
    this.seed = hashSeed(opts.seed ?? 'pocket-planet');
    this.quality = QUALITY[opts.quality ?? detectQuality()];

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      // The composite pass needs a depth texture, so the default framebuffer
      // is only ever cleared, never read.
      stencil: false,
      alpha: false,
    });
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio) *
        this.quality.renderScale *
        (opts.renderScale ?? 1),
    );
    // Tone mapping and colour space conversion both happen in the final post
    // pass, so the renderer itself must leave the values alone.
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.autoClear = false;
    // Statistics must survive the whole multi-pass frame, not reset on each
    // render target switch, or the draw-call count only reports the last pass.
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / window.innerHeight,
      1,
      PLANET_RADIUS * 8,
    );

    this.field = new PlanetField(this.seed);
    this.rig = new CameraRig(this.field);

    this.terrainMaterial = createTerrainMaterial(this.environment.uniforms);
    this.terrain = new TerrainSystem({
      seed: this.seed,
      radius: PLANET_RADIUS,
      grid: this.quality.patchGrid,
      maxLevel: this.quality.maxLodLevel,
      pixelError: opts.pixelError ?? this.quality.pixelError,
      patchBudget: this.quality.patchBudget,
      material: this.terrainMaterial,
    });
    this.scene.add(this.terrain.group);

    this.pipeline = new RenderPipeline(
      this.renderer,
      this.environment.uniforms,
      this.quality,
    );

    if (opts.bloom !== undefined) this.pipeline.setBloom(opts.bloom);
    this.defaultClouds = this.pipeline.atmosphere.uCloudCoverage.value as number;
    if (opts.clouds !== undefined) this.setClouds(opts.clouds);

    // The simulation runs in its own worker on its own clock, so history
    // advances at the same rate whether the renderer is managing 60 fps or 20.
    this.sim = new SimClient(
      opts.seed ?? 'pocket-planet',
      opts.cellCount ?? 4096,
      3,
      opts.persist ?? PERSIST_BY_DEFAULT,
    );
    this.terrainMaterial.uniforms.tTerritory.value = this.sim.territoryTexture;

    this.settlements = new SettlementLayer(this.environment.uniforms);
    this.scene.add(this.settlements.mesh);

    // Ground detail: the buildings, roads, fields and people that the marker
    // above stands in for from any distance. Its ranges scale with the quality
    // tier, because it is the first thing worth giving up on a slow phone.
    this.ground = new GroundDetail(this.environment.uniforms, this.field, this.seed);
    this.ground.setRangeScale(opts.detail ?? this.quality.detailRange);
    this.scene.add(this.ground.group);

    this.sim.onReady = () => {
      if (this.sim.cellPositions && this.sim.cellHeights) {
        this.settlements.setCellData(this.sim.cellPositions, this.sim.cellHeights);
        this.ground.setCellData(this.sim.cellPositions);
      }
      this.sim.setSpeed(opts.speed ?? 4);
    };
    this.sim.onState = () => {
      this.settlements.update(this.sim.settlements, this.sim.polityHues());
    };

    this.detachInput = this.rig.attach(opts.canvas);
    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  /**
   * Pixels per unit of world size at unit distance. The LOD system needs this
   * to express its error budget in pixels rather than metres.
   */
  private projScale(): number {
    const height = this.renderer.domElement.height;
    return height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5));
  }

  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    // Render targets follow the drawing buffer, not the CSS size, so that the
    // pixel ratio and the quality tier's render scale both take effect.
    const buffer = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(buffer);
    this.pipeline?.setSize(buffer.x, buffer.y);
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const tick = (): void => {
      if (!this.running) return;
      this.frameHandle = requestAnimationFrame(tick);
      this.frame();
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  /** Advance and render exactly one frame. Used by the screenshot tool. */
  frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.renderer.info.reset();

    this.rig.update(dt, this.camera);
    this.environment.update(dt, this.camera);
    updateTerrainDetail(this.terrainMaterial, this.rig.altitude, this.projScale());

    this.camera.updateMatrixWorld();
    this.terrain.update(this.camera.position, this.projScale());
    this.settlements.setProjScale(this.projScale());
    this.ground.update(
      this.camera,
      this.sim.settlements,
      this.sim.polities,
      this.sim.ruins,
      this.sim.wonders,
    );

    this.pipeline.camAltitude = this.rig.altitude;
    this.pipeline.render(this.scene, this.camera);

    const ms = dt * 1000;
    this.frameMs += (ms - this.frameMs) * 0.1;
    this.fps = 1000 / Math.max(this.frameMs, 0.001);
  }

  // --- Introspection, used by the HUD and the screenshot tool --------------

  getStats(): Record<string, number> {
    const t = this.terrain.getStats();
    const g = this.ground.getStats();
    return {
      ...g,
      fps: this.fps,
      altitude: this.rig.altitude,
      visiblePatches: t.visiblePatches,
      liveNodes: t.liveNodes,
      triangles: t.triangles,
      deepestLevel: t.deepestLevel,
      pending: t.pending,
      queued: t.queued,
      drawCalls: this.renderer.info.render.calls,
      year: this.sim.tick,
      population: this.sim.totalPopulation,
      states: this.sim.livingPolities,
      settlements: this.sim.settlements.length,
    };
  }

  /** True when the LOD system has nothing left to build for the current view. */
  /**
   * Cloud coverage, or the world's own value when given null.
   *
   * Exposed for the screenshot harness, which needs one viewpoint clear while
   * the rest keep their weather: the shot that shows the road network between
   * towns is unreadable under cloud shadow, and turning the sky off for the
   * whole run would change every other reference image.
   */
  setClouds(coverage: number | null): void {
    this.pipeline.setCloudCoverage(coverage ?? this.defaultClouds);
  }

  private defaultClouds = 0;

  isSettled(): boolean {
    const t = this.terrain.getStats();
    // The sprite sheets count. They are the trees and the people, they arrive
    // in a few milliseconds over the same connection the page came down, and
    // waiting on them here is what stops the world being revealed bare and then
    // furnishing itself. `spritesReady` gives up on a sheet that failed rather
    // than holding the boot screen open for good.
    return this.terrain.isReady() && t.pending === 0 && t.queued === 0 && spritesReady();
  }

  setView(view: ViewState): void {
    // A jump is not motion: whatever the LOD system learned about the cost of
    // the last viewpoint says nothing about this one.
    this.terrain.resetBudget();

    let aimed: THREE.Vector3 | null = null;
    if (view.lat !== undefined || view.lon !== undefined) {
      const lat = THREE.MathUtils.degToRad(view.lat ?? 0);
      const lon = THREE.MathUtils.degToRad(view.lon ?? 0);
      const c = Math.cos(lat);
      aimed = new THREE.Vector3(c * Math.cos(lon), Math.sin(lat), c * Math.sin(lon));
      this.rig.target.copy(aimed);
    }
    this.rig.stopMomentum();

    if (view.altitude !== undefined) {
      this.rig.altitude = view.altitude;
      this.rig.zoom(0);
      // Snap rather than easing, so a screenshot does not catch a transition.
      (this.rig as unknown as { targetAltitude: number }).targetAltitude = view.altitude;
    }
    if (view.heading !== undefined) {
      const h = THREE.MathUtils.degToRad(view.heading);
      this.rig.heading = h;
      this.rig.setHeading(h);
    }
    if (view.tilt !== undefined) {
      this.rig.tiltOffset = view.tilt;
    }
    if (view.sun !== undefined) {
      this.environment.setSunAngle(THREE.MathUtils.degToRad(view.sun));
      this.environment.dayLength = Infinity;
    }
    if (view.autoRotate !== undefined) {
      this.rig.autoRotate = view.autoRotate;
    }

    // Last, because it needs the altitude, the heading and the tilt to have
    // been applied already — the offset it computes depends on all three.
    if (view.frame && aimed) this.rig.frameOn(aimed, this.rig.altitude);
  }

  dispose(): void {
    this.stop();
    this.detachInput();
    window.removeEventListener('resize', this.onResize);
    this.terrain.dispose();
    this.settlements.dispose();
    this.ground.dispose();
    this.sim.dispose();
    this.pipeline.dispose();
    this.terrainMaterial.dispose();
    this.renderer.dispose();
  }
}
