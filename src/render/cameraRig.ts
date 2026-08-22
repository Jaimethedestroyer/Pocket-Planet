/**
 * Planet camera.
 *
 * The camera always sits above a point on the sphere, so "where am I looking"
 * is a direction and an altitude rather than a free-floating transform. That
 * keeps every gesture meaningful across a zoom range spanning four orders of
 * magnitude, and it makes the near and far planes easy to choose per frame —
 * which is what removes the need for a logarithmic depth buffer entirely.
 *
 * Dragging is a true arcball: the ray under the pointer is intersected with the
 * planet, and the world is rotated so the point you grabbed stays under your
 * finger. There is no sensitivity constant anywhere, because there is nothing
 * to tune — the geometry already knows how far the planet should turn.
 *
 * The first version instead nudged the target by a tangent vector scaled by
 * altitude and renormalised it. That is not a rotation: it saturates, it does
 * not commute, and its one tuning constant meant a single drag at maximum zoom
 * spun the planet through roughly 190 degrees. Zoomed in it felt fine, which is
 * exactly why it survived as long as it did.
 */

import * as THREE from 'three';
import { MAX_ALTITUDE, MIN_ALTITUDE, PLANET_RADIUS } from '../planet/config';
import type { PlanetField } from '../planet/heightfield';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Quaternion();

/**
 * Most the planet may turn from one pointer event to the next.
 *
 * Near the horizon at ground level, the view ray meets the surface at a very
 * shallow angle, so a few pixels of pointer movement can legitimately span
 * kilometres. Honouring that exactly is correct and unusable; this bounds it
 * without affecting any normal gesture.
 */
const MAX_STEP_RADIANS = 0.22;

/** Angular speed below which flick momentum is considered stopped. */
const MOMENTUM_CUTOFF = 0.0015;

export class CameraRig {
  /** Unit direction of the surface point the camera is above. */
  readonly target = new THREE.Vector3(0.35, 0.42, 0.84).normalize();

  /**
   * A tangent vector at `target` pointing along the view's north.
   *
   * Carried and rotated with the target rather than rebuilt from the world
   * axis each frame. Deriving it from a fixed axis needs a special case at the
   * poles, and that special case is a visible snap the moment you drag across
   * one.
   */
  private north = new THREE.Vector3();

  /** Altitude above the terrain directly below, in world units. */
  altitude = PLANET_RADIUS * 2.4;

  /** Compass rotation of the view, in radians. */
  heading = 0;

  /** Extra tilt applied on top of the automatic altitude-driven tilt. */
  tiltOffset = 0;

  /** Set false to stop the idle drift, e.g. while the user is dragging. */
  autoRotate = true;
  autoRotateSpeed = 0.05;

  private field: PlanetField;
  private groundHeight = 0;

  private targetAltitude = this.altitude;
  private targetHeading = 0;

  /**
   * Flick momentum: an axis and an angular speed in radians per second.
   *
   * Only ever applied once the pointer is up. Coasting while a drag is still in
   * progress adds the gesture to itself — the planet turns about twice as far
   * as the finger asked for, which reads as the camera being oversensitive
   * rather than as momentum, because it tracks the drag exactly.
   */
  private spinAxis = new THREE.Vector3(0, 1, 0);
  private spinSpeed = 0;
  private dragging = false;

  private up = new THREE.Vector3();
  private east = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private screenUp = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private quat = new THREE.Quaternion();
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private pickA = new THREE.Vector3();
  private pickB = new THREE.Vector3();

  private camera: THREE.PerspectiveCamera | null = null;
  private element: HTMLElement | null = null;

