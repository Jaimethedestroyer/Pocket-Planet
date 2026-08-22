/**
 * The building layer: every structure on the planet, in one draw call each.
 *
 * One instanced geometry per archetype. A town of a hundred and sixty buildings
 * drawn from four house models and a handful of workshops costs six draws, and
 * a continent of towns costs the same six, because the instances are pooled
 * across every town rather than per town.
 *
 * A building's transform is not a matrix. It is an origin, an angle and three
 * scales, and the frame it is rotated in is rebuilt in the vertex shader from
 * the origin itself — because on a sphere "up" is a function of where you are
 * standing, and a matrix would have to be recomputed on the CPU every time the
 * planet turned. Sixteen floats per instance become ten, and the whole thing
 * stays correct at any latitude with no pole case.
 *
 * Buildings do not fade out with distance, they *grow in*. Alpha would need
 * sorting against opaque geometry that is already interleaved with terrain;
 * scaling a building's height to zero over the last stretch of its LOD band
 * costs nothing, needs no sorting, and happens at a distance where the whole
 * building is two pixels tall anyway.
 */

import * as THREE from 'three';
import { GLSL_NOISE } from '../shaderLib';
import { archetypes } from './archetypes';
import type { ArchetypeName } from './archetypes';
import { ARCHETYPE_NAMES } from './archetypes';
import type { SharedUniforms } from '../environment';
import type { Placement } from './plan';
import { ShadowLayer } from './shadows';

/** How far from the camera a building may exist, and where it grows in. */
export const BUILDING_NEAR = 620;
export const BUILDING_FAR = 1100;

