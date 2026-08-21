/**
 * Planet camera.
 *
 * The camera always sits above a point on the sphere, so "where am I looking"
 * is a direction and an altitude rather than a free-floating transform. That
 * keeps every control gesture meaningful at both ends of a zoom range that
 * spans four orders of magnitude, and it makes the near and far planes easy to
 * choose per frame — which is what removes the need for a logarithmic depth
 * buffer entirely.
 */

import * as THREE from 'three';
import {
  MAX_ALTITUDE,
  MIN_ALTITUDE,
  PLANET_RADIUS,
} from '../planet/config';
import type { PlanetField } from '../planet/heightfield';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  /** Unit direction of the surface point the camera is above. */
  readonly target = new THREE.Vector3(0.35, 0.42, 0.84).normalize();

  /** Altitude above the terrain directly below, in world units. */
  altitude = PLANET_RADIUS * 2.4;

  /** Compass rotation of the view, in radians. */
  heading = 0;

  /** Extra tilt applied on top of the automatic altitude-driven tilt. */
  tiltOffset = 0;

  /** Set false to stop the idle drift, e.g. while the user is dragging. */
  autoRotate = true;
  autoRotateSpeed = 0.012;

  private field: PlanetField;
  private groundHeight = 0;

  private targetAltitude = this.altitude;
  private targetHeading = 0;
  private velocity = new THREE.Vector2();

  private up = new THREE.Vector3();
  private east = new THREE.Vector3();
  private north = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private quat = new THREE.Quaternion();

  constructor(field: PlanetField) {
    this.field = field;
    this.targetAltitude = this.altitude;
  }

  /** Distance from the planet centre. */
  get distance(): number {
    return PLANET_RADIUS + this.groundHeight + this.altitude;
  }

  /**
   * Automatic tilt: looking straight down from orbit, swinging towards the
   * horizon as the camera descends. This is what makes the last part of a zoom
   * feel like arriving somewhere rather than falling onto a map.
   */
  private get tilt(): number {
    const t = THREE.MathUtils.smoothstep(this.altitude, 12, PLANET_RADIUS * 0.55);
    return THREE.MathUtils.clamp((1 - t) * 1.18 + this.tiltOffset, 0, 1.45);
  }

  /** Rotate the view target across the surface. Units are radians. */
  orbit(deltaEast: number, deltaNorth: number): void {
    this.buildBasis();
    // Move along the current heading's frame so dragging feels the same
    // whichever way the camera is facing.
    this.tmp.copy(this.east).multiplyScalar(deltaEast);
    this.tmp.addScaledVector(this.north, deltaNorth);
    this.target.addScaledVector(this.tmp, 1).normalize();
  }

  /** Drag in screen pixels. Sensitivity scales with altitude. */
  drag(dxPixels: number, dyPixels: number): void {
    const radPerPixel = (this.altitude * 0.0022 + PLANET_RADIUS * 0.0009) / PLANET_RADIUS;
    const cos = Math.cos(this.heading);
    const sin = Math.sin(this.heading);
    const dx = -dxPixels * radPerPixel;
    const dy = dyPixels * radPerPixel;
    this.orbit(dx * cos - dy * sin, dy * cos + dx * sin);
  }

  /** Positive zooms out, negative zooms in. */
  zoom(delta: number): void {
    this.targetAltitude = THREE.MathUtils.clamp(
      this.targetAltitude * Math.exp(delta),
      MIN_ALTITUDE,
      MAX_ALTITUDE,
    );
  }

  setHeading(radians: number): void {
    this.targetHeading = radians;
  }

  private buildBasis(): void {
    this.up.copy(this.target);
    // Near the poles the world up axis degenerates; fall back to a fixed axis.
    if (Math.abs(this.up.y) > 0.9995) {
      this.east.set(1, 0, 0);
    } else {
      this.east.crossVectors(WORLD_UP, this.up).normalize();
    }
    this.north.crossVectors(this.up, this.east).normalize();
  }

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    if (this.autoRotate) {
      this.drag(this.autoRotateSpeed * dt * 60, 0);
    }

    // Critically-damped-ish smoothing on altitude and heading.
    const k = 1 - Math.exp(-dt * 7);
    this.altitude += (this.targetAltitude - this.altitude) * k;
    this.heading += (this.targetHeading - this.heading) * k;

    // Terrain height under the camera, sampled finely enough that flying low
    // over a ridge does not clip through it.
    this.groundHeight = this.field.height(
      this.target.x,
      this.target.y,
      this.target.z,
      Math.max(0.4, this.altitude * 0.02),
    );
    if (this.groundHeight < 0) this.groundHeight = 0;

    this.buildBasis();

    const dist = this.distance;
    camera.position.copy(this.target).multiplyScalar(dist);

    // Look direction: straight down, rotated towards the heading by the tilt.
    this.forward.copy(this.north).multiplyScalar(Math.cos(this.heading));
    this.forward.addScaledVector(this.east, Math.sin(this.heading));

    const tilt = this.tilt;
    this.lookAt
      .copy(this.up)
      .multiplyScalar(-Math.cos(tilt))
      .addScaledVector(this.forward, Math.sin(tilt));

    camera.up.copy(this.up);
    this.tmp.copy(camera.position).add(this.lookAt);
    camera.lookAt(this.tmp);

    // Per-frame depth range. Near tracks altitude so that centimetre detail
    // resolves on the ground, far always reaches past the planet's far limb.
    camera.near = THREE.MathUtils.clamp(this.altitude * 0.02, 0.05, 60);
    camera.far = dist + PLANET_RADIUS * 2.4;
    camera.updateProjectionMatrix();

    void this.quat;
    void this.velocity;
  }

  /** Wire up pointer, wheel and touch input on a canvas. */
  attach(element: HTMLElement): () => void {
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDistance = 0;

    const onPointerDown = (e: PointerEvent) => {
      element.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.autoRotate = false;
      if (pointers.size === 2) pinchDistance = currentPinch();
    };

    const currentPinch = (): number => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    const onPointerMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      prev.x = e.clientX;
      prev.y = e.clientY;

      if (pointers.size === 1) {
        this.drag(dx, dy);
      } else if (pointers.size === 2) {
        const d = currentPinch();
        if (pinchDistance > 0) this.zoom(-(d - pinchDistance) * 0.006);
        pinchDistance = d;
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDistance = 0;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.autoRotate = false;
      this.zoom(e.deltaY * 0.0012);
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
    element.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      element.removeEventListener('wheel', onWheel);
    };
  }
}