  constructor(field: PlanetField) {
    this.field = field;
    this.targetAltitude = this.altitude;
    // Any tangent will do as a starting north; it is only ever rotated after.
    this.north.crossVectors(WORLD_UP, this.target).cross(this.target).normalize();
    if (this.north.lengthSq() < 0.5) this.north.set(1, 0, 0);
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

  /**
   * Where a screen position lands on the planet.
   *
   * Returns true for a real hit. When the ray misses — the pointer is off the
   * planet's disc — it falls back to the nearest point on the sphere to the
   * ray, which is the silhouette. That keeps a drag that wanders past the limb
   * continuous instead of stopping dead at the edge.
   */
  private pickSphere(clientX: number, clientY: number, out: THREE.Vector3): boolean {
    const camera = this.camera;
    const element = this.element;
    if (!camera || !element) return false;

    const rect = element.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, camera);

    const origin = this.raycaster.ray.origin;
    const dir = this.raycaster.ray.direction;
    // Pick against the ground the camera is actually over, not sea level, so a
    // drag tracks the terrain when you are close to it.
    const radius = PLANET_RADIUS + Math.max(0, this.groundHeight);

    const b = origin.dot(dir);
    const c = origin.lengthSq() - radius * radius;
    const disc = b * b - c;
    if (disc > 0) {
      const t = -b - Math.sqrt(disc);
      if (t > 0) {
        out.copy(dir).multiplyScalar(t).add(origin).normalize();
        return true;
      }
    }
    // Closest approach to the centre: the silhouette point.
    out.copy(dir).multiplyScalar(-b).add(origin).normalize();
    return false;
  }

  /**
   * The point on the planet under a screen position, or null if the pointer is
   * off the planet's disc. Used by the drag handling, and by anything that
   * wants to know what the player just tapped.
   */
  pickWorld(clientX: number, clientY: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    return this.pickSphere(clientX, clientY, out) ? out : null;
  }

  /** Rotate the whole view frame, keeping target and north orthonormal. */
  private rotateFrame(q: THREE.Quaternion): void {
    this.target.applyQuaternion(q).normalize();
    this.north.applyQuaternion(q);
    this.north.addScaledVector(this.target, -this.north.dot(this.target)).normalize();
  }

  /** Turn the planet about an axis through its centre. */
  spin(axis: THREE.Vector3, radians: number): void {
    if (Math.abs(radians) < 1e-7) return;
    this.quat.setFromAxisAngle(axis, radians);
    this.rotateFrame(this.quat);
  }

