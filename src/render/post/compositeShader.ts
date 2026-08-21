/**
 * The composite pass: ocean, atmosphere and stars, all in screen space.
 *
 * The ocean is not geometry. It is a perfect sphere of known radius, so the
 * view ray is intersected with it analytically, per pixel. That means the
 * waterline is mathematically exact at every zoom level — no tessellation to
 * choose, no polygonal coastline when you fly down to a beach, and no
 * transparency sorting against the terrain. Water depth comes from the scene
 * depth buffer, which is what lets shallows show the sea floor through them and
 * deep water swallow it.
 *
 * The atmosphere is a single-scattering Rayleigh and Mie raymarch bounded by
 * the same depth buffer, so it fogs distant mountains and rims the planet's
 * limb from space with one piece of code.
 */

import { GLSL_NOISE, GLSL_SPHERE } from '../shaderLib';

export const compositeVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const compositeFragment = /* glsl */ `
precision highp float;

uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform mat4 uInvProjView;
uniform vec3 uCameraPos;
uniform vec3 uCameraForward;
uniform float uNear;
uniform float uFar;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uPlanetRadius;
uniform float uAtmosphereRadius;
uniform float uTime;

uniform vec3 uBetaRayleigh;
uniform float uBetaMie;
uniform float uScaleHeightR;
uniform float uScaleHeightM;
uniform float uAtmosphereStrength;
uniform float uProjScale;

varying vec2 vUv;

${GLSL_NOISE}
${GLSL_SPHERE}

const float PI = 3.141592653589793;

// Sample counts are compile-time so the loops unroll; the quality tier picks
// the shader variant rather than branching per pixel.
#ifndef PRIMARY_STEPS
#define PRIMARY_STEPS 12
#endif
#ifndef LIGHT_STEPS
#define LIGHT_STEPS 5
#endif

/** Convert a non-linear depth sample to a positive view-space distance. */
float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

/* ------------------------------------------------------------------ stars */

vec3 starField(vec3 dir) {
  // Three cells of decreasing size give a believable spread of magnitudes.
  vec3 col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float scale = 180.0 + float(i) * 420.0;
    vec3 p = dir * scale;
    vec3 cell = floor(p);
    vec3 f = fract(p) - 0.5;
    float h = hash31(cell + float(i) * 37.0);
    if (h > 0.982) {
      vec3 offset = vec3(hash31(cell + 3.1), hash31(cell + 7.7), hash31(cell + 11.3)) - 0.5;
      float d = length(f - offset * 0.7);
      float mag = (h - 0.982) / 0.018;
      float brightness = smoothstep(0.13, 0.0, d) * mag * mag;
      // Faint colour variation: most stars white, a few warm or blue.
      float tint = hash31(cell + 19.0);
      vec3 c = mix(vec3(0.75, 0.83, 1.0), vec3(1.0, 0.88, 0.72), tint);
      col += c * brightness * 1.6;
    }
  }
  return col;
}

/* -------------------------------------------------------------- atmosphere */

/*
 * A note on scale height, which is the whole trick here.
 *
 * How far you can see through an atmosphere before it whites out, and how blue
 * the sky is overhead, are not independent. The ratio between them is
 * distance / scaleHeight: a horizontal look of length d carries d/H times as
 * much air as the entire vertical column does.
 *
 * Earth gets away with H = 8 km because that is comparable to how far we care
 * to see. This planet has a one-kilometre radius, so a scale height scaled down
 * to match it would be metres — and standing on a hill, the next hill two
 * hundred metres away would vanish in white haze while the zenith stayed clear.
 *
 * So the scale height is chosen from the sightline instead of from the planet:
 * H = 190, comfortably longer than the few hundred metres a player looks
 * across on the ground. The coefficients then follow from wanting the usual
 * vertical optical depth of about 0.35 in blue, and everything else — sky
 * colour, aerial perspective, the glowing limb from orbit — comes out of the
 * same physically consistent march. No special cases, no altitude blending.
 */

/** Optical depth from a point towards the sun, or -1 if the planet blocks it. */
vec2 lightOpticalDepth(vec3 pos) {
  // A ray that re-enters the planet is in shadow.
  vec2 planetHit = raySphere(pos, uSunDir, uPlanetRadius);
  if (planetHit.x > 0.0) return vec2(-1.0);

  vec2 atmo = raySphere(pos, uSunDir, uAtmosphereRadius);
  float len = max(atmo.y, 0.0);
  float ds = len / float(LIGHT_STEPS);
  vec2 od = vec2(0.0);
  vec3 p = pos + uSunDir * ds * 0.5;
  for (int i = 0; i < LIGHT_STEPS; i++) {
    float h = max(length(p) - uPlanetRadius, 0.0);
    od.x += exp(-h / uScaleHeightR) * ds;
    od.y += exp(-h / uScaleHeightM) * ds;
    p += uSunDir * ds;
  }
  return od;
}

/**
 * Single-scattered light along a view ray, plus the transmittance the ray
 * leaves behind so the caller can attenuate whatever was already there.
 */
void scatter(
  vec3 origin,
  vec3 dir,
  float tMin,
  float tMax,
  out vec3 inscatter,
  out vec3 transmittance
) {
  inscatter = vec3(0.0);
  transmittance = vec3(1.0);
  if (tMax <= tMin) return;

  float ds = (tMax - tMin) / float(PRIMARY_STEPS);
  vec3 p = origin + dir * (tMin + ds * 0.5);

  vec2 odView = vec2(0.0);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);

  for (int i = 0; i < PRIMARY_STEPS; i++) {
    float h = max(length(p) - uPlanetRadius, 0.0);
    float dr = exp(-h / uScaleHeightR) * ds;
    float dm = exp(-h / uScaleHeightM) * ds;
    odView += vec2(dr, dm);

    vec2 odLight = lightOpticalDepth(p);
    if (odLight.x >= 0.0) {
      vec3 tau = uBetaRayleigh * (odView.x + odLight.x)
               + vec3(uBetaMie) * 1.1 * (odView.y + odLight.y);
      vec3 att = exp(-tau);
      sumR += dr * att;
      sumM += dm * att;
    }
    p += dir * ds;
  }

  float mu = dot(dir, uSunDir);
  float phaseR = (3.0 / (16.0 * PI)) * (1.0 + mu * mu);
  const float g = 0.76;
  float g2 = g * g;
  float phaseM = (3.0 / (8.0 * PI)) * ((1.0 - g2) * (1.0 + mu * mu))
               / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5));

  inscatter = (sumR * uBetaRayleigh * phaseR + sumM * uBetaMie * phaseM)
            * uSunColor * uSunIntensity * uAtmosphereStrength;
  transmittance = exp(-(uBetaRayleigh * odView.x + vec3(uBetaMie) * 1.1 * odView.y));
}

/* ------------------------------------------------------------------ ocean */

/**
 * Animated surface normal.
 *
 * Waves are about a metre across, so whether they can be drawn at all depends
 * on how much world space one pixel covers here — which at a grazing angle
 * across an ocean is vastly more than the distance alone suggests. Fading on
 * that footprint rather than on distance is the difference between a moving
 * sea and a field of white speckle.
 */
vec3 waterNormal(vec3 pos, vec3 up, vec3 dir, float dist) {
  float grazing = max(dot(up, -dir), 0.06);
  float footprint = (dist / uProjScale) / grazing;
  float detail = 1.0 - smoothstep(0.22, 1.0, footprint);
  if (detail < 0.01) return up;

  // Two scrolling octaves: a slow swell and a finer chop over it.
  vec3 q = pos * 0.55 + vec3(0.0, uTime * 0.05, 0.0);
  vec3 r = pos * 1.7 - vec3(uTime * 0.09, 0.0, uTime * 0.06);
  float fine = 1.0 - smoothstep(0.08, 0.35, footprint);
  float e = 0.06;
  float n0 = fbm3(q) + fbm3(r) * 0.35 * fine;
  float nx = fbm3(q + vec3(e, 0.0, 0.0)) + fbm3(r + vec3(e, 0.0, 0.0)) * 0.35 * fine;
  float ny = fbm3(q + vec3(0.0, e, 0.0)) + fbm3(r + vec3(0.0, e, 0.0)) * 0.35 * fine;
  float nz = fbm3(q + vec3(0.0, 0.0, e)) + fbm3(r + vec3(0.0, 0.0, e)) * 0.35 * fine;
  vec3 grad = vec3(nx - n0, ny - n0, nz - n0);
  // Project out the component along the normal so the wave stays a wave.
  grad -= up * dot(grad, up);
  return normalize(up + grad * 4.0 * detail);
}

void main() {
  // Reconstruct the world-space view ray for this pixel.
  vec4 far = uInvProjView * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - uCameraPos);

  vec3 color = texture2D(tScene, vUv).rgb;
  float rawDepth = texture2D(tDepth, vUv).x;

  bool hitScene = rawDepth < 1.0;
  // Depth is measured along the camera's forward axis, not along the ray.
  float sceneDist = hitScene
    ? linearDepth(rawDepth) / max(dot(dir, uCameraForward), 1e-4)
    : 1e9;

  float occluderDist = sceneDist;

  /* --- Stars, where nothing was drawn ---------------------------------- */
  if (!hitScene) {
    color += starField(dir);
  }

  /* --- Ocean ------------------------------------------------------------ */
  vec2 sea = raySphere(uCameraPos, dir, uPlanetRadius);
  if (sea.x > 0.0 && sea.x < sceneDist) {
    vec3 surface = uCameraPos + dir * sea.x;
    vec3 up = normalize(surface);
    vec3 N = waterNormal(surface, up, dir, sea.x);

    // How much water the ray passes through before hitting the sea floor.
    float depth = hitScene ? (sceneDist - sea.x) : (sea.y - sea.x);
    depth = max(depth, 0.0);

    // Absorption: the sea floor's colour is progressively replaced by the
    // water's own, which is what makes shallows legible and deeps opaque.
    // Absorption lengths are tuned to this planet's bathymetry, not Earth's:
    // the deepest trench here is about 22 m, so water has to reach its full
    // colour within a few metres or every sea reads as a bright lagoon.
    const vec3 SHALLOW = vec3(0.050, 0.26, 0.30);
    const vec3 DEEP    = vec3(0.003, 0.026, 0.072);
    float absorb = 1.0 - exp(-depth * 0.34);
    vec3 body = mix(color * vec3(0.42, 0.74, 0.82), SHALLOW, absorb);
    body = mix(body, DEEP, 1.0 - exp(-depth * 0.115));

    float shade = clamp(dot(up, uSunDir) * 1.4 + 0.12, 0.0, 1.0);
    body *= mix(0.10, 1.0, shade);

    // Fresnel towards a simple sky tint. A full reflection probe is not worth
    // it here: at these angles the sky is nearly uniform anyway.
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, -dir), 0.0), 5.0);
    vec3 skyTint = mix(vec3(0.16, 0.28, 0.46), vec3(0.55, 0.70, 0.95), shade);
    vec3 water = mix(body, skyTint * (0.25 + 0.75 * shade), fres * 0.85);

    // Sun glint.
    vec3 H = normalize(uSunDir - dir);
    float spec = pow(max(dot(N, H), 0.0), 400.0);
    water += uSunColor * uSunIntensity * spec * 0.35 * step(0.0, dot(up, uSunDir));

    // Shoreline foam, only where the sea floor is nearly at the surface.
    // Foam only right at the waterline. Widening this at all turns the whole
    // continental shelf white, because a shelf on this planet is only metres
    // deep across kilometres of coast.
    if (hitScene && depth < 1.2) {
      float band = smoothstep(1.0, 0.05, depth);
      float churnScale = 1.0 - smoothstep(0.08, 0.5, (sea.x / uProjScale));
      float churn = mix(0.5, fbm3(surface * 2.2 + vec3(uTime * 0.35)), churnScale);
      float foam = band * smoothstep(0.38, 0.86, churn + band * 0.18);
      water = mix(water, vec3(0.82, 0.89, 0.93) * (0.25 + 0.75 * shade), foam * 0.6);
    }

    color = water;
    occluderDist = sea.x;
  }

  /* --- Atmosphere ------------------------------------------------------- */
  vec2 atmo = raySphere(uCameraPos, dir, uAtmosphereRadius);
  if (atmo.y > 0.0) {
    float tMin = max(atmo.x, 0.0);
    float tMax = min(atmo.y, occluderDist);
    vec3 inscatter;
    vec3 transmittance;
    scatter(uCameraPos, dir, tMin, tMax, inscatter, transmittance);
    color = color * transmittance + inscatter;
  }

  gl_FragColor = vec4(color, 1.0);
}
`;