const vertexShader = /* glsl */ `
attribute float aPart;
attribute float aAo;

attribute vec3 iOrigin;
attribute float iRot;
attribute vec3 iScale;
attribute vec3 iWall;
attribute vec3 iRoof;
attribute vec3 iBanner;
attribute float iStyle;

uniform float uFadeNear;
uniform float uFadeFar;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vUp;
varying float vPart;
varying float vAo;
varying vec3 vWall;
varying vec3 vRoof;
varying vec3 vBanner;
varying vec3 vLocal;
varying float vStyle;

void main() {
  vec3 up = normalize(iOrigin);
  // The same basis the planner used. Any consistent choice works; this one has
  // its only degeneracy at the y poles, where the fallback takes over.
  vec3 ref = abs(up.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 east = normalize(cross(ref, up));
  vec3 north = cross(up, east);

  float c = cos(iRot);
  float s = sin(iRot);
  // The model's own axes. The x axis is negated to keep the frame right-handed:
  // with east x north = up, the obvious choice of (east*c + north*s, up, fwd)
  // has a determinant of minus one, which is a *mirror*, not a rotation. Every
  // model then renders inside out — front faces culled, back faces drawn, and
  // every normal pointing into the building, so the whole world lights as if
  // the sun were underground. It looks like a lighting bug and is not one.
  vec3 right = -(east * c + north * s);
  vec3 fwd = -east * s + north * c;

  float dist = length(cameraPosition - iOrigin);
  // Not smoothstep(far, near, ...): GLSL leaves a reversed edge pair
  // undefined, and "undefined" on one driver means "invisible everywhere".
  float grow = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);

  vec3 scale = iScale * vec3(mix(0.55, 1.0, grow), grow, mix(0.55, 1.0, grow));
  vec3 local = position * scale;
  vec3 world = iOrigin + right * local.x + up * local.y + fwd * local.z;

  // Non-uniform scale: the normal transforms by the inverse scale, not by the
  // scale. Skipping that tilts every roof normal by however much the instance
  // was squashed, which shows up as roofs of the same colour catching the sun
  // differently for no reason.
  vec3 nl = normal / max(scale, vec3(1e-4));
  vec3 n = normalize(right * nl.x + up * nl.y + fwd * nl.z);

  vWorldPos = world;
  vNormal = n;
  vUp = up;
  vPart = aPart;
  vAo = aAo;
  vWall = iWall;
  vRoof = iRoof;
  vBanner = iBanner;
  // Model space, in metres and unscaled: courses have to be the same height on
  // a building the planner squashed as on one it did not.
  vLocal = position;
  vStyle = iStyle;

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

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vUp;
varying float vPart;
varying float vAo;
varying vec3 vWall;
varying vec3 vRoof;
varying vec3 vBanner;
varying vec3 vLocal;
varying float vStyle;

${GLSL_NOISE}

/**
 * A planar coordinate on whichever face this fragment is on.
 *
 * Vertical faces get (across, up); horizontal ones get the footprint plane.
 * Blended by how vertical the normal is, so the change along a roof edge is a
 * gradient rather than a line — which matters because there is no UV unwrap
 * anywhere in this game and there is not going to be one.
 */
vec2 faceUv(vec3 local, vec3 n) {
  vec2 wall = vec2(local.x * n.z - local.z * n.x, local.y);
  return mix(local.xz, wall, clamp((1.0 - abs(n.y)) * 1.6, 0.0, 1.0));
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 up = normalize(vUp);

  float part = vPart;
  vec3 albedo = vWall;
  float gloss = 0.0;
  float glass = 0.0;

  if (part > 0.5 && part < 1.5) {
    albedo = vRoof;
    gloss = 0.25;
  } else if (part > 1.5 && part < 2.5) {
    // Trim: timber, stone plinths, chimneys. Derived from the wall so it always
    // belongs to the building rather than being a fifth arbitrary colour.
    albedo = vWall * 0.42 + vRoof * 0.12;
  } else if (part > 2.5 && part < 3.5) {
    albedo = vec3(0.05, 0.055, 0.07);
    glass = 1.0;
    gloss = 0.6;
  } else if (part > 3.5) {
    // Dyed cloth, not a flag on a screen. The polity's colour is chosen to
    // stay legible as a territory field seen from orbit, which makes it far
    // too saturated for a market awning standing next to earth-coloured
    // walls — a cyan state ends up with cyan parasols.
    albedo = vBanner * 0.72 + vWall * 0.14;
    gloss = 0.1;
  }

  // --- Surface -------------------------------------------------------------
  // Flat colour is what makes untextured geometry read as a placeholder. None
  // of this is a texture: it is the same trick the terrain uses, procedural
  // detail faded in by how close the surface is, so it costs nothing at the
  // distance where a building is eight pixels tall and everything at the
  // distance where you are standing next to it.
  float camDist = length(cameraPosition - vWorldPos);
  float detail = 1.0 - smoothstep(140.0, 460.0, camDist);
  if (detail > 0.004 && part < 3.5) {
    vec2 uv = faceUv(vLocal, N);

    // Mottling: no wall anywhere is one colour. fbm3 averages about 0.44 with
    // a narrow spread, so it has to be recentred and stretched — used raw it
    // is a two per cent wobble, which is a cost with no picture attached.
    float mottle = (fbm3(vWorldPos * 1.25) - 0.44) * 2.4;
    float coarse = (fbm3(vWorldPos * 0.28) - 0.44) * 2.4;
    albedo *= 1.0 + (mottle * 0.20 + coarse * 0.16) * detail;

    // Courses. The spacing is the material: thatch and daub have none, mudbrick
    // has broad ones, fired brick has four to the metre — and roof tiles are
    // laid in much deeper courses than any wall, which is what still reads from
    // the far side of a town when the brickwork has gone sub-pixel.
    float roofy = step(0.5, part) * step(part, 1.5);
    float spacing = mix(mix(0.62, 0.26, vStyle), mix(1.15, 0.55, vStyle), roofy);
    float row = floor(uv.y / spacing);
    // Every other course steps half a brick along, which is the whole
    // difference between a wall and a grid.
    float shifted = uv.x + mod(row, 2.0) * spacing * 1.1;
    float bed = abs(fract(uv.y / spacing) - 0.5) * 2.0;
    float perp = abs(fract(shifted / (spacing * 2.2)) - 0.5) * 2.0;
    float mortar = max(smoothstep(0.86, 1.0, bed), smoothstep(0.93, 1.0, perp) * 0.7);
    // Roughness on the courses themselves, so they are not ruled lines.
    mortar *= 0.65 + 0.35 * fbm3(vWorldPos * 6.0 + row);
    albedo *= 1.0 - mortar * 0.42 * detail * max(vStyle, roofy * 0.8);

    // Weathering: streaks running down from the eaves.
    float streak = fbm3(vec3(uv.x * 5.0, uv.y * 0.7, row)) - 0.5;
    albedo *= 1.0 + streak * 0.18 * detail;
  }

  // Lighting. The direct term is matched to the terrain shader, because two
  // surfaces lit by different models is the fastest way to make a building look
  // pasted onto the ground it stands on.
  //
  // The indirect term is not, and cannot be. Terrain almost never faces away
  // from the sun — it is a surface draped over a sphere, so most of it is
  // tilted towards the sky. A building is four vertical walls, and at any hour
  // of the day at least one of them faces away. With only the terrain's thin
  // ambient, that wall is *black*: not shadowed, black, a hole cut in the
  // world. Real ones are not, because a wall in shadow is lit by the sky above
  // it and by sunlight bouncing off the ground in front of it, and both of
  // those are large. So both are here.
  float ndl = dot(N, uSunDir);
  float diffuse = clamp((ndl + 0.22) / 1.22, 0.0, 1.0);
  float sky = 0.55 + 0.45 * dot(N, up);

  vec3 lit = albedo * uSunColor * uSunIntensity * diffuse * mix(0.55, 1.0, vAo);

  // Skylight, from the hemisphere above.
  lit += albedo * uAmbientColor * 2.1 * sky * vAo;

  // Bounce, off the sunlit ground. Warm, weak, and strongest on the walls the
  // sun cannot reach — which is exactly where it is needed.
  float bounce = clamp(0.5 - 0.5 * dot(N, up), 0.0, 1.0)
               * clamp(0.55 - 0.45 * ndl, 0.0, 1.0);
  lit += albedo * uSunColor * uSunIntensity * bounce * 0.17 * vAo;

  if (gloss > 0.0) {
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 H = normalize(V + uSunDir);
    float spec = pow(max(dot(N, H), 0.0), 34.0) * gloss * step(0.0, ndl);
    lit += uSunColor * uSunIntensity * spec * 0.35;
  }

  // Night. A window is a hole in the wall with a fire behind it, so it lights
  // up as the sun goes down — and the era decides how much of one: a primitive
  // village is nearly dark, an industrial city is not dark at all.
  float daylight = clamp(dot(up, uSunDir) * 2.4 + 0.3, 0.0, 1.0);
  float night = 1.0 - daylight;
  if (glass > 0.0) {
    // Not every window in a town is lit, and the ones that are, are not equally
    // lit. Hashing world position gives that for free and keeps it stable.
    float h = fract(sin(dot(floor(vWorldPos * 3.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float on = step(0.35, h) * (0.45 + 0.55 * h);
    vec3 lamp = vec3(1.0, 0.72, 0.36);
    lit += lamp * on * night * uLamps * 2.6;
  }

  gl_FragColor = vec4(lit, 1.0);
}
`;

