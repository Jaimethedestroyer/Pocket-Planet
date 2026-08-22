# Sprite and asset style guide

For whoever or whatever is producing sprite art for Pocket Planet — currently
Codex. This is a specification, not a mood board: the shaders that consume
these sheets make hard assumptions about size, layout and what each colour
channel means, and a sheet that ignores them renders as garbage rather than as
slightly-wrong art.

Read the **Non-negotiables** section even if you read nothing else.

---

## Non-negotiables

1. **Channels carry masks, not colour.** Every sheet here is tinted per
   instance at draw time. A green tree texture makes every tree on the planet
   the same green; a brown-skinned person sheet makes every person on the
   planet the same. See the per-sheet channel tables below.
2. **Alpha is coverage and it is thresholded, not blended.** Vegetation
   discards below `0.42`, people below `0.40`. Feathered edges below the
   threshold vanish; feathered edges above it turn into hard steps. Keep the
   alpha ramp inside about two pixels of the silhouette edge, and keep the
   interior solidly at 1.0.
3. **No baked lighting, no baked shadow, no ambient occlusion.** The shader
   lights these. A sprite with a painted-in shadow is lit twice and reads as
   dirty at dawn and inverted at dusk. Flat masks only.
4. **No outlines.** Nothing in this game has an outline. An outline is a baked
   light decision and it fights the atmospheric perspective.
5. **Power-of-two dimensions, tightly specified below.** These are packed into
   fixed atlas grids and the shader computes tile offsets arithmetically.
6. **Silhouette first.** Everything here is between eight and fifty pixels tall
   in practice. If it does not read at 30 px it does not read, and interior
   detail spent below that is wasted.

---

## The world these live in

Scale matters more here than in most games because the planet is small.

- Planet radius **1000 m**; circumference about 6.3 km.
- A person is **1.75 m** tall — against a 6 km world, roughly a person against
  a small town on Earth.
- A house is 5–8 m across. A cathedral spire is 41 m. A castle is 40 m square.
- Camera altitudes that matter: **20–40 m** (street level), **100–300 m** (a
  town), **600–1500 m** (a region), above that the ground detail is gone.
- People are only drawn within **260 m** of the camera; vegetation within
  **620 m**. Beyond that they scale to zero.

Colour is **linear**, not sRGB. Textures are uploaded with
`colorSpace = NoColorSpace` because they are masks. Tone mapping and colour
conversion happen once, in the final composite pass.

Art direction: **stylised-realistic, desaturated, silhouette-led.** Closer to a
good strategy game's zoomed-in view than to pixel art or to cartoon. Palettes
are muted because saturation comes back through the atmosphere and tone mapping
later; anything authored saturated ends up lurid.

---

## Sheet 1 — People

Replaces the placeholder in `src/render/ground/textures.ts` → `peopleAtlas()`.

### Current placeholder

One sheet, six frames of a walk cycle, 48 × 80 px per frame, 288 × 80 total.
Drawn with canvas primitives — a stick figure with a bobbing head. It works and
it looks like what it is.

### What is wanted

**One sheet per era**, four sheets total, same geometry:

| Era | Dress |
|---|---|
| Primitive | Hides and furs, bare limbs, carried bundles, spear silhouettes |
| Ancient | Draped tunics and robes, sandals, head cloths, water jars |
| Medieval | Belted tunics, cloaks and hoods, aprons, baskets, tool shapes |
| Industrial | Long coats, hats and caps, trousers, bags, umbrellas |

### Layout

```
288 x 80 px, six frames left to right, each 48 x 80
frame 0 .. frame 5 = one full walk cycle, looping
```

The figure occupies roughly the middle 26 px of each 48 px frame and spans y
8..76 of the 80. Keep the feet on a consistent baseline across frames — a
figure that slides vertically reads as skating. A 2–3 px vertical bob on the
off-beat is what actually sells walking at this size.

### Channels

| Channel | Means | Tinted with |
|---|---|---|
| **R** | Clothing | Per-person garment colour, mixed 32% toward the polity's colour |
| **G** | Skin | One of four per-person skin tones |
| **B** | Hair and deep shadow | Fixed dark `(0.09, 0.07, 0.06)` |
| **A** | Coverage | — |

The shader normalises: `albedo = (cloth*R + skin*G + dark*B) / (R+G+B)`. So the
three mask channels should be roughly **mutually exclusive** — a pixel is
cloth, or skin, or hair, not a blend of all three. Overlap desaturates.

Do not paint folds or shading into the masks. Put a garment's *shape* in R and
let the light do the rest.

### Variants worth having beyond the walk cycle

Lower priority, but each is a visible upgrade to a town:

- **Idle** (2 frames): standing, small weight shift. Most people in a town are
  not walking anywhere.