  /**
   * Drag between two screen positions.
   *
   * Both ends are re-picked against the current camera, so the rotation is
   * whatever actually takes the point under the old position to the point under
   * the new one — no pixels-to-radians constant, and correct at every zoom.
   */
  private dragBetween(fromX: number, fromY: number, toX: number, toY: number, dt: number): void {
    this.pickSphere(fromX, fromY, this.pickA);
    this.pickSphere(toX, toY, this.pickB);

    // Rotate the grabbed point back under the pointer.
    this.quat.setFromUnitVectors(this.pickB, this.pickA);

    let angle = 2 * Math.acos(THREE.MathUtils.clamp(this.quat.w, -1, 1));
    if (angle > Math.PI) angle -= Math.PI * 2;
    if (Math.abs(angle) < 1e-7) return;

    if (Math.abs(angle) > MAX_STEP_RADIANS) {
      this.quat.slerp(IDENTITY, 1 - MAX_STEP_RADIANS / Math.abs(angle));
      angle = Math.sign(angle) * MAX_STEP_RADIANS;
    }

    this.rotateFrame(this.quat);
    // Re-place the camera immediately. A pointer can deliver a dozen moves
    // between two frames, and if each one picks against a camera that has not
    // moved yet, every rotation is computed from the same stale view and they
    // compound instead of composing.
    this.syncCamera();

    // Remember the gesture so releasing mid-drag can coast.
    if (dt > 1e-4) {
      this.spinAxis.set(this.quat.x, this.quat.y, this.quat.z);
      if (this.spinAxis.lengthSq() > 1e-12) {
        this.spinAxis.normalize();
        this.spinSpeed = angle / dt;
      }
    }
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

  /** Stop any coasting, e.g. when the view is set programmatically. */
  stopMomentum(): void {
    this.spinSpeed = 0;
  }

  /**
   * Ease the view to a point on the planet, optionally changing altitude.
   *
   * A rotation, not a translation: the flight is a slerp of the target
   * direction, so it takes the great-circle route and arrives with the same
   * bearing whichever side of the planet it started on. Interpolating the
   * target's components instead would cut through the planet, and the halfway
   * point of the flight would be somewhere under the crust.
   */
  flyTo(direction: THREE.Vector3, altitude?: number): void {
    this.flightFrom.copy(this.target).normalize();
    this.flightTo.copy(direction).normalize();
    const angle = Math.acos(THREE.MathUtils.clamp(this.flightFrom.dot(this.flightTo), -1, 1));
    if (angle < 1e-3 && altitude === undefined) return;

    // Long trips take longer, but sub-linearly: crossing the planet should feel
    // like a journey, not like waiting.
    this.flightDuration = THREE.MathUtils.clamp(0.55 + Math.sqrt(angle) * 0.9, 0.5, 2.0);
    this.flightTime = 0;
    this.flying = true;
    this.autoRotate = false;
    this.spinSpeed = 0;
    if (altitude !== undefined) {
      this.targetAltitude = THREE.MathUtils.clamp(altitude, MIN_ALTITUDE, MAX_ALTITUDE);
    }
  }

  /** True while a flight is in progress. */
  get inFlight(): boolean {
    return this.flying;
  }

  private flying = false;
  private flightTime = 0;
  private flightDuration = 1;
  private flightFrom = new THREE.Vector3();
  private flightTo = new THREE.Vector3();
  private flightAxis = new THREE.Vector3();

  private advanceFlight(dt: number): void {
    this.flightTime += dt;
    const t = Math.min(1, this.flightTime / this.flightDuration);
    // Ease in and out. A flight that starts and stops abruptly reads as a cut.
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    this.tmp.copy(this.flightFrom).lerp(this.flightTo, e);
    if (this.tmp.lengthSq() < 1e-8) {
      // Antipodal: the lerp passes through the centre. Any great circle will
      // do, so pick one perpendicular to the start.
      this.flightAxis.set(0, 1, 0).cross(this.flightFrom);
      if (this.flightAxis.lengthSq() < 1e-6) this.flightAxis.set(1, 0, 0);
      this.tmp.copy(this.flightAxis);
    }
    this.tmp.normalize();

    // Rotate the whole frame rather than assigning the target, so `north` — and
    // therefore the heading — comes along with it.
    this.quat.setFromUnitVectors(this.target, this.tmp);
    this.rotateFrame(this.quat);
    if (t >= 1) this.flying = false;
  }

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    this.camera = camera;

    if (this.flying) {
      this.advanceFlight(dt);
    } else if (this.autoRotate) {
      this.buildBasis();
      this.spin(this.up, -this.autoRotateSpeed * dt);
    } else if (!this.dragging && Math.abs(this.spinSpeed) > MOMENTUM_CUTOFF) {
      // Coast, with friction. Momentum is in world space, so it survives the
      // frame being rotated underneath it.
      this.spin(this.spinAxis, this.spinSpeed * dt);
      this.spinSpeed *= Math.exp(-dt * 3.2);
    } else if (!this.dragging) {
      this.spinSpeed = 0;
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

    this.syncCamera();
  }

  /**
   * Place the camera from the current frame, altitude and heading.
   *
   * Split out of update() because dragging needs it too: an arcball is only
   * correct if every pick sees the camera where the previous rotation left it.
   */
  private syncCamera(): void {
    const camera = this.camera;
    if (!camera) return;

    this.buildBasis();

    const dist = this.distance;
    camera.position.copy(this.target).multiplyScalar(dist);

    // Look direction: straight down, rotated towards the heading by the tilt.
    this.forward.copy(this.north).multiplyScalar(Math.cos(this.heading));
    this.forward.addScaledVector(this.east, Math.sin(this.heading));

    const tilt = this.tilt;
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);

    // View direction: straight down at zero tilt, swinging to the heading as
    // the tilt opens out.
    this.lookAt.copy(this.up).multiplyScalar(-cos).addScaledVector(this.forward, sin);

    // Which way is up on screen. It must be perpendicular to the view
    // direction, and in the plane the view swings through — so at zero tilt it
    // is the heading itself, and at the horizon it is the surface normal.
    //
    // Using the surface normal at every tilt, as the first version did, makes
    // it parallel to the view axis whenever the camera looks straight down.
    // That is a degenerate lookAt: the roll is then whatever the maths happens
    // to fall out with, which is why dragging never quite went where the
    // pointer did.
    this.screenUp.copy(this.up).multiplyScalar(sin).addScaledVector(this.forward, cos);

    camera.up.copy(this.screenUp);
    this.tmp.copy(camera.position).add(this.lookAt);
    camera.lookAt(this.tmp);

    // Per-frame depth range. Near tracks altitude so that centimetre detail
    // resolves on the ground, far always reaches past the planet's far limb.
    camera.near = THREE.MathUtils.clamp(this.altitude * 0.02, 0.05, 60);
    camera.far = dist + PLANET_RADIUS * 2.4;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  private buildBasis(): void {
    this.up.copy(this.target);
    this.east.crossVectors(this.north, this.up).normalize();
  }

  /**
   * Called when a pointer went down and came up in the same place.
   *
   * The rig has to be the one to decide this, because it is the only thing that
   * knows whether the gesture turned into a drag. A separate click listener on
   * the canvas fires after every drag as well, which means every time you spin
   * the planet you also tap whatever ended up under your finger.
   */
  onTap: ((clientX: number, clientY: number) => void) | null = null;

  /** Wire up pointer, wheel and touch input on a canvas. */
  attach(element: HTMLElement): () => void {
    this.element = element;
    const pointers = new Map<number, { x: number; y: number; time: number }>();
    let pinchDistance = 0;
    let lastMoveTime = 0;
    /** Where and when the gesture started, and how far it has wandered. */
    let downX = 0;
    let downY = 0;
    let downTime = 0;
    let travelled = 0;
    let multiTouch = false;

    const currentPinch = (): number => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    const onPointerDown = (e: PointerEvent): void => {
      element.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, time: performance.now() });
      this.autoRotate = false;
      this.spinSpeed = 0;
      this.flying = false;
      this.dragging = true;
      if (pointers.size === 1) {
        downX = e.clientX;
        downY = e.clientY;
        downTime = performance.now();
        travelled = 0;
        multiTouch = false;
      } else {
        multiTouch = true;
        pinchDistance = currentPinch();
      }
    };

