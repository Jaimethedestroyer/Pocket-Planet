/**
 * Settlement markers.
 *
 * One instanced billboard per settlement, sized by tier and coloured by
 * polity, with a minimum on-screen size so a village is still a visible speck
 * from orbit. At night the cores light up, which is what makes a civilization's
 * growth legible at a glance: a dark planet slowly acquiring constellations.
 */

import * as THREE from 'three';
import { PLANET_RADIUS } from '../planet/config';
import { polityColor } from '../sim/protocol';
import type { SettlementView } from '../sim/protocol';
import type { SharedUniforms } from './environment';

const vertexShader = /* glsl */ `
attribute vec3 iCenter;
attribute vec3 iColor;
attribute float iSize;

uniform float uProjScale;
uniform float uMinPixels;
uniform float uHandoffNear;
uniform float uHandoffFar;

varying vec2 vQuad;
varying vec3 vColor;
varying vec3 vCenter;
varying float vHandoff;

void main() {
  vQuad = position.xy;
  vColor = iColor;
  vCenter = iCenter;

  vec3 toCamera = cameraPosition - iCenter;
  float dist = length(toCamera);

  // Hand over to the real town. Close in, the marker is a coloured smear over
  // buildings that are drawing themselves properly, so it gets out of the way —
  // and by night it hands its glow to the windows, which is where the light was
  // always supposed to be coming from.
  vHandoff = smoothstep(uHandoffNear, uHandoffFar, dist);

  // Keep a floor on the apparent size: a hamlet seen from orbit should still
  // be one visible pixel rather than nothing at all.
  float worldPerPixel = dist / uProjScale;
  float size = max(iSize, uMinPixels * worldPerPixel);

  // Billboard, but rolled so its up axis follows the planet's surface normal
  // rather than the screen — markers then sit on the ground instead of
  // floating at an arbitrary angle when the camera tilts.
  vec3 forward = toCamera / max(dist, 1e-4);
  vec3 up = normalize(iCenter);
  vec3 right = normalize(cross(up, forward));
  vec3 quadUp = cross(forward, right);

  vec3 world = iCenter + (right * position.x + quadUp * position.y) * size;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;

varying vec2 vQuad;
varying vec3 vColor;
varying vec3 vCenter;
varying float vHandoff;

void main() {
  if (vHandoff < 0.004) discard;
  float r = length(vQuad) * 2.0;
  if (r > 1.0) discard;

  float core = 1.0 - smoothstep(0.42, 0.72, r);
  float halo = pow(1.0 - r, 2.4);
  // A rim gives the patch an edge, which is what stops a town reading as a
  // smudge once there are a hundred of them on one continent.
  float rim = smoothstep(0.5, 0.72, r) * (1.0 - smoothstep(0.82, 1.0, r));

  float daylight = clamp(dot(normalize(vCenter), uSunDir) * 2.4 + 0.3, 0.0, 1.0);
  float night = 1.0 - daylight;

  // By day a settlement is built ground: roofs, roads and cleared earth, which
  // from orbit is a grey-brown patch, not a glowing dot. Only the rim carries
  // the polity's colour, so a hundred towns do not turn a continent into
  // confetti.
  vec3 built = mix(vec3(0.34, 0.31, 0.28), vColor, 0.3);
  vec3 dayColor = mix(built, vColor * 1.15, rim) * uSunColor * max(uSunIntensity * 0.55, 0.25);

  // By night they are their own light source.
  vec3 lampLight = vec3(1.0, 0.80, 0.52);
  vec3 nightColor = mix(vColor * 0.4, lampLight, 0.82) * (1.5 + night * 2.4);

  vec3 color = mix(dayColor, nightColor, night);
  float alpha = clamp(
    mix(core * 0.92 + rim * 0.75, core + halo * 0.7, night),
    0.0,
    1.0) * vHandoff;

  gl_FragColor = vec4(color, alpha);
}
`;

/**
 * World-space radius of each settlement tier, before the pixel floor.
 *
 * Scaled to the planet, not to reality: this world's circumference is about
 * six kilometres, so a metropolis 140 m across is proportionally a large city.
 * Sized realistically instead, every settlement is sub-pixel from orbit, which
 * is exactly what the first version did.
 */