- **Carry** (6 frames): the same walk with a load, for market streets.
- **Work** (4 frames): a bend-and-rise, for fields.

---

## Sheet 2 — Vegetation

Replaces `vegetationAtlas()`. Consumed as **crossed quads** — two cards at
right angles — so each tile is seen edge-on half the time. Silhouette is
everything; interior detail is nearly free to omit.

### Layout

```
256 x 256 px, four tiles of 128 x 128

  +-----------+-----------+
  | broadleaf | conifer   |   <- canvas top row
  +-----------+-----------+
  | crop      | scrub     |   <- canvas bottom row
  +-----------+-----------+
```

The texture is uploaded with `flipY` on, so the canvas top row is `v` in
[0.5, 1]. Tile index in the shader: `kind` 0 = broadleaf, 1 = crop,
2 = conifer, 3 = scrub, with `col = floor(kind/2)`, `row = kind % 2`.

Each plant is rooted at the **bottom edge** of its tile and grows upward. Leave
no gap at the bottom — a tree that floats is immediately obvious.

### Channels

| Channel | Means |
|---|---|
| **R** | Luminance / density. `albedo = tint * (0.45 + R * 0.85)` |
| **A** | Coverage |

G and B are unused. Put the leaf-mass variation in R: lighter towards the top
of a canopy, darker underneath, because the sun always comes from above. That
one gradient does most of the work.

### World sizes

| Tile | Drawn at | Where |
|---|---|---|
| broadleaf | 3.0–7.0 m | Temperate and damp ground |
| conifer | 3.0–7.0 m | Anywhere below 0.36 temperature |
| crop | 1.5–2.3 m | Cleared ground inside a town's field ring |
| scrub | 1.4–2.8 m | Dry or hot-and-dry ground |

### Wanted beyond the current four

- **Palm** and **dead/bare** tiles — the tropics and the treeline both
  currently borrow the wrong silhouette.
- A second broadleaf and second conifer variant, so a wood is not one shape
  repeated. Two of each is enough; the crossed-quad rotation hides more
  repetition than you would expect.

---

## Sheet 3 — Fire and light (not yet built)

The next pass needs this. Primitive and ancient settlements currently glow from
window emission, which is wrong twice over: a hut has no glazing, and a
civilization that has not invented the lamp should read as *sparks in the dark*
rather than as a dim version of a modern town.

### Wanted

A small additive sheet, **256 × 64, four frames of 64 × 64**, looping:

- **Campfire** — an open fire, flames flickering across the four frames.
- **Torch** — a smaller, steadier flame for a wall bracket or a gate.
- **Brazier** — a contained fire, for ancient civic spaces.
- **Chimney smoke** — a soft rising plume, for medieval and industrial roofs.

### Channels

Additive, so **RGB is emission and A is coverage**. These are the one exception
to the no-baked-light rule: a fire *is* the light. Author them warm
(1.0, 0.7, 0.35 through 1.0, 0.35, 0.1) and let the bloom pass do the glare —
do not paint a halo, the pipeline already has one.

Flicker should be in the *shape* across frames, not only in brightness. A fire
that only pulses in intensity reads as a blinking light.

---

## Sheet 4 — War (not yet built)

Wars exist in the simulation and are invisible on the planet. The smallest
thing that changes that:

- **Arrow / projectile** — a single 32 × 32 sprite, drawn stretched along its
  velocity. Silhouette only; the shader tints it.
- **Impact** — 4 frames of 64 × 64, a dust puff. Alpha-blended, not additive.
- **Smoke column** — 4 frames of 128 × 128, for a burning settlement, rising
  and thinning.
- **Banner cloth** — 64 × 64, a mask for a waving pennant. R = cloth mask so it
  takes the polity colour like every other banner in the game.

---

## Delivery

Two acceptable forms, in order of preference:

1. **Canvas-drawing code**, in the style of `src/render/ground/textures.ts` —
   a function that takes a 2D context and draws the sheet. This keeps the
   "nothing ships as an asset" invariant, keeps the build small, and lets the
   sheets be re-tuned without a round trip. Deterministic: use the project's
   `makeRng` from `src/core/rng.ts`, never `Math.random()`.
2. **PNG files** at the exact dimensions above, in `src/assets/`, with the
   channel layout respected. Accept that this breaks the no-assets invariant
   and is a deliberate trade — say so if you take this route.

Either way, name things after what they are (`peopleAtlas('medieval')`,
`fireAtlas()`), and put the *why* in a comment above the function, not a
description of what the code plainly does.

### How to check your work

```bash
npm run build
npm run shot -- town-street city-street     # people and plants at 40 m
npm run shot -- town-night city-night       # fire and lamps after dark
KIT=4 npm run shot -- kit-prop              # props at close range
```

Look at `docs/shots/`. If a sprite is not legible in those frames it is not
legible in the game.