    const onPointerMove = (e: PointerEvent): void => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const now = performance.now();
      lastMoveTime = now;
      const dt = Math.max(0.001, (now - prev.time) / 1000);

      if (pointers.size === 1) {
        travelled += Math.hypot(e.clientX - prev.x, e.clientY - prev.y);
        this.dragBetween(prev.x, prev.y, e.clientX, e.clientY, dt);
      } else if (pointers.size === 2) {
        prev.x = e.clientX;
        prev.y = e.clientY;
        prev.time = now;
        const d = currentPinch();
        if (pinchDistance > 0) this.zoom(-(d - pinchDistance) * 0.006);
        pinchDistance = d;
        return;
      }

      prev.x = e.clientX;
      prev.y = e.clientY;
      prev.time = now;
    };

    const onPointerUp = (e: PointerEvent): void => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDistance = 0;
      if (pointers.size === 0) {
        this.dragging = false;
        // Only a gesture that was still moving when it ended should coast.
        if (performance.now() - lastMoveTime > 90) this.spinSpeed = 0;

        // A tap. The slop allowance is generous on purpose: a thumb on a phone
        // moves several pixels during a deliberate tap, and a threshold tight
        // enough to be theoretically correct makes the world feel unresponsive
        // to exactly the people it was built for.
        const held = performance.now() - downTime;
        const drift = Math.hypot(e.clientX - downX, e.clientY - downY);
        if (!multiTouch && held < 420 && drift < 12 && travelled < 20) {
          this.spinSpeed = 0;
          this.onTap?.(e.clientX, e.clientY);
        }
      }
    };

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      this.autoRotate = false;
      // Normalise across the three deltaMode units browsers report.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      this.zoom(THREE.MathUtils.clamp(e.deltaY * unit * 0.0012, -0.5, 0.5));
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
      this.element = null;
    };
  }
}
