/**
 * Terrain surface shading.
 *
 * Biomes are a continuous function of temperature, moisture, altitude and
 * slope — never a lookup into a tile type. That is what keeps the planet
 * reading as a real landscape at every zoom level: a rainforest thins into
 * savanna over a few kilometres instead of switching at a cell boundary.
 *
 * Fragment-level detail noise fades in with proximity, so a mountainside close
 * up has grain the geometry cannot afford while the same slope viewed from
 * orbit costs nothing.
 */

import * as THREE from 'three';
import { GLSL_NOISE } from '../shaderLib';
import type { SharedUniforms } from '../environment';
import { MAX_ELEVATION } from '../../planet/config';

const vertexShader = /* glsl */ `
attribute vec3 aData;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vData;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(normalMatrix * normal);
  vData = aData;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbientColor;
uniform float uPlanetRadius;
uniform float uDetailStrength;
uniform float uProjScale;
uniform sampler2D tTerritory;
uniform float uTerritoryStrength;
uniform float uMaxElevation;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vData;

${GLSL_NOISE}

// Biome palette. Values are linear, deliberately desaturated: saturation comes
// back through the atmosphere pass and tone mapping rather than being baked in.
const vec3 C_SAND      = vec3(0.70, 0.61, 0.42);
const vec3 C_DESERT    = vec3(0.62, 0.50, 0.31);
const vec3 C_DESERT_RED= vec3(0.52, 0.31, 0.19);
const vec3 C_SAVANNA   = vec3(0.55, 0.50, 0.25);
const vec3 C_GRASS     = vec3(0.27, 0.38, 0.15);
const vec3 C_FOREST    = vec3(0.12, 0.24, 0.10);
const vec3 C_JUNGLE    = vec3(0.09, 0.26, 0.08);
const vec3 C_TAIGA     = vec3(0.17, 0.25, 0.18);
const vec3 C_TUNDRA    = vec3(0.35, 0.35, 0.28);
const vec3 C_ROCK      = vec3(0.30, 0.28, 0.26);
const vec3 C_ROCK_WARM = vec3(0.38, 0.31, 0.25);
const vec3 C_SNOW      = vec3(0.80, 0.84, 0.90);
const vec3 C_SEABED    = vec3(0.13, 0.14, 0.16);

vec3 biomeColor(float temperature, float moisture) {
  // Cold band: tundra drying towards bare ground, greening into taiga.
  vec3 cold = mix(C_TUNDRA, C_TAIGA, smoothstep(0.35, 0.7, moisture));
  // Temperate band: grassland into closed forest.
  vec3 temperate = mix(
    mix(C_DESERT, C_GRASS, smoothstep(0.22, 0.5, moisture)),
    C_FOREST,
    smoothstep(0.5, 0.78, moisture));
  // Hot band: desert, savanna, then rainforest.
  vec3 hot = mix(
    mix(C_DESERT, C_SAVANNA, smoothstep(0.18, 0.42, moisture)),
    C_JUNGLE,
    smoothstep(0.45, 0.75, moisture));

  vec3 c = mix(cold, temperate, smoothstep(0.22, 0.46, temperature));
  c = mix(c, hot, smoothstep(0.58, 0.8, temperature));
  return c;
}

/**
 * Large-scale variation in the ground itself: mineral colour, old lake beds,
 * different parent rock. Without it, an arid region is one flat cream sheet
 * from horizon to horizon, which is the one place procedural terrain most
 * obviously stops looking like a place.
 */
vec3 groundVariation(vec3 albedo, vec3 pos, float moisture) {
  float region = fbm3(pos * 0.006);
  float band = fbm3(pos * 0.022 + vec3(19.0));
  // Arid ground shows its geology; vegetation hides it.
  float exposure = smoothstep(0.7, 0.25, moisture);
  vec3 tinted = mix(albedo, albedo * vec3(1.12, 0.92, 0.74), smoothstep(0.45, 0.75, region));
  tinted = mix(tinted, C_DESERT_RED, smoothstep(0.62, 0.85, band) * 0.55 * exposure);
  tinted *= 0.9 + 0.2 * band;
  return mix(albedo, tinted, exposure * 0.7 + 0.3);
}

void main() {
  vec3 up = normalize(vWorldPos);
  vec3 N = normalize(vNormal);

  float height = vData.x;
  float moisture = vData.y;
  float temperature = vData.z;

  // Slope, as the deviation of the surface normal from straight up.
  float slope = 1.0 - clamp(dot(N, up), 0.0, 1.0);

  vec3 albedo;

  if (height < 0.0) {
    // Sea floor. Rarely seen directly, but it drives the colour of shallows
    // through the water, so it still has to be right.
    float shelf = smoothstep(-9.0, 0.0, height);
    albedo = mix(C_SEABED, C_SAND * 0.8, shelf * shelf * shelf);
  } else {
    albedo = biomeColor(temperature, moisture);
    albedo = groundVariation(albedo, vWorldPos, moisture);

    // Beaches: a narrow sand band just above the waterline, only where the
    // ground is flat enough for sand to gather.
    float beach = smoothstep(1.8, 0.1, height) * smoothstep(0.35, 0.1, slope);
    albedo = mix(albedo, C_SAND, beach);

    // Exposed rock on anything steep.
    vec3 rock = mix(C_ROCK, C_ROCK_WARM, temperature);
    albedo = mix(albedo, rock, smoothstep(0.26, 0.55, slope));

    // Snow line. Driven by temperature, which already carries a lapse rate, so
    // altitude must not be counted a second time here — doing that put snow on
    // every hill, because ordinary land is a large fraction of the maximum
    // elevation on a planet this small. Only genuine summits get an extra push.
    float snowFromTemp = smoothstep(0.24, 0.06, temperature);
    float summit = smoothstep(0.86, 0.99, height / uMaxElevation) * 0.6;
    float snow = clamp(snowFromTemp + summit, 0.0, 1.0)
               * smoothstep(0.62, 0.3, slope);
    albedo = mix(albedo, C_SNOW, snow);
  }

  // --- Close-range detail -------------------------------------------------
  // Fades out with distance so distant terrain never shimmers and the cost is
  // only paid where it is visible.
  // Fade by how large a pixel is on this surface, not by camera altitude: at
  // 150 m up, terrain near the horizon is kilometres away, and detail sized for
  // the ground under your feet turns into pure aliasing out there.
  float camDist = length(cameraPosition - vWorldPos);
  float detail = uDetailStrength * (1.0 - smoothstep(40.0, 300.0, camDist));

  if (detail > 0.002) {
    vec3 dp = vWorldPos * 0.35;
    float grain = fbm3(dp) - 0.5;
    float coarse = fbm3(vWorldPos * 0.035) - 0.5;
    albedo *= 1.0 + (grain * 0.30 + coarse * 0.22) * detail;

    // Perturb the normal with the same field, using forward differences so it
    // costs three extra samples rather than six. The differences must be
    // divided by the sample epsilon to be a gradient: skipping that makes the
    // perturbation scale with the step size instead of the slope, which tilts
    // the normal far enough to throw specular hotspots all over the ground.
    float e = 0.6;
    float n0 = fbm3(dp);
    float nx = fbm3(dp + vec3(e, 0.0, 0.0));
    float ny = fbm3(dp + vec3(0.0, e, 0.0));
    float nz = fbm3(dp + vec3(0.0, 0.0, e));
    vec3 bump = vec3(nx - n0, ny - n0, nz - n0) / e;
    bump -= N * dot(bump, N);
    N = normalize(N + bump * 0.22 * detail);
  }

  // --- Territory ----------------------------------------------------------
  // Sampled as a painted field in equirectangular space, never as cells. Where
  // two polities meet, their colour fields blend, so a border is a curve the
  // shader discovers rather than an edge the simulation drew.
  if (uTerritoryStrength > 0.001 && height > -1.0) {
    float lat = asin(clamp(up.y, -1.0, 1.0));
    float lon = atan(up.z, up.x);
    vec2 tuv = vec2(lon * 0.1591549 + 0.5, 0.5 - lat * 0.3183099);
    vec4 claim = texture2D(tTerritory, tuv);
    float cover = claim.a * uTerritoryStrength;
    if (cover > 0.003) {
      // Tint rather than replace: the land underneath still has to read as
      // desert or forest, because that is why the border is where it is.
      vec3 tinted = mix(albedo, claim.rgb, 0.7) * (0.85 + 0.25 * dot(claim.rgb, vec3(0.33)));
      albedo = mix(albedo, tinted, cover);

      // Borders, found rather than drawn: wherever the painted colour field
      // changes quickly, two states meet. Four extra taps, no geometry, and it
      // follows the coastline and the terrain for free.
      vec2 texel = vec2(1.0 / 512.0, 1.0 / 256.0) * 1.25;
      vec4 cx = texture2D(tTerritory, tuv + vec2(texel.x, 0.0));
      vec4 cy = texture2D(tTerritory, tuv + vec2(0.0, texel.y));
      float delta = length(claim.rgb - cx.rgb) + length(claim.rgb - cy.rgb)
                  + abs(claim.a - cx.a) + abs(claim.a - cy.a);
      float edge = smoothstep(0.08, 0.42, delta) * min(1.0, cover * 1.6);
      albedo = mix(albedo, albedo * 0.32 + claim.rgb * 0.34, edge);
    }
  }

  // --- Lighting -----------------------------------------------------------
  float ndl = dot(N, uSunDir);
  // A wrapped diffuse term softens the terminator, which otherwise cuts a hard
  // line across the planet that reads as a rendering artefact.
  float diffuse = clamp((ndl + 0.22) / 1.22, 0.0, 1.0);
  // Self-shadowing approximation: valleys and slopes facing away from the sky
  // catch less ambient light.
  float sky = 0.55 + 0.45 * dot(N, up);
  float cavity = mix(0.72, 1.0, 1.0 - slope);

  vec3 lit = albedo * uSunColor * uSunIntensity * diffuse;
  lit += albedo * uAmbientColor * sky * cavity;

  // A dull sheen on wet ground and snow, enough to catch the low sun.
  float wetness = height > 0.0
    ? max(smoothstep(0.62, 0.9, vData.y) * 0.25, smoothstep(0.3, 0.1, vData.z) * 0.4)
    : 0.5;
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 H = normalize(V + uSunDir);
  float spec = pow(max(dot(N, H), 0.0), 20.0) * wetness * step(0.0, ndl);
  lit += uSunColor * uSunIntensity * spec * 0.07;

  gl_FragColor = vec4(lit, 1.0);
}
`;

