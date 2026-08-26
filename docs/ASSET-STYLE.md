# Sprite and asset style guide

For whoever or whatever is producing sprite art for Pocket Planet — currently
Codex. This is a specification, not a mood board: the shaders that consume
these sheets make hard assumptions about size, layout and what each colour
channel means, and a sheet that ignores them renders as garbage rather than as
slightly-wrong art.

Read the **Non-negotiables** section even if you read nothing else.

---

## Where this stands

Every sheet described below now exists, in `src/assets/sprites/`, and every one
of them is in the game. They came back as **pre-rendered 3D converted to
billboards** rather than as flat masks, and that decision — taken deliberately,
at the user's direction — reverses two of the rules this document originally
opened with. What is written here is the contract as the shaders actually
implement it now, not the contract that was asked for.

| Sheet | File | Drawn by |
|---|---|---|
| People, four eras | `people-*.png` | `render/ground/people.ts` |
| Vegetation | `vegetation.png` | `render/ground/props.ts` |
| Fire and light | `fire-light.png` | `render/ground/fires.ts` |
| Smoke column | `war-smoke.png` | `render/ground/war.ts` |
| Banner | `war-banner.png` | `render/ground/banners.ts` |
| Arrow, impact | `war-projectile.png`, `war-impact.png` | `render/ground/war.ts` |

All of them are loaded once, in `render/ground/sheets.ts`, which also decides
their colour space and bleeds their edge colour into the transparent margin
before the mipmaps are built. Read that file before adding a sheet.

---

## Non-negotiables

1. **~~Channels carry masks, not colour.~~ Sheets carry finished colour.** This
   is the rule that was reversed. The delivered sheets are photographic, so
   there is no garment channel to dye and no luminance channel to tint. What the
   shaders do instead is a **wash**: the polity's colour, or the plant's, is
   scaled to the sprite's own brightness and mixed in at about a fifth, which
   shifts the hue and leaves the modelling alone. It is enough to tell two
   towns' crowds apart and enough to keep a wood from being one photograph
   repeated; it is not enough to make a blue kingdom's people wear blue.
   A **new** sheet may still be delivered as masks — say so, and it needs its
   own shading path.
2. **Alpha is coverage and it is thresholded, not blended.** Vegetation
   discards below `0.42`, people below `0.40`, banners below `0.40`. Feathered
   edges below the threshold vanish; feathered edges above it turn into hard
   steps. Keep the alpha ramp inside about two pixels of the silhouette edge,
   and keep the interior solidly at 1.0. Fire, smoke and dust are the exception
   and are genuinely blended.
3. **~~No baked lighting.~~ Form lighting only, and no cast shadow.** The other
   reversed rule. A pre-rendered billboard needs its own three-quarter form
   lighting or it has no dimension at all, and the shaders here light it as a
   standing cylinder rather than as a flat card, which is compatible with it. A
   painted *ground* shadow is still wrong — the shadow layer draws those — and
   so is ambient occlusion against a surface the sprite is not standing on.
   Fire is exempt from all of this: a fire is the light.
4. **No outlines.** Nothing in this game has an outline. An outline is a baked
   light decision and it fights the atmospheric perspective.
5. **Power-of-two dimensions, tightly specified below.** These are packed into
   fixed atlas grids and the shader computes tile offsets arithmetically.
6. **Silhouette first.** Everything here is between eight and fifty pixels tall
   in practice. If it does not read at 30 px it does not read, and interior
   detail spent below that is wasted.
7. **Colour is sRGB and transparent pixels are still colour.** These sheets are
   uploaded as `SRGBColorSpace` and decoded to linear on sample, unlike the
   procedural masks that came before them. Whatever colour sits under a
   transparent pixel is what a mipmapped sample finds at the silhouette edge, so
   `sheets.ts` dilates the edge outwards on load; do not rely on it to rescue a
   sheet that is black everywhere it is not opaque.

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

Four sheets, one per era, in `src/assets/sprites/people-*.png`. They are stacked
into a single 288 × 320 atlas at load — one era per row, primitive at the top —
so a region holding towns from three centuries is still one draw call, and the
era is a per-person attribute picking the row.

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

RGB is finished albedo; A is coverage, thresholded at 0.40.

