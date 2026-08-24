# Generated sprite sheets

These PNGs were generated with Codex's built-in image generation tool, then
mechanically packaged by `tools/package-generated-sprites.ps1` to preserve the
atlas dimensions and cell layouts in `docs/ASSET-STYLE.md`.

This is the guide's second-choice delivery form and deliberately breaks the
project's current "nothing ships as an asset" invariant. At the user's
direction, it also overrides the mask-only and no-baked-light rules: a realistic
pre-rendered 3D billboard needs full color and dimensional form lighting. The
renderer still uses the procedural atlases in `src/render/ground/textures.ts`;
these files are ready source assets for the later integration pass.

| File | Layout | Encoding |
|---|---:|---|
| `people-primitive.png` | 288 × 80, 6 × 48 × 80 | full-color RGB, A coverage |
| `people-ancient.png` | 288 × 80, 6 × 48 × 80 | full-color RGB, A coverage |
| `people-medieval.png` | 288 × 80, 6 × 48 × 80 | full-color RGB, A coverage |
| `people-industrial.png` | 288 × 80, 6 × 48 × 80 | full-color RGB, A coverage |
| `vegetation.png` | 256 × 256, 2 × 2 tiles | full-color RGB, A coverage |
| `fire-light.png` | 256 × 64, 4 × 64 × 64 | RGB emission, A coverage |
| `war-projectile.png` | 32 × 32 | full-color RGB, A coverage |
| `war-impact.png` | 256 × 64, 4 × 64 × 64 | grayscale RGB, A coverage |
| `war-smoke.png` | 512 × 128, 4 × 128 × 128 | grayscale RGB, A coverage |
| `war-banner.png` | 64 × 64 | full-color RGB, A coverage |

## Final prompt set

Shared direction: realistic pre-rendered 3D models converted into gritty,
digitized 1990s first-person-game billboard sprites; believable anatomy and
tactile materials; full-color RGBA; strong silhouettes readable at 8–80 pixels;
transparent blank backgrounds; controlled three-quarter form lighting with no
cast ground shadow; no labels, dividers, scenery, watermarks or cartoon outlines.

- Primitive people: one consistent side-view adult in hides and furs, bare
  limbs, bundle and short spear, across a six-pose looping walk cycle.
- Ancient people: the same cycle and framing, with draped tunic/robe, sandals,
  head cloth and water jar.
- Medieval people: the same cycle and framing, with belted tunic, cloak/hood,
  apron, basket and compact hand tool.
- Industrial people: the same cycle and framing, with long coat, trousers,
  sturdy shoes, cap, satchel and closed umbrella.
- Vegetation: strict 2 × 2 atlas of realistic broadleaf, conifer, crops and
  scrub, rooted to each tile's bottom edge.
- Fire/light: campfire, torch flame, brazier flame and chimney-smoke plume in a
  four-cell strip, with no painted glow halo.
- Projectile: one material-rich left-to-right stone-tipped arrow for velocity
  stretching.
- Impact: four stages from a tight dust burst through expansion to dissipation.
- Smoke: four stages of a rooted burning-settlement smoke column.
- Banner: one shaded, weathered crimson wool pennant without a pole or emblem.

The packaging pass resizes each source cell independently, extracts true alpha
from model-painted backgrounds, removes disconnected artifacts, fixes every
walk-cycle foot baseline at row 76, aligns vegetation roots to the bottom of
their tiles, and preserves the pre-rendered color and form lighting.