interface Pool {
  geometry: THREE.InstancedBufferGeometry;
  mesh: THREE.Mesh;
  origin: THREE.InstancedBufferAttribute;
  rot: THREE.InstancedBufferAttribute;
  scale: THREE.InstancedBufferAttribute;
  wall: THREE.InstancedBufferAttribute;
  roof: THREE.InstancedBufferAttribute;
  banner: THREE.InstancedBufferAttribute;
  style: THREE.InstancedBufferAttribute;
  capacity: number;
  count: number;
}

export class BuildingLayer {
  readonly group = new THREE.Group();
  readonly shadows: ShadowLayer;

  private material: THREE.ShaderMaterial;
  private pools = new Map<ArchetypeName, Pool>();

  constructor(shared: SharedUniforms) {
    this.shadows = new ShadowLayer(shared);
    this.material = new THREE.ShaderMaterial({
      name: 'buildings',
      vertexShader,
      fragmentShader,
      uniforms: {
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uSunIntensity: shared.uSunIntensity,
        uAmbientColor: shared.uAmbientColor,
        uLamps: { value: 0.8 },
        uFadeNear: { value: BUILDING_NEAR },
        uFadeFar: { value: BUILDING_FAR },
      },
      side: THREE.FrontSide,
    });
    this.group.name = 'buildings';
    // After the terrain, so the early-z from the ground is already in place.
    this.group.renderOrder = 2;
    this.group.add(this.shadows.group);
  }

  private pool(name: ArchetypeName): Pool {
    const hit = this.pools.get(name);
    if (hit) return hit;

    const model = archetypes()[name];
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = model.geometry.index;
    for (const key of ['position', 'normal', 'aPart', 'aAo']) {
      geometry.setAttribute(key, model.geometry.getAttribute(key));
    }
    // The bounding sphere is meaningless once instances scatter over a planet,
    // and three would cull the whole pool against the first instance's.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    geometry.instanceCount = 0;

    const pool: Pool = {
      geometry,
      mesh: new THREE.Mesh(geometry, this.material),
      origin: null as unknown as THREE.InstancedBufferAttribute,
      rot: null as unknown as THREE.InstancedBufferAttribute,
      scale: null as unknown as THREE.InstancedBufferAttribute,
      wall: null as unknown as THREE.InstancedBufferAttribute,
      roof: null as unknown as THREE.InstancedBufferAttribute,
      banner: null as unknown as THREE.InstancedBufferAttribute,
      style: null as unknown as THREE.InstancedBufferAttribute,
      capacity: 0,
      count: 0,
    };
    pool.mesh.frustumCulled = false;
    pool.mesh.name = `buildings:${name}`;
    this.group.add(pool.mesh);
    this.pools.set(name, pool);
    this.grow(pool, 256);
    this.shadows.attach(name, model, pool);
    return pool;
  }