const TIER_SIZE = [9, 15, 24, 36, 52, 72];

export class SettlementLayer {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.InstancedBufferGeometry;
  private material: THREE.ShaderMaterial;

  private capacity = 0;
  private centers!: THREE.InstancedBufferAttribute;
  private colors!: THREE.InstancedBufferAttribute;
  private sizes!: THREE.InstancedBufferAttribute;

  /** Cell unit positions and ground heights, from the simulation worker. */
  private cellPositions: Float32Array | null = null;
  private cellHeights: Float32Array | null = null;
  private colorCache = new Map<number, [number, number, number]>();

  constructor(shared: SharedUniforms) {
    this.geometry = new THREE.InstancedBufferGeometry();
    const quad = new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      name: 'settlements',
      vertexShader,
      fragmentShader,
      uniforms: {
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uSunIntensity: shared.uSunIntensity,
        uProjScale: { value: 1000 },
        uMinPixels: { value: 3.4 },
        uHandoffNear: { value: 240 },
        uHandoffFar: { value: 780 },
      },
      transparent: true,
      depthWrite: false,
      // Straight alpha rather than additive. Additive markers over sunlit
      // ground are all but invisible, because the ground is already bright;
      // alpha lets a settlement replace what is under it by day and still
      // blow out as a light by night.
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    this.grow(512);
  }

  setCellData(positions: Float32Array, heights: Float32Array): void {
    this.cellPositions = positions;
    this.cellHeights = heights;
  }

  private grow(capacity: number): void {
    this.capacity = capacity;
    this.centers = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.colors = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.sizes = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.centers.setUsage(THREE.DynamicDrawUsage);
    this.colors.setUsage(THREE.DynamicDrawUsage);
    this.sizes.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('iCenter', this.centers);
    this.geometry.setAttribute('iColor', this.colors);
    this.geometry.setAttribute('iSize', this.sizes);
  }

  update(settlements: SettlementView[], hues: Map<number, number>): void {
    if (!this.cellPositions || !this.cellHeights) return;
    if (settlements.length > this.capacity) {
      this.grow(Math.ceil(settlements.length * 1.5));
    }

    const centers = this.centers.array as Float32Array;
    const colors = this.colors.array as Float32Array;
    const sizes = this.sizes.array as Float32Array;

    for (let i = 0; i < settlements.length; i++) {
      const s = settlements[i];
      const c = s.cell * 3;
      // Lift slightly off the ground so the marker is never z-fought by the
      // terrain it sits on.
      const r = PLANET_RADIUS + Math.max(0, this.cellHeights[s.cell]) + 1.5;
      centers[i * 3] = this.cellPositions[c] * r;
      centers[i * 3 + 1] = this.cellPositions[c + 1] * r;
      centers[i * 3 + 2] = this.cellPositions[c + 2] * r;

      let color = this.colorCache.get(s.polity);
      if (!color) {
        color = polityColor(hues.get(s.polity) ?? 0.1);
        this.colorCache.set(s.polity, color);
      }
      colors[i * 3] = color[0];
      colors[i * 3 + 1] = color[1];
      colors[i * 3 + 2] = color[2];

      sizes[i] = TIER_SIZE[Math.min(TIER_SIZE.length - 1, s.tier)];
    }

    this.centers.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.sizes.needsUpdate = true;
    this.geometry.instanceCount = settlements.length;
    this.mesh.visible = settlements.length > 0;
  }

  setProjScale(value: number): void {
    this.material.uniforms.uProjScale.value = value;
  }

  /** Where the marker gives way to the built town underneath it. */
  setHandoff(near: number, far: number): void {
    this.material.uniforms.uHandoffNear.value = near;
    this.material.uniforms.uHandoffFar.value = far;
  }

  /** World position of a settlement's marker, for picking and for the camera. */
  positionOf(cell: number, out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.cellPositions || !this.cellHeights) return null;
    if (cell < 0 || cell * 3 + 2 >= this.cellPositions.length) return null;
    const r = PLANET_RADIUS + Math.max(0, this.cellHeights[cell]);
    return out
      .set(
        this.cellPositions[cell * 3],
        this.cellPositions[cell * 3 + 1],
        this.cellPositions[cell * 3 + 2],
      )
      .multiplyScalar(r);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
