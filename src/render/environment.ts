/**
 * Shared lighting state.
 *
 * Every planet material references the same uniform objects, so moving the sun
 * updates the terrain, ocean, clouds and atmosphere in one assignment rather
 * than four.
 */

import * as THREE from 'three';
import { ATMOSPHERE_RADIUS, PLANET_RADIUS } from '../planet/config';

/**
 * The atmosphere, as a function of where the camera is.
 *
 * Two things depend on the scale height and they want opposite values.
 *
 * Ground level wants a large one. How far you see before the air whites out is
 * distance / H, so with a small H the next hill two hundred metres away
 * disappears into haze while the zenith stays clear.
 *
 * Orbit wants a small one. The halo around the planet extends about three
 * scale heights, so a large H wraps the world in a fuzzy blue bubble instead of
 * the thin bright rim that makes a planet read as a planet.
 *
 * On a world with a one-kilometre radius those are the same order of magnitude,
 * so no single value works. The scale height therefore follows the camera —
 * but the product beta * H is held constant, which pins the vertical optical
 * depth at the usual 0.35 in blue. The sky is the same colour and brightness at
 * both ends; only the horizontal reach of the air changes, and since you never
 * see the limb from the ground nor the ground from orbit, nobody sees it move.
 */

/** Vertical optical depth at sea level, in RGB. The one constant that holds. */
const VERTICAL_DEPTH: readonly [number, number, number] = [0.0625, 0.1447, 0.35];
/** Mie equivalent. */
const VERTICAL_DEPTH_MIE = 0.033;

const H_GROUND = 190;
const H_ORBIT = 36;
/** Mie sits much lower in the air column than Rayleigh. */
const MIE_HEIGHT_RATIO = 0.29;

export interface AtmosphereParams {
  scaleHeightR: number;
  scaleHeightM: number;
  betaR: [number, number, number];
  betaM: number;
  shellRadius: number;
}

export function atmosphereFor(altitude: number, out: AtmosphereParams): AtmosphereParams {
  const t = THREE.MathUtils.smoothstep(altitude, 150, 2500);
  const h = H_GROUND + (H_ORBIT - H_GROUND) * t;
  out.scaleHeightR = h;
  out.scaleHeightM = h * MIE_HEIGHT_RATIO;
  out.betaR[0] = VERTICAL_DEPTH[0] / h;
  out.betaR[1] = VERTICAL_DEPTH[1] / h;
  out.betaR[2] = VERTICAL_DEPTH[2] / h;
  out.betaM = VERTICAL_DEPTH_MIE / out.scaleHeightM;
  // Three scale heights holds better than 95% of the air column.
  out.shellRadius = PLANET_RADIUS + h * 3.2;
  return out;
}

export interface SharedUniforms {
  uSunDir: THREE.IUniform<THREE.Vector3>;
  /**
   * Sunlight as it reaches the ground, already reddened and dimmed by the air
   * it crossed. Surface materials light with this.
   */
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  /**
   * Sunlight at the top of the atmosphere, before any extinction.
   *
   * The scattering pass must use this, never uSunColor: it computes the
   * extinction along every light path itself, so feeding it pre-extincted light
   * applies the same absorption twice and turns the dusk sky olive.
   */
  uSolarColor: THREE.IUniform<THREE.Color>;
  uSolarIntensity: THREE.IUniform<number>;
  uAmbientColor: THREE.IUniform<THREE.Color>;
  uPlanetRadius: THREE.IUniform<number>;
  uAtmosphereRadius: THREE.IUniform<number>;
  uBetaRayleigh: THREE.IUniform<THREE.Vector3>;
  uBetaMie: THREE.IUniform<number>;
  uScaleHeightR: THREE.IUniform<number>;
  uScaleHeightM: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  /** Camera altitude above sea level; drives distance-faded detail. */
  uAltitude: THREE.IUniform<number>;
}

