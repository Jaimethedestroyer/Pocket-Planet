/**
 * Procedural sprite atlases.
 *
 * Nothing in this game ships an image file, and that is not asceticism — it is
 * what keeps the whole build a couple of hundred kilobytes and loading instantly
 * over a phone connection. These two atlases are drawn into a canvas at
 * start-up in well under a millisecond each.
 *
 * Both encode masks in the colour channels rather than finished colour, so one
 * texture serves every culture, every biome and every skin: the shader picks
 * the actual colours per instance and multiplies them by the masks. A green
 * texture would have made every tree on the planet the same green.
 */

import * as THREE from 'three';
import { makeRng } from '../../core/rng';

function canvas(width: number, height: number): CanvasRenderingContext2D {
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  const ctx = el.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

function finish(ctx: CanvasRenderingContext2D, mips: boolean): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(ctx.canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = mips;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** Tile size of the vegetation atlas, which is two by two. */
const VEG_TILE = 128;

/**
 * Vegetation. Red is luminance, alpha is coverage.
 *
 * Four tiles: broadleaf, conifer, crop rows, scrub. The whole point of a
 * crossed quad is that it holds up when you walk past it, so the silhouettes
 * matter far more than the interiors — a broadleaf is a lumpy dome, a conifer
 * is a spiky triangle, and you can tell which is which from fifty metres at
 * eight pixels tall.
 */
export function vegetationAtlas(): THREE.CanvasTexture {
  const ctx = canvas(VEG_TILE * 2, VEG_TILE * 2);
  const rng = makeRng(0x5eed1eaf);

  const blob = (x: number, y: number, r: number, lum: number): void => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const l = Math.round(lum * 255);
    g.addColorStop(0, `rgba(${l},${l},${l},1)`);
    g.addColorStop(0.72, `rgba(${l},${l},${l},1)`);
    g.addColorStop(1, `rgba(${l},${l},${l},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  // --- Broadleaf, top left -------------------------------------------------
  ctx.save();
  ctx.translate(0, 0);
  ctx.fillStyle = 'rgba(88,88,88,1)';
  ctx.beginPath();
  ctx.moveTo(VEG_TILE * 0.46, VEG_TILE);
  ctx.lineTo(VEG_TILE * 0.545, VEG_TILE);
  ctx.lineTo(VEG_TILE * 0.53, VEG_TILE * 0.42);
  ctx.lineTo(VEG_TILE * 0.475, VEG_TILE * 0.42);
  ctx.closePath();
  ctx.fill();
  for (let i = 0; i < 46; i++) {
    const a = rng.next() * Math.PI * 2;
    const r = Math.pow(rng.next(), 0.6);
    const x = VEG_TILE * 0.5 + Math.cos(a) * r * VEG_TILE * 0.36;
    const y = VEG_TILE * 0.36 + Math.sin(a) * r * VEG_TILE * 0.25;
    // Lighter towards the top: the sun comes from above, always.
    const lum = 0.5 + (1 - y / (VEG_TILE * 0.7)) * 0.45 + rng.range(-0.08, 0.08);
    blob(x, y, VEG_TILE * rng.range(0.09, 0.16), Math.min(1, Math.max(0.25, lum)));
  }
  ctx.restore();

  // --- Conifer, top right --------------------------------------------------
  ctx.save();
  ctx.translate(VEG_TILE, 0);
  ctx.fillStyle = 'rgba(80,80,80,1)';
  ctx.fillRect(VEG_TILE * 0.47, VEG_TILE * 0.72, VEG_TILE * 0.06, VEG_TILE * 0.28);
  for (let tier = 0; tier < 6; tier++) {
    const t = tier / 5;
    const y = VEG_TILE * (0.12 + t * 0.66);
    const halfWidth = VEG_TILE * (0.08 + t * 0.31);
    const lum = 0.85 - t * 0.4;
    ctx.fillStyle = `rgba(${(lum * 255) | 0},${(lum * 255) | 0},${(lum * 255) | 0},1)`;
    ctx.beginPath();
    ctx.moveTo(VEG_TILE * 0.5, y - VEG_TILE * 0.14);
    for (let i = 0; i <= 9; i++) {
      const u = i / 9;
      const spike = i % 2 === 0 ? 1 : 0.82;
      ctx.lineTo(
        VEG_TILE * 0.5 + (u * 2 - 1) * halfWidth * spike,
        y + VEG_TILE * 0.06 * (i % 2 === 0 ? 1 : 0.5),
      );
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // --- Crop rows, bottom left ---------------------------------------------
  ctx.save();
  ctx.translate(0, VEG_TILE);
  for (let i = 0; i < 34; i++) {
    const x = rng.range(VEG_TILE * 0.06, VEG_TILE * 0.94);
    const h = rng.range(VEG_TILE * 0.42, VEG_TILE * 0.78);
    const lean = rng.range(-0.1, 0.1) * VEG_TILE;
    const lum = rng.range(0.55, 1.0);
    ctx.strokeStyle = `rgba(${(lum * 255) | 0},${(lum * 255) | 0},${(lum * 255) | 0},1)`;
    ctx.lineWidth = rng.range(2.2, 4.4);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, VEG_TILE);
    ctx.quadraticCurveTo(x + lean * 0.4, VEG_TILE - h * 0.6, x + lean, VEG_TILE - h);
    ctx.stroke();
  }
  ctx.restore();

  // --- Scrub, bottom right -------------------------------------------------
  ctx.save();
  ctx.translate(VEG_TILE, VEG_TILE);
  for (let i = 0; i < 26; i++) {
    const x = rng.range(VEG_TILE * 0.14, VEG_TILE * 0.86);
    const y = VEG_TILE - rng.range(0, VEG_TILE * 0.1);
    blob(x, y - VEG_TILE * 0.12, VEG_TILE * rng.range(0.07, 0.13), rng.range(0.35, 0.8));
  }
  ctx.restore();

  return finish(ctx, true);
}

/** Frames in the walk cycle. Six is the classic minimum that still reads. */
export const WALK_FRAMES = 6;
const PERSON_W = 48;
const PERSON_H = 80;

/**
 * People.
 *
 * Red is the clothes mask, green is skin, blue is hair and shadow, alpha is
 * coverage — so one atlas dresses a whole planet. Six frames of a walk cycle at
 * forty-eight pixels wide, which is more than a person thirty pixels tall on a
 * phone will ever need.
 *
 * There is no attempt at anatomy here and there should not be. At this size the
 * only things that carry are the silhouette, the fact that the legs alternate,
 * and the small vertical bob — that last one is what the eye actually reads as
 * walking.
 */
export function peopleAtlas(): THREE.CanvasTexture {
  const ctx = canvas(PERSON_W * WALK_FRAMES, PERSON_H);
  ctx.lineCap = 'round';

  for (let f = 0; f < WALK_FRAMES; f++) {
    const ox = f * PERSON_W;
    const phase = (f / WALK_FRAMES) * Math.PI * 2;
    const swing = Math.sin(phase);
    const bob = Math.abs(Math.cos(phase)) * 2.2;

    const cx = ox + PERSON_W * 0.5;
    const top = 8 + bob;

    // Legs, behind the body.
    ctx.strokeStyle = 'rgba(60,20,140,1)';
    ctx.lineWidth = 7;
    for (const side of [-1, 1]) {
      const s = swing * side;
      ctx.beginPath();
      ctx.moveTo(cx, top + 40);
      ctx.lineTo(cx + s * 7, top + 54);
      ctx.lineTo(cx + s * 11, top + 68);
      ctx.stroke();
    }

    // Arms.
    ctx.strokeStyle = 'rgba(200,40,30,1)';
    ctx.lineWidth = 5.5;
    for (const side of [-1, 1]) {
      const s = -swing * side;
      ctx.beginPath();
      ctx.moveTo(cx, top + 20);
      ctx.lineTo(cx + s * 6, top + 30);
      ctx.lineTo(cx + s * 9, top + 40);
      ctx.stroke();
    }

    // Torso: the clothes mask.
    ctx.fillStyle = 'rgba(230,30,20,1)';
    ctx.beginPath();
    ctx.moveTo(cx - 8, top + 18);
    ctx.lineTo(cx + 8, top + 18);
    ctx.lineTo(cx + 9, top + 42);
    ctx.lineTo(cx - 9, top + 42);
    ctx.closePath();
    ctx.fill();

    // Hands and neck: the skin mask.
    ctx.fillStyle = 'rgba(20,230,20,1)';
    ctx.fillRect(cx - 3, top + 13, 6, 6);
    for (const side of [-1, 1]) {
      const s = -swing * side;
      ctx.beginPath();
      ctx.arc(cx + s * 9, top + 41, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Head, then hair over the back of it.
    ctx.beginPath();
    ctx.arc(cx, top + 8, 7.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(20,30,220,1)';
    ctx.beginPath();
    ctx.arc(cx, top + 5.5, 7.5, Math.PI * 1.02, Math.PI * 2.1);
    ctx.fill();
  }

  return finish(ctx, true);
}
