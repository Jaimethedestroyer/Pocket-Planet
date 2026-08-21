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
uniform vec3 uCameraRight;
uniform vec3 uCameraUp;
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
uniform float uTanHalfFov;

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
 * One band of the wave stack.
 *
 * The weight argument is how much of this band survives at the current pixel
 * footprint. A band is either large enough to resolve — in which case it is
 * animated and contributes a real gradient — or it is gone. Nothing is ever
 * drawn at a frequency the screen cannot represent, which is what keeps an
 * ocean seen at a grazing angle from turning into crawling speckle.
 *
 * Single-octave value noise per band, not fBm: the stack already provides the
 * octaves, and four texture-free samples a band is affordable in a fullscreen
 * pass where twelve would not be.
 */
vec3 waveBand(vec3 pos, float lambda, float speed, vec3 drift, float weight) {
  if (weight <= 0.003) return vec3(0.0);
  float f = 6.2831853 / lambda;
  vec3 q = pos * f + drift * (uTime * speed);
  const float e = 0.28;
  float n0 = vnoise(q);
  vec3 g = vec3(
    vnoise(q + vec3(e, 0.0, 0.0)) - n0,
    vnoise(q + vec3(0.0, e, 0.0)) - n0,
    vnoise(q + vec3(0.0, 0.0, e)) - n0);
  return g * (weight / e);
}

/**
 * How much of a wavelength survives at this pixel footprint.
 *
 * A wave needs several pixels across it to read as a wave rather than as
 * noise, so a band is gone well before it reaches one pixel — the cutoff is at
 * roughly four pixels per wavelength, not one.
 */
float bandWeight(float lambda, float footprint) {
  return 1.0 - smoothstep(lambda * 0.06, lambda * 0.22, footprint);
}

/** Trowbridge-Reitz, for a sun glint that widens as waves go sub-pixel. */
float ggx(float ndh, float rough) {
  float a = rough * rough;
  float a2 = a * a;
  float d = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 1e-7);
}

struct Water {
  vec3 normal;
  float roughness;
};

/**
 * The sea surface: an animated normal plus the roughness of everything too
 * small to animate.
 *
 * The second half matters as much as the first. Waves below a pixel do not
 * vanish physically, they become microfacets — so as each band fades out of the
 * normal it is folded into the roughness instead, and the sun's reflection
 * broadens from a hard spark into the wide glitter path an ocean actually shows
 * from altitude. Without it the sea is a mirror the moment you climb, which is
 * the single most obvious tell that water is being faked.
 */
Water seaSurface(vec3 pos, vec3 up, vec3 dir, float dist) {
  float grazing = max(dot(up, -dir), 0.05);
  float footprint = (dist / uProjScale) / grazing;

  // Long swell, wind chop, and surface ripple.
  float wSwell = bandWeight(18.0, footprint);
  float wChop = bandWeight(4.5, footprint);
  float wRipple = bandWeight(1.1, footprint);

  vec3 grad = vec3(0.0);
  grad += waveBand(pos, 18.0, 0.9, vec3(0.7, 0.2, 0.6), wSwell);
  grad += waveBand(pos, 4.5, 2.1, vec3(-0.5, 0.1, 0.85), wChop * 0.45);
  grad += waveBand(pos, 1.1, 4.5, vec3(0.9, 0.0, -0.4), wRipple * 0.2);

  // Project out the component along the normal so a wave stays a wave.
  grad -= up * dot(grad, up);

  Water w;
  // Kept small on purpose. The water is shaded through a Fresnel term raised
  // to the fifth power, and at the grazing angles you see most of an ocean at,
  // that turns a modest slope into a huge swing in reflectance — a normal
  // strong enough to look right head-on stipples the whole sea at the horizon.
  w.normal = normalize(up + grad * 0.16);
  // Whatever faded out of the geometry reappears as microfacet roughness.
  float resolved = (wSwell * 0.25 + wChop * 0.3 + wRipple * 0.45);
  w.roughness = mix(0.34, 0.045, resolved);
  return w;
}

/**
 * How far the tide has run up the beach, 0..1.
 *
 * A slow surge, out of phase from one stretch of coast to the next so the whole
 * planet does not breathe in unison. This is what animates a shoreline at zoom
 * levels where individual waves are far too small to see: the waterline itself
 * moves.
 */