export class Environment {
  readonly uniforms: SharedUniforms = {
    uSunDir: { value: new THREE.Vector3(1, 0.28, 0.42).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.955, 0.895) },
    uSunIntensity: { value: 1.9 },
    uSolarColor: { value: new THREE.Color(1.0, 0.965, 0.92) },
    uSolarIntensity: { value: 2.1 },
    uAmbientColor: { value: new THREE.Color(0.13, 0.19, 0.30) },
    uPlanetRadius: { value: PLANET_RADIUS },
    uAtmosphereRadius: { value: ATMOSPHERE_RADIUS },
    uBetaRayleigh: { value: new THREE.Vector3(0.00033, 0.00076, 0.00184) },
    uBetaMie: { value: 0.0006 },
    uScaleHeightR: { value: 190 },
    uScaleHeightM: { value: 55 },
    uTime: { value: 0 },
    uCameraPos: { value: new THREE.Vector3() },
    uAltitude: { value: PLANET_RADIUS },
  };

  /** Radians per second of sun travel. One full day every four minutes. */
  dayLength = 240;
  private angle = 0.6;

  /** Sunlight colour before the atmosphere gets at it. */
  private readonly baseSunColor = new THREE.Color(1.0, 0.955, 0.895);
  private readonly baseSunIntensity = 1.9;
  private readonly baseAmbient = new THREE.Color(0.13, 0.19, 0.30);
  private sunPoint = new THREE.Vector3();

  update(dt: number, camera: THREE.Camera): void {
    this.angle += (dt / this.dayLength) * Math.PI * 2;
    const tilt = 0.32;
    this.uniforms.uSunDir.value
      .set(Math.cos(this.angle), Math.sin(tilt), Math.sin(this.angle))
      .normalize();

    this.uniforms.uTime.value += dt;
    camera.getWorldPosition(this.uniforms.uCameraPos.value);
    this.uniforms.uAltitude.value =
      this.uniforms.uCameraPos.value.length() - PLANET_RADIUS;

    const alt = this.uniforms.uAltitude.value;
    atmosphereFor(alt, this.air);
    this.uniforms.uScaleHeightR.value = this.air.scaleHeightR;
    this.uniforms.uScaleHeightM.value = this.air.scaleHeightM;
    this.uniforms.uBetaRayleigh.value.set(...this.air.betaR);
    this.uniforms.uBetaMie.value = this.air.betaM;
    this.uniforms.uAtmosphereRadius.value = this.air.shellRadius;

    this.updateSunlight();
  }

  private air: AtmosphereParams = {
    scaleHeightR: 190,
    scaleHeightM: 55,
    betaR: [0.00033, 0.00076, 0.00184],
    betaM: 0.0006,
    shellRadius: ATMOSPHERE_RADIUS,
  };

  /**
   * Redden and dim the sunlight by however much atmosphere it crossed to reach
   * the ground below the camera.
   *
   * This is what produces golden hour. Without it the terrain shader lights
   * everything with the same white sun at noon and at sunset, and a low sun
   * just looks like a dark scene rather than a warm one. The visible area is
   * small next to the planet, so one sample under the camera stands in for the
   * whole view and the cost is a dozen exponentials per frame rather than a
   * second raymarch per pixel.
   */
  private updateSunlight(): void {
    const sun = this.uniforms.uSunDir.value;
    const camPos = this.uniforms.uCameraPos.value;
    const R = PLANET_RADIUS;

    // Start at the ground directly below the camera.
    this.sunPoint.copy(camPos).normalize().multiplyScalar(R);

    // Distance from there to the top of the atmosphere along the sun ray.
    const b = this.sunPoint.dot(sun);
    const shell = this.air.shellRadius;
    const c = this.sunPoint.lengthSq() - shell * shell;
    const disc = b * b - c;
    const exit = disc > 0 ? -b + Math.sqrt(disc) : 0;

    const STEPS = 12;
    const ds = exit / STEPS;
    let odR = 0;
    let odM = 0;
    for (let i = 0; i < STEPS; i++) {
      const t = ds * (i + 0.5);
      const px = this.sunPoint.x + sun.x * t;
      const py = this.sunPoint.y + sun.y * t;
      const pz = this.sunPoint.z + sun.z * t;
      const h = Math.max(Math.hypot(px, py, pz) - R, 0);
      odR += Math.exp(-h / this.air.scaleHeightR) * ds;
      odM += Math.exp(-h / this.air.scaleHeightM) * ds;
    }

    // Below the horizon there is no direct sun at all; fade rather than cut,
    // so the terminator stays soft.
    const elevation = this.sunPoint.dot(sun) / R;
    const above = THREE.MathUtils.smoothstep(elevation, -0.14, 0.06);

    const bR = this.air.betaR;
    const bM = this.air.betaM;
    this.uniforms.uSunColor.value.setRGB(
      this.baseSunColor.r * Math.exp(-(bR[0] * odR + bM * odM)),
      this.baseSunColor.g * Math.exp(-(bR[1] * odR + bM * odM)),
      this.baseSunColor.b * Math.exp(-(bR[2] * odR + bM * odM)),
    );
    this.uniforms.uSunIntensity.value = this.baseSunIntensity * above;

    // Ambient is skylight, so it follows the sun down but stays blue.
    const sky = 0.16 + 0.84 * above;
    this.uniforms.uAmbientColor.value.setRGB(
      this.baseAmbient.r * sky,
      this.baseAmbient.g * sky,
      this.baseAmbient.b * sky,
    );
  }

  /** Freeze the sun at a given angle. Used by the screenshot tool. */
  setSunAngle(radians: number): void {
    this.angle = radians;
  }
}
