/**
 * Roads, as ribbon geometry draped on the terrain.
 *
 * A road is not a sprite and it is not a decal projected in screen space. It is
 * a strip mesh whose spine was sampled against the same height field the
 * terrain is meshed from, so it follows every rise and every hollow exactly,
 * and it stays correct when the terrain under it swaps LOD level.
 *
 * The one hard part is the lift. Two surfaces that agree analytically still
 * disagree numerically, and a road at exactly ground height z-fights along its
 * whole length. Lifting it by a constant distance instead trades that for a
 * road that visibly floats close up. So the lift is proportional to distance
 * from the camera — which makes it roughly *one pixel* everywhere, which is the
 * only value that is invisible at both ends.
 *
 * The edges are the other half. A road with a hard edge reads as a sticker; a
 * road whose outer centimetre fades to nothing reads as a surface the ground
 * has grown up around. That costs one extra vertex pair per cross-section.
 */

import * as THREE from 'three';
import type { SharedUniforms } from '../environment';
import type { Plaza, RoadPath } from './plan';

export const ROAD_NEAR = 900;
export const ROAD_FAR = 1500;

const vertexShader = /* glsl */ `
attribute float aEdge;
attribute float aAcross;
attribute float aAlong;
attribute vec3 aColor;
attribute float aGrade;
attribute float aReach;

uniform float uFadeNear;
uniform float uFadeFar;
uniform float uLift;

varying float vEdge;
varying float vAcross;
varying float vAlong;
varying vec3 vColor;
varying float vGrade;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying float vFade;

void main() {
  vec3 up = normalize(position);
  float dist = length(cameraPosition - position);
  // One pixel of lift, everywhere. See the note at the top of the file.
  vec3 world = position + up * (uLift + dist * 0.0011);

  vEdge = aEdge;
  vAcross = aAcross;
  vAlong = aAlong;
  vColor = aColor;
  vGrade = aGrade;
  vNormal = normalize(normal);
  vWorldPos = world;
  // Each road carries its own range. A lane between two rows of houses is
  // invisible from four hundred metres and only adds noise to the read; the
  // route between two towns is the *first* thing that should appear. Fading
  // them together is what turned a region into a haze of pale threads.
  vFade = 1.0 - smoothstep(uFadeNear * aReach, uFadeFar * aReach, dist);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbientColor;
uniform float uLamps;

varying float vEdge;
varying float vAcross;
varying float vAlong;
varying vec3 vColor;
varying float vGrade;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying float vFade;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  float alpha = vEdge * vFade;
  if (alpha < 0.004) discard;

  vec3 albedo = vColor;

  // Wheel ruts: two darker, smoother bands where the traffic actually runs.
  // On a dirt track they are most of what makes it read as a track at all.
  float rut = exp(-pow((abs(vAcross) - 0.45) * 5.0, 2.0));
  albedo *= mix(1.0, 0.74, rut * mix(0.9, 0.35, min(vGrade, 1.0)));

  // Surface grain, and a slower variation along the road so a long straight
  // does not read as one flat painted stripe.
  float g = hash(floor(vWorldPos.xz * 3.0 + vWorldPos.y)) * 0.16 - 0.08;
  albedo *= 1.0 + g + sin(vAlong * 0.21) * 0.05;

  // Paved roads get a kerb: a pale edge, held just inside the fade.
  float kerb = smoothstep(0.78, 0.94, abs(vAcross)) * step(0.5, vGrade);
  albedo = mix(albedo, albedo * 1.9 + vec3(0.05), kerb * 0.7);

  vec3 N = normalize(vNormal);
  vec3 up = normalize(vWorldPos);
  float ndl = dot(N, uSunDir);
  float diffuse = clamp((ndl + 0.22) / 1.22, 0.0, 1.0);
  float sky = 0.55 + 0.45 * dot(N, up);

  vec3 lit = albedo * uSunColor * uSunIntensity * diffuse;
  lit += albedo * uAmbientColor * sky;

  // Street lighting, once a civilization has any: a chain of warm pools rather
  // than an even wash, so the road still reads as a road after dark.
  float daylight = clamp(dot(up, uSunDir) * 2.4 + 0.3, 0.0, 1.0);
  float night = 1.0 - daylight;
  if (night > 0.01 && uLamps > 0.01 && vGrade > 0.5) {
    float pools = pow(max(0.0, sin(vAlong * 0.16)), 8.0);
    lit += vec3(1.0, 0.74, 0.42) * pools * night * uLamps * 0.5 * (1.0 - abs(vAcross) * 0.4);
  }

  gl_FragColor = vec4(lit, alpha);
}
`;

/** Colour of a road, by the era of whoever laid it. */
export type RoadColor = [number, number, number];

export class RoadLayer {
  readonly mesh: THREE.Mesh;

  private geometry = new THREE.BufferGeometry();
  private material: THREE.ShaderMaterial;

  private position: number[] = [];
  private normal: number[] = [];
  private edge: number[] = [];
  private across: number[] = [];
  private along: number[] = [];
  private color: number[] = [];
  private grade: number[] = [];
  private reach: number[] = [];
  private index: number[] = [];

