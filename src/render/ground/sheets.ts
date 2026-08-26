/**
 * The pre-rendered sprite sheets, and the one place they are loaded.
 *
 * This file is a deliberate exception to the rule stated at the top of
 * `textures.ts`. Everything else in the game is drawn from code, and that is
 * still the right default — but a person and a tree are the two things the
 * player gets close enough to actually look at, and no amount of canvas
 * primitives makes a stick figure read as somebody walking home. The sheets in
 * `src/assets/sprites/` are pre-rendered 3D, which buys believable anatomy and
 * real bark for about three hundred kilobytes of PNG that loads in parallel
 * with the terrain and is cached forever after.
 *
 * Two consequences follow from them being finished art rather than masks:
 *
 * **They are sRGB.** Every other texture here is uploaded as `NoColorSpace`
 * because it carries masks, not colour. These carry colour, so they are
 * decoded to linear on sample like any other albedo — the scene is linear all
 * the way to the tone map.
 *
 * **Their transparent pixels are black**, which is what mipmapping a cutout
 * turns into a dark fringe around every leaf at fifty metres. `dilate` bleeds
 * the edge colour outwards into the transparent margin before the mips are
 * built, so a half-covered texel averages leaf-and-leaf rather than
 * leaf-and-black. It is a couple of milliseconds once, at load.
 *
 * Nothing here blocks the frame loop. Each texture exists immediately, holding
 * a single transparent pixel, and is filled in when its image arrives; the boot
 * screen waits on `spritesReady` so that in practice nobody sees the gap.
 */

import * as THREE from 'three';

import vegetationUrl from '../../assets/sprites/vegetation.png';
import peoplePrimitiveUrl from '../../assets/sprites/people-primitive.png';
import peopleAncientUrl from '../../assets/sprites/people-ancient.png';
import peopleMedievalUrl from '../../assets/sprites/people-medieval.png';
import peopleIndustrialUrl from '../../assets/sprites/people-industrial.png';
import fireUrl from '../../assets/sprites/fire-light.png';
import smokeUrl from '../../assets/sprites/war-smoke.png';
import bannerUrl from '../../assets/sprites/war-banner.png';
import projectileUrl from '../../assets/sprites/war-projectile.png';
import impactUrl from '../../assets/sprites/war-impact.png';

/** Frames in the people walk cycle, and columns in the people sheets. */
export const WALK_FRAMES = 6;

/** Era rows in the combined people atlas: primitive, ancient, medieval, industrial. */
export const PEOPLE_ROWS = 4;

/** Cells across the fire sheet: campfire, torch, brazier, chimney smoke. */
export const FIRE_CELLS = 4;

/** Stages in the smoke column and in the dust impact. */
export const SMOKE_FRAMES = 4;
export const IMPACT_FRAMES = 4;

export interface SpriteSheets {
  /** 256 x 256: broadleaf, conifer over crop, scrub. */
  vegetation: THREE.Texture;
  /** 288 x 320: six walk frames across, one era per row. */
  people: THREE.Texture;
  /** 256 x 64: campfire, torch, brazier, chimney smoke. */
  fire: THREE.Texture;
  /** 512 x 128: four stages of a rising column. */
  smoke: THREE.Texture;
  /** 64 x 64: a pennant, shaded, to be tinted with the polity's colour. */
  banner: THREE.Texture;
  /** 32 x 32: one arrow, drawn stretched along its flight. */
  projectile: THREE.Texture;
  /** 256 x 64: four stages of a dust burst. */
  impact: THREE.Texture;
}

function context(width: number, height: number): CanvasRenderingContext2D {
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  const ctx = el.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas unavailable');
  return ctx;
}

/**
 * Bleed opaque colour outwards into the transparent margin.
 *
 * Alpha is untouched — the shader still cuts the silhouette exactly where it
 * did. All this changes is what a filtered or mipmapped sample finds *outside*
 * the silhouette, which without it is the black the packager left there.
 */