  private grow(pool: Pool, capacity: number): void {
    pool.capacity = capacity;
    const make = (size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    pool.origin = make(3);
    pool.rot = make(1);
    pool.scale = make(3);
    pool.wall = make(3);
    pool.roof = make(3);
    pool.banner = make(3);
    pool.style = make(1);
    pool.geometry.setAttribute('iOrigin', pool.origin);
    pool.geometry.setAttribute('iRot', pool.rot);
    pool.geometry.setAttribute('iScale', pool.scale);
    pool.geometry.setAttribute('iWall', pool.wall);
    pool.geometry.setAttribute('iRoof', pool.roof);
    pool.geometry.setAttribute('iBanner', pool.banner);
    pool.geometry.setAttribute('iStyle', pool.style);
  }

  /** Rebind the shadow pool after a grow replaced the attribute objects. */
  private rebindShadows(name: ArchetypeName, pool: Pool): void {
    this.shadows.attach(name, archetypes()[name], pool);
  }

  /** Start a fresh upload. Every pool is emptied; nothing is deallocated. */
  begin(): void {
    for (const pool of this.pools.values()) pool.count = 0;
  }

  add(p: Placement, banner: [number, number, number]): void {
    const pool = this.pool(p.archetype);
    if (pool.count >= pool.capacity) {
      // Growing loses the instances already written this pass, so copy them.
      const previous = {
        origin: pool.origin.array as Float32Array,
        rot: pool.rot.array as Float32Array,
        scale: pool.scale.array as Float32Array,
        wall: pool.wall.array as Float32Array,
        roof: pool.roof.array as Float32Array,
        banner: pool.banner.array as Float32Array,
        style: pool.style.array as Float32Array,
        count: pool.count,
      };
      this.grow(pool, pool.capacity * 2);
      this.rebindShadows(p.archetype, pool);
      (pool.origin.array as Float32Array).set(previous.origin.subarray(0, previous.count * 3));
      (pool.rot.array as Float32Array).set(previous.rot.subarray(0, previous.count));
      (pool.scale.array as Float32Array).set(previous.scale.subarray(0, previous.count * 3));
      (pool.wall.array as Float32Array).set(previous.wall.subarray(0, previous.count * 3));
      (pool.roof.array as Float32Array).set(previous.roof.subarray(0, previous.count * 3));
      (pool.banner.array as Float32Array).set(previous.banner.subarray(0, previous.count * 3));
      (pool.style.array as Float32Array).set(previous.style.subarray(0, previous.count));
    }

    const i = pool.count++;
    const o = pool.origin.array as Float32Array;
    o[i * 3] = p.origin.x;
    o[i * 3 + 1] = p.origin.y;
    o[i * 3 + 2] = p.origin.z;
    (pool.rot.array as Float32Array)[i] = p.rot;
    const s = pool.scale.array as Float32Array;
    s[i * 3] = p.scale.x;
    s[i * 3 + 1] = p.scale.y;
    s[i * 3 + 2] = p.scale.z;
    const w = pool.wall.array as Float32Array;
    w[i * 3] = p.wall[0];
    w[i * 3 + 1] = p.wall[1];
    w[i * 3 + 2] = p.wall[2];
    const r = pool.roof.array as Float32Array;
    r[i * 3] = p.roof[0];
    r[i * 3 + 1] = p.roof[1];
    r[i * 3 + 2] = p.roof[2];
    const b = pool.banner.array as Float32Array;
    b[i * 3] = banner[0];
    b[i * 3 + 1] = banner[1];
    b[i * 3 + 2] = banner[2];
    (pool.style.array as Float32Array)[i] = p.style;
  }

  /** Publish whatever was added since begin(). */
  commit(): void {
    for (const [name, pool] of this.pools) {
      pool.geometry.instanceCount = pool.count;
      pool.mesh.visible = pool.count > 0;
      this.shadows.setCount(name, pool.count);
      if (pool.count === 0) continue;
      pool.origin.needsUpdate = true;
      pool.rot.needsUpdate = true;
      pool.scale.needsUpdate = true;
      pool.wall.needsUpdate = true;
      pool.roof.needsUpdate = true;
      pool.banner.needsUpdate = true;
      pool.style.needsUpdate = true;
    }
  }

  /** How lit the windows get after dark. Driven by the dominant era. */
  setLamps(value: number): void {
    this.material.uniforms.uLamps.value = value;
  }

  setRange(near: number, far: number): void {
    this.material.uniforms.uFadeNear.value = near;
    this.material.uniforms.uFadeFar.value = far;
    this.shadows.setRange(near, far);
  }

  get instanceCount(): number {
    let total = 0;
    for (const pool of this.pools.values()) total += pool.count;
    return total;
  }

  get drawCalls(): number {
    let total = 0;
    for (const pool of this.pools.values()) if (pool.count > 0) total++;
    return total;
  }

  dispose(): void {
    for (const pool of this.pools.values()) pool.geometry.dispose();
    this.pools.clear();
    this.shadows.dispose();
    this.material.dispose();
  }
}

export { ARCHETYPE_NAMES };
