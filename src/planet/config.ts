/**
 * Global planet constants.
 *
 * One world unit is roughly one metre. The planet is deliberately small — a
 * pocket planet — which is both the theme and the thing that makes zooming all
 * the way from orbit down to a person standing in a field technically
 * tractable: the whole dynamic range fits comfortably inside 32-bit floats.
 */

/** Planet radius at sea level, in world units. */
export const PLANET_RADIUS = 1000;

/** Highest peaks above sea level. */
export const MAX_ELEVATION = 26;

/** Deepest ocean trenches below sea level. */
export const MAX_DEPTH = 22;

/**
 * Top of the visible atmosphere shell.
 *
 * Generous compared to Earth's, and deliberately so — see the scale height
 * discussion in compositeShader.ts. The shell only has to bound the raymarch;
 * almost all of the density sits in the lowest fifth of it.
 */
export const ATMOSPHERE_RADIUS = PLANET_RADIUS * 1.55;

/** Cloud deck altitude, as a multiple of the radius. */
export const CLOUD_RADIUS = PLANET_RADIUS * 1.0125;

/** Vertices per side of a terrain patch. Must be (power of two) + 1. */
export const PATCH_GRID = 33;

/**
 * Deepest quadtree level. Level 9 gives roughly 14 cm vertex spacing, which is
 * finer than the smallest feature the terrain function produces — below this,
 * subdividing adds vertices without adding shape, and the fragment-level
 * detail noise takes over.
 */
export const MAX_LOD_LEVEL = 9;

/**
 * Screen-space error budget, in pixels.
 *
 * A patch subdivides when the on-screen size of its worst geometric error
 * exceeds this. Expressing LOD in pixels rather than in world distance means
 * the same setting behaves correctly on a phone and on a desktop monitor, at
 * any field of view, without retuning.
 */
export const LOD_PIXEL_ERROR = 3.5;

/** Camera altitude limits above the terrain surface. */
export const MIN_ALTITUDE = 1.6;
export const MAX_ALTITUDE = PLANET_RADIUS * 4.5;

/** Resolution of the equirectangular planet data texture (height/moisture/temp). */
export const DATA_TEX_WIDTH = 2048;
export const DATA_TEX_HEIGHT = 1024;

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualitySettings {
  tier: QualityTier;
  patchGrid: number;
  maxLodLevel: number;
  /** Screen-space error budget in pixels. Larger means fewer triangles. */
  pixelError: number;
  /** Soft ceiling on simultaneously visible terrain patches. */
  patchBudget: number;
  /** Primary raymarch steps in the atmosphere pass. */
  atmosphereSteps: number;
  /** Secondary (towards-sun) raymarch steps in the atmosphere pass. */
  atmosphereLightSteps: number;
  bloom: boolean;
  clouds: boolean;
  /** Raymarch steps through the cloud deck. */
  cloudSteps: number;
  /** Steps towards the sun per cloud sample, for self-shadowing. */
  cloudLightSteps: number;
  /** Render scale multiplier applied to the device pixel ratio. */
  renderScale: number;
  maxPixelRatio: number;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low',
    patchGrid: 17,
    maxLodLevel: 7,
    pixelError: 9,
    patchBudget: 120,
    atmosphereSteps: 6,
    atmosphereLightSteps: 3,
    bloom: false,
    clouds: true,
    cloudSteps: 7,
    cloudLightSteps: 2,
    renderScale: 0.85,
    maxPixelRatio: 1.5,
  },
  medium: {
    tier: 'medium',
    patchGrid: 25,
    maxLodLevel: 8,
    pixelError: 5.5,
    patchBudget: 190,
    atmosphereSteps: 10,
    atmosphereLightSteps: 4,
    bloom: true,
    clouds: true,
    cloudSteps: 11,
    cloudLightSteps: 3,
    renderScale: 1,
    maxPixelRatio: 2,
  },
  high: {
    tier: 'high',
    patchGrid: PATCH_GRID,
    maxLodLevel: MAX_LOD_LEVEL,
    pixelError: LOD_PIXEL_ERROR,
    patchBudget: 280,
    atmosphereSteps: 16,
    atmosphereLightSteps: 6,
    bloom: true,
    clouds: true,
    cloudSteps: 16,
    cloudLightSteps: 4,
    renderScale: 1,
    maxPixelRatio: 2,
  },
};

/** Pick a starting quality tier from what the device tells us about itself. */
export function detectQuality(): QualityTier {
  if (typeof navigator === 'undefined') return 'high';
  const cores = navigator.hardwareConcurrency ?? 4;
  const coarsePointer =
    typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  if (coarsePointer && cores <= 6) return 'low';
  if (coarsePointer) return 'medium';
  if (cores <= 4) return 'medium';
  return 'high';
}