float shoreSurge(vec3 pos) {
  float phase = vnoise(pos * 0.012) * 6.2831853;
  return 0.5 + 0.5 * sin(uTime * 0.55 + phase);
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
    Water w = seaSurface(surface, up, dir, sea.x);
    vec3 N = w.normal;

    // How much water the ray passes through before reaching the sea floor.
    float depth = hitScene ? (sceneDist - sea.x) : (sea.y - sea.x);
    depth = max(depth, 0.0);

    // Refraction. The sea floor is displaced by the surface slope, which is
    // what makes shallow water shimmer. The offset is scaled by depth so it
    // vanishes exactly at the waterline — otherwise it drags land colour out
    // across the shore and fringes every beach.
    vec3 slope = N - up;
    // Apparent displacement of the floor, in metres, converted to a UV offset:
    // the frustum spans 2*tan(fov/2)*distance world units vertically.
    float disp = 0.4 * min(depth, 3.0);
    vec2 offset = vec2(dot(slope, uCameraRight), dot(slope, uCameraUp))
                * disp / (2.0 * uTanHalfFov * max(sea.x, 1.0));
    offset = clamp(offset, vec2(-0.03), vec2(0.03));
    vec3 floorColor = texture2D(tScene, vUv + offset).rgb;

    // Absorption: the floor's colour is progressively replaced by the water's
    // own. The lengths are tuned to this planet's bathymetry, not Earth's —
    // the deepest trench here is 22 m — but kept deliberately soft, because a
    // sharp ramp turns a one-metre LOD wobble in the sea floor into a visible
    // band of colour crawling along the coast.
    const vec3 SHALLOW = vec3(0.055, 0.30, 0.33);
    const vec3 DEEP    = vec3(0.003, 0.026, 0.072);
    float absorb = 1.0 - exp(-depth * 0.24);
    vec3 body = mix(floorColor * vec3(0.44, 0.76, 0.84), SHALLOW, absorb);
    body = mix(body, DEEP, 1.0 - exp(-depth * 0.085));

    float shade = clamp(dot(up, uSunDir) * 1.4 + 0.12, 0.0, 1.0);
    body *= mix(0.10, 1.0, shade);

    // Fresnel towards a simple sky tint. A reflection probe is not worth it
    // here: at these angles the sky is close to uniform anyway.
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, -dir), 0.0), 5.0);
    vec3 skyTint = mix(vec3(0.16, 0.28, 0.46), vec3(0.55, 0.70, 0.95), shade);
    vec3 water = mix(body, skyTint * (0.25 + 0.75 * shade), fres * 0.85);

    // Sun glint, broadening with the roughness the wave stack handed back.
    vec3 H = normalize(uSunDir - dir);
    float glint = ggx(max(dot(N, H), 0.0), w.roughness);
    water += uSunColor * uSunIntensity * glint * 0.035
           * step(0.0, dot(up, uSunDir)) * fres;

    /* --- Surf ------------------------------------------------------------ */
    if (hitScene && depth < 3.2) {
      float surge = shoreSurge(surface);
      // The waterline itself advances and retreats, which is what reads as
      // motion at zoom levels where a single wave is far below a pixel.
      float reach = mix(0.5, 1.9, surge);
      float band = smoothstep(reach, 0.0, depth);

      // Broken water, scrolling shoreward and stretched along the coast.
      float footprint = sea.x / uProjScale;
      float churnDetail = 1.0 - smoothstep(0.05, 0.45, footprint);
      float churn = mix(
        0.55,
        vnoise(surface * 1.9 + vec3(0.0, uTime * 0.9, 0.0)) * 0.6
          + vnoise(surface * 5.5 - vec3(uTime * 1.7, 0.0, 0.0)) * 0.4,
        churnDetail);

      float foam = band * smoothstep(0.32, 0.86, churn + band * 0.30);
      // A thin bright lip right at the edge, always present regardless of the
      // noise, so the waterline never disappears entirely between surges.
      foam = max(foam, smoothstep(0.35, 0.0, depth) * 0.55);

      vec3 foamColor = vec3(0.86, 0.92, 0.95) * (0.28 + 0.72 * shade);
      water = mix(water, foamColor, clamp(foam, 0.0, 1.0) * 0.8);
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