  private up = new THREE.Vector3();
  private tangent = new THREE.Vector3();
  private lateral = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  constructor(shared: SharedUniforms) {
    this.material = new THREE.ShaderMaterial({
      name: 'roads',
      vertexShader,
      fragmentShader,
      uniforms: {
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uSunIntensity: shared.uSunIntensity,
        uAmbientColor: shared.uAmbientColor,
        uLamps: { value: 0.8 },
        uFadeNear: { value: ROAD_NEAR },
        uFadeFar: { value: ROAD_FAR },
        uLift: { value: 0.12 },
      },
      transparent: true,
      // Depth-tested but not depth-writing: a road must be hidden by the hill
      // in front of it, and must never hide the building standing on it.
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'roads';
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
  }

  begin(): void {
    this.position.length = 0;
    this.normal.length = 0;
    this.edge.length = 0;
    this.across.length = 0;
    this.along.length = 0;
    this.color.length = 0;
    this.grade.length = 0;
    this.reach.length = 0;
    this.index.length = 0;
  }

  /**
   * Add one road.
   *
   * Four vertices per cross-section: a fading shoulder, the two carriageway
   * edges, and the far shoulder. Six triangles per segment, which is cheap
   * enough that road geometry has never once shown up in a frame profile here.
   */
  add(road: RoadPath, color: RoadColor): void {
    const points = road.points;
    if (points.length < 2) return;

    const half = road.width * 0.5;
    const shoulder = half + Math.max(0.6, road.width * 0.28);
    const base = this.position.length / 3;
    let travelled = 0;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];

      this.up.copy(p).normalize();
      this.tangent.copy(next).sub(prev);
      // Project the tangent into the local tangent plane, or a road climbing a
      // hill twists its cross-section out of the ground.
      this.tangent.addScaledVector(this.up, -this.tangent.dot(this.up));
      if (this.tangent.lengthSq() < 1e-10) this.tangent.set(1, 0, 0);
      this.tangent.normalize();
      this.lateral.crossVectors(this.up, this.tangent);

      if (i > 0) travelled += this.tmp.copy(p).sub(prev).length();

      const write = (offset: number, edgeValue: number): void => {
        this.tmp.copy(p).addScaledVector(this.lateral, offset);
        this.position.push(this.tmp.x, this.tmp.y, this.tmp.z);
        this.normal.push(this.up.x, this.up.y, this.up.z);
        this.edge.push(edgeValue);
        this.across.push(offset / half);
        this.along.push(travelled);
        this.color.push(color[0], color[1], color[2]);
        this.grade.push(road.grade);
        this.reach.push(road.reach ?? 1);
      };

      write(-shoulder, 0);
      write(-half, 1);
      write(half, 1);
      write(shoulder, 0);
    }

    for (let i = 0; i < points.length - 1; i++) {
      const a = base + i * 4;
      const b = a + 4;
      for (let k = 0; k < 3; k++) {
        this.index.push(a + k, b + k, b + k + 1, a + k, b + k + 1, a + k + 1);
      }
    }
  }

  /**
   * Add one open square.
   *
   * Three rings of vertices rather than a plain fan: the centre, a rim just
   * inside the boundary, and the boundary itself at zero opacity. The middle
   * ring is what keeps the square solid right up to its edge — a fan straight
   * from the centre to a transparent rim is a square that is only opaque in the
   * middle, which reads as a puddle.
   */
  addPlaza(plaza: Plaza, color: RoadColor): void {
    const rim = plaza.rim;
    const n = rim.length;
    if (n < 3) return;

    const base = this.position.length / 3;
    this.up.copy(plaza.centre).normalize();

    const write = (p: THREE.Vector3, edgeValue: number, across: number, along: number): void => {
      this.position.push(p.x, p.y, p.z);
      this.normal.push(this.up.x, this.up.y, this.up.z);
      this.edge.push(edgeValue);
      this.across.push(across);
      this.along.push(along);
      this.color.push(color[0], color[1], color[2]);
      this.grade.push(plaza.grade);
      this.reach.push(0.9);
    };

    write(plaza.centre, 1, 0, 0);
    let travelled = 0;
    for (let i = 0; i < n; i++) {
      const p = rim[i];
      if (i > 0) travelled += this.tmp.copy(p).sub(rim[i - 1]).length();
      // The inner ring sits a fixed fraction of the way in, measured from the
      // centre, so an irregular boundary keeps an even border all the way round.
      this.tmp.copy(p).sub(plaza.centre).multiplyScalar(0.88).add(plaza.centre);
      // Push it back onto the ground the rim was draped on: interpolating
      // towards the centre cuts the corner off the sphere.
      this.tmp.normalize().multiplyScalar(
        plaza.centre.length() + (p.length() - plaza.centre.length()) * 0.88,
      );
      write(this.tmp, 1, 0, travelled);
      write(p, 0, 0.86, travelled);
    }

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const innerI = base + 1 + i * 2;
      const outerI = innerI + 1;
      const innerJ = base + 1 + j * 2;
      const outerJ = innerJ + 1;
      this.index.push(base, innerI, innerJ);
      this.index.push(innerI, outerI, outerJ, innerI, outerJ, innerJ);
    }
  }

  commit(): void {
    const count = this.position.length / 3;
    if (count === 0) {
      this.mesh.visible = false;
      return;
    }
    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    this.geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3));
    this.geometry.setAttribute('aEdge', new THREE.Float32BufferAttribute(this.edge, 1));
    this.geometry.setAttribute('aAcross', new THREE.Float32BufferAttribute(this.across, 1));
    this.geometry.setAttribute('aAlong', new THREE.Float32BufferAttribute(this.along, 1));
    this.geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(this.color, 3));
    this.geometry.setAttribute('aGrade', new THREE.Float32BufferAttribute(this.grade, 1));
    this.geometry.setAttribute('aReach', new THREE.Float32BufferAttribute(this.reach, 1));
    this.geometry.setIndex(this.index);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.mesh.geometry = this.geometry;
    this.mesh.visible = true;
  }

  setLamps(value: number): void {
    this.material.uniforms.uLamps.value = value;
  }

  setRange(near: number, far: number): void {
    this.material.uniforms.uFadeNear.value = near;
    this.material.uniforms.uFadeFar.value = far;
  }

  get triangles(): number {
    return this.index.length / 3;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