function dilate(image: ImageData, passes: number): ImageData {
  const { width, height, data } = image;
  const rgb = new Uint8ClampedArray(data);
  /** Which pixels have a colour worth copying: opaque, or filled by a pass. */
  const have = new Uint8Array(width * height);
  for (let i = 0; i < have.length; i++) have[i] = data[i * 4 + 3] > 0 ? 1 : 0;

  for (let pass = 0; pass < passes; pass++) {
    const grew: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (have[p]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const q = ny * width + nx;
            if (!have[q]) continue;
            r += rgb[q * 4];
            g += rgb[q * 4 + 1];
            b += rgb[q * 4 + 2];
            n++;
          }
        }
        if (n === 0) continue;
        rgb[p * 4] = r / n;
        rgb[p * 4 + 1] = g / n;
        rgb[p * 4 + 2] = b / n;
        grew.push(p);
      }
    }
    // Marked only after the whole pass, so the ring grows one texel at a time
    // and the result does not depend on the scan order.
    for (const p of grew) have[p] = 1;
  }

  for (let p = 0; p < have.length; p++) {
    data[p * 4] = rgb[p * 4];
    data[p * 4 + 1] = rgb[p * 4 + 1];
    data[p * 4 + 2] = rgb[p * 4 + 2];
  }
  return image;
}

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`sprite sheet failed to load: ${url}`));
    img.src = url;
  });
}

/** One transparent pixel, so a texture is never uploaded without an image. */
function blank(): HTMLCanvasElement {
  return context(1, 1).canvas;
}

let outstanding = 0;
let failed = false;

/**
 * True once every sheet has arrived — or once one of them has failed, since
 * waiting forever on a missing file would hold the boot screen up for good.
 */
export function spritesReady(): boolean {
  return outstanding === 0 || failed;
}

/**
 * Declare a sheet, start fetching it, and hand back the texture now.
 *
 * `draw` composes the loaded images into the sheet's final layout — which for
 * everything but the people atlas is a straight blit, and for the people atlas
 * is four era sheets stacked into rows.
 */
function sheet(
  urls: string[],
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, images: HTMLImageElement[]) => void,
  mips: boolean,
): THREE.Texture {
  const texture = new THREE.Texture(blank());
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = mips;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  outstanding++;
  Promise.all(urls.map(load))
    .then((images) => {
      const ctx = context(width, height);
      draw(ctx, images);
      const pixels = ctx.getImageData(0, 0, width, height);
      ctx.putImageData(dilate(pixels, 4), 0, 0);
      texture.image = ctx.canvas;
      texture.needsUpdate = true;
    })
    .catch((error) => {
      failed = true;
      console.warn(error);
    })
    .finally(() => {
      outstanding--;
    });

  return texture;
}

function blit(ctx: CanvasRenderingContext2D, images: HTMLImageElement[]): void {
  ctx.drawImage(images[0], 0, 0);
}

let sheets: SpriteSheets | null = null;

/**
 * The sheets, loaded once and shared by every layer that draws them.
 *
 * A singleton rather than something the layers each own, because the people
 * atlas alone would otherwise be built four times over for the four eras and
 * the war layers would fetch the same smoke twice.
 */
export function spriteSheets(): SpriteSheets {
  if (sheets) return sheets;
  sheets = {
    vegetation: sheet([vegetationUrl], 256, 256, blit, true),
    // The four era sheets stacked, so a street full of people from three
    // different centuries is still one draw call.
    people: sheet(
      [peoplePrimitiveUrl, peopleAncientUrl, peopleMedievalUrl, peopleIndustrialUrl],
      WALK_FRAMES * 48,
      PEOPLE_ROWS * 80,
      (ctx, images) => {
        for (let row = 0; row < PEOPLE_ROWS; row++) ctx.drawImage(images[row], 0, row * 80);
      },
      true,
    ),
    fire: sheet([fireUrl], 256, 64, blit, false),
    smoke: sheet([smokeUrl], 512, 128, blit, true),
    banner: sheet([bannerUrl], 64, 64, blit, true),
    projectile: sheet([projectileUrl], 32, 32, blit, false),
    impact: sheet([impactUrl], 256, 64, blit, false),
  };
  return sheets;
}