export function createTerrainMaterial(shared: SharedUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'terrain',
    vertexShader,
    fragmentShader,
    uniforms: {
      uSunDir: shared.uSunDir,
      uSunColor: shared.uSunColor,
      uSunIntensity: shared.uSunIntensity,
      uAmbientColor: shared.uAmbientColor,
      uPlanetRadius: shared.uPlanetRadius,
      uDetailStrength: { value: 0 },
      uProjScale: { value: 1000 },
      tTerritory: { value: null },
      uTerritoryStrength: { value: 1.0 },
      uMaxElevation: { value: MAX_ELEVATION },
    },
    side: THREE.FrontSide,
  });
}

/**
 * Detail noise is only worth its cost near the ground. Full strength under
 * about 200 m, gone by 3 km.
 */
export function updateTerrainDetail(
  material: THREE.ShaderMaterial,
  altitude: number,
  projScale: number,
): void {
  // A coarse gate only. The real fade is per fragment, by distance, inside the
  // shader; this just switches the whole cost off once nothing can be close
  // enough for it to matter.
  material.uniforms.uDetailStrength.value = altitude > 4000 ? 0 : 1;
  material.uniforms.uProjScale.value = projScale;

  // The political overlay strengthens with altitude. From orbit the planet is
  // being read as a map and borders are the point; standing in a field it
  // would only be a coloured film over ground the player came down to look at.
  const t = THREE.MathUtils.smoothstep(altitude, 120, 2200);
  material.uniforms.uTerritoryStrength.value = 0.4 + t * 0.85;
}