The polity's colour arrives as a 22% wash held to the sprite's own luminance,
and a per-person modulation about one varies what each figure catches of the
light — without it a street is one figure printed sixty times. Neither of those
can recover detail the sheet does not have, so light the figure yourself, from
three quarters, with no cast shadow on the ground.

### Variants worth having beyond the walk cycle

Lower priority, but each is a visible upgrade to a town:

- **Idle** (2 frames): standing, small weight shift. Most people in a town are
  not walking anywhere.
- **Carry** (6 frames): the same walk with a load, for market streets.
- **Work** (4 frames): a bend-and-rise, for fields.

---

## Sheet 2 — Vegetation

`src/assets/sprites/vegetation.png`. Consumed as **crossed quads** — two cards at
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

RGB is finished albedo; A is coverage, thresholded at 0.42.

`albedo = rgb * tint`, where `tint` is a per-plant modulation about one that
`style.ts` → `foliageTint` derives from the ground's moisture: drier ground
yellows and pales a canopy, wetter ground deepens it. The luminance of RGB
doubles as canopy density for the transmission term, so keep a canopy lighter
towards the top and darker underneath — the sun always comes from above, and
that one gradient still does most of the work.

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

## Sheet 3 — Fire and light

`src/assets/sprites/fire-light.png`, drawn by `render/ground/fires.ts`.
Primitive and ancient settlements used to glow from window emission, which was
wrong twice over: a hut has no glazing, and a civilization that has not invented
the lamp should read as *sparks in the dark* rather than as a dim version of a
modern town. Their `lamps` value is now near nothing and this sheet is what
lights them.

**256 × 64, four cells of 64 × 64** — and note that they are four *objects*,
not four frames of one animation, which is what the original spec asked for:

- **Campfire** — an open fire, flames flickering across the four frames.
- **Torch** — a smaller, steadier flame for a wall bracket or a gate.
- **Brazier** — a contained fire, for ancient civic spaces.
- **Chimney smoke** — a soft rising plume, for medieval and industrial roofs.

### Channels

**RGB is emission and A is coverage**, for the first three cells. These are the
one genuine exception to the no-baked-light rule: a fire *is* the light. Author
them warm (1.0, 0.7, 0.35 through 1.0, 0.35, 0.1) and let the bloom pass do the
glare — do not paint a halo, the pipeline already has one.

The chimney cell is not emissive: it is lit by the sun and the sky like any
other surface, and it is the one cell in the sheet that has to read by *day*.

Because the sheet is four objects rather than four frames, there is nothing to
play, and the flicker is synthesised: the vertex shader stretches, narrows and
leans each flame on three frequencies that do not divide into each other, so it
never visibly repeats. If a future sheet does carry frames, say so — the flicker
belongs in the shape, and a fire that only pulses in intensity reads as a
blinking light.

---

## Sheet 4 — War

Wars used to exist in the simulation and be invisible on the planet. The
settlement a war is fought over — the closest pair across the two belligerents'
territories, worked out in `detail.ts` — now burns, and is shot at.

- **Arrow / projectile** — `war-projectile.png`, 32 × 32, drawn stretched along
  its velocity on a real ballistic arc. Its RGB is used as albedo, flat-lit.
- **Impact** — `war-impact.png`, 4 frames of 64 × 64, a dust puff, alpha
  blended. Grey by design: it is tinted with a ground colour so the burst reads
  as *this* ground being thrown up.
- **Smoke column** — `war-smoke.png`, 4 stages of 128 × 128 for a burning
  settlement. Cross-faded rather than cut between, because at the size these are
  seen a hard change of silhouette reads as strobing, and thinned towards the
  top of the card in the shader.
- **Banner cloth** — `war-banner.png`, 64 × 64. Its luminance is kept as the
  folds and its hue replaced with the polity's, so a blue kingdom's flag is
  still cloth rather than a flat blue triangle. The mast is a second, untextured
  card in the same geometry.

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
npm run shot -- town town-street city-street   # people and plants at 40 m
npm run shot -- town town-night city-night     # fire and lamps after dark
KIT=4 npm run shot -- kit-prop                 # props at close range
```

`town-street` and `town-night` carry no years of their own, so name a shot that
does — `town` is the cheapest — ahead of them, or the run photographs an empty
planet.

Look at `docs/shots/`. If a sprite is not legible in those frames it is not
legible in the game.
