# Where Pocket Planet goes next

Ordered by what it buys, not by what is interesting to build. The planet and the
simulation both work; almost everything below is about closing the gap between *a
world that runs* and *a game someone wants to keep on their phone*.

Each item carries a rough size — **S** is a sitting, **M** is a day or two, **L** is a
week — and what it actually gets you.

---

## The one big gap — closed

**You could not touch your world.** Every interaction went through six sliders: you could
not tap a city, follow a war, or look at the empire that had just collapsed.

That is done. A tap opens whatever is under it — a town's name, age, ruler and history;
open ground's climate and who claims it — and chronicle lines that know where they
happened fly the camera there. What remains of this thread is the timeline scrubber
below, which is the same idea aimed at *when* rather than *where*.

---

## Tier 1 — do these next

### 1. Timeline scrubber: replay the whole history · **M**

Drag through three thousand years and watch borders bloom, fracture and reform. Sun
sweeping, cities lighting up, empires eating each other, in twenty seconds.

This is the trailer shot, the contest submission's first fifteen seconds, and the thing
nobody else's entry has — and it is *nearly free*, because the simulation is already
deterministic and already replayable. It is the payoff for a property that has so far
only been a correctness guarantee.

Mechanism: the worker keeps a ring of keyframes — the owner array (8 KB), the settlement
list, and the tick — every 25 years. Two and a half megabytes covers three thousand
years. Scrubbing repaints the territory field from a keyframe instead of re-simulating,
so it is instant and smooth in both directions. Only the *display* rewinds; the
simulation itself never moves backwards.

### 2. Tap to inspect · **done**

A tap opens whatever is under it, and chronicle lines that know where they happened fly
the camera there.

What was not obvious going in: picking cannot be a raycast against geometry. A settlement
is four pixels wide from orbit and is nearly always what the player is aiming at, so the
tap is tested against settlement markers in *screen space* with a generous radius,
weighted by tier so a metropolis beats the village sharing its pixel — and only falls
back to the ground when nothing is in reach. And a fly-to has to slerp the target
direction rather than lerp its components, or the camera cuts through the planet.

What remains: the camera does not yet follow anything. A war between two states you are
watching should be followable without chasing it by hand.

### 3. Clouds · **done**

A raymarched volumetric deck above the terrain: self-shadowing, casting moving
shadows on the ground, drifting with the wind, adjustable from clear to overcast.

What remains here is to drive coverage from the simulation's own moisture and
temperature fields, so that a drought actually looks like one and the wet belts sit
where the climate model already says they are.

### 4. Trade routes and roads · **M**

At mid zoom there is nothing between "coloured territory blob" and "dot of a city". Arcs
between trading settlements — thin, glowing at night, thickening with volume, dimming
when a war closes them — fill that gap and make the Trade dial visible for the first
time.

Needs trade routes to become real objects in the simulation rather than an aggregate
number, which is worth doing anyway.

### 5. Named rulers and dynasties · **S**

"Under Queen Vashti the Elder, the granaries were filled." Best chronicle quality per
hour of work in the whole project. Names already generate per culture; a ruler needs a
name, a reign, and one trait that nudges a policy.

---

## Tier 2 — real gains, less urgent

### Rivers · **M**
Planned in the original design and never built. Flow accumulation over the cell graph,
rendered as a line network. Improves terrain believability *and* gives settlements a
reason to be where they are — river mouths and confluences instead of "wherever
habitability was highest".

### Sea ice at the poles · **S**
Right now the ocean runs to the pole unfrozen while the land beside it is under snow. A
temperature-driven white overlay on the water fixes an obvious wrongness cheaply.

### City lights by era · **S**
They already read well. Firelight orange for primitive, lamp yellow for medieval, a cold
white-blue for industrial — so the *age* of a civilization is legible from orbit at a
glance, at nearly zero cost.

### Wonders and ruins as landmarks · **done**
A rich, stable, established state raises a great work — a ziggurat, a great temple, a
cathedral, a citadel, a colossus, a clock — at its largest city, spends a treasury on it,
and does not build another for three centuries. A world produces somewhere between five
and thirty in three thousand years.

They belong to the **cell**, not to the settlement or the state, which is the whole
point: a wonder outlives both. A city that empties leaves its ziggurat standing over the
ruins, and a resettlement nine hundred years later inherits it. Tapping one tells you
what it is, what year it went up, and which long-dead state paid for it.

Two things this needed that were not obvious. The first attempt gated on the *capital
cell's* population and produced three wonders in three thousand years, because on a graph
of four thousand cells a capital cell holds a few thousand people and successor states
reuse the same prime cells — so once one had a wonder, nothing could ever be built there
again. And the settlement tiers had to be rescaled: they ran to a hundred and eighty
thousand people on a graph where a cell tops out near nine thousand, so half of every
planet was a hamlet, the other half a village, and *city*, *great city* and *metropolis*
were words that could never be true of anywhere.

### Ground detail: buildings, roads and citizens · **done**

Built, and the rule below held up exactly as written. What follows is the original
reasoning, kept because it is still the right way to decide the question, followed by
what the build actually taught.

> **Billboard anything small, numerous, and roughly the same from every side.
> Model anything with a footprint you can walk around.**

A billboard is a flat card that turns to face the camera. That is invisible for a
person thirty pixels tall, and instantly wrong for a building — because a building
is fixed to the ground, and the moment you orbit it a card either turns with you,
so the building appears to spin in place, or it does not, so you see a flat sheet
edge on. Buildings also have to occlude each other and take the sun correctly, and
geometry gives both for free.

| Thing | Form | Why |
|---|---|---|
| **People** | **Billboards**, animated sprite sheets | Thirty pixels tall and roughly symmetric. A four-to-eight-frame walk cycle is indistinguishable from 3D at that size, and thousands cost one draw call. This is exactly where the sprite-sheet plan fits. |
| **Small buildings** — huts, houses, workshops | **Instanced 3D**, 10–30 triangles each | A box and a prism roof. One instanced draw call for a whole town, varied per instance by scale, rotation and colour. Fixed to the ground, so they have to be real geometry. |
| **Large structures** — palaces, temples, wonders | **3D**, from a parts kit | There are few of them, so they can afford detail, and they are the landmarks a player navigates by. |
| **Roads** | **Ribbon geometry** draped on the terrain | A strip mesh following the path, sampled against the height field. Not sprites — a road has to sit *on* the ground, following every rise. |
| **Trees, crops, rubble** | **Crossed quads** — two billboards at right angles | The classic middle ground: holds up when you walk past, unlike a single card, at a fraction of a model's cost. |

Scale note: this planet has a one-kilometre radius, so a person is 1.7 m against a
6 km circumference — roughly a person against a small town on Earth. That is why
citizens only need to exist in the closest LOD band, and why a settlement's sprite
stays the right representation everywhere above it.

Build order: buildings first, because they are what makes a town read as a town;
then roads between them; then people last, because people only pay off in the final
few metres of a descent and everything else reads from much higher up.

**What the build taught.**

*Streets before buildings.* The build order above is right for the systems and wrong for
the layout. Scattering buildings and then connecting them gives a road network that looks
like a road network and a town that does not look like a town, because a real settlement
is frontage on a route. Laying the route first and hanging buildings off it gets
terraces, corners and squares for free.

*Tolerances are the whole game.* The first planner rejected any slope over eleven degrees
and any ground under a metre above sea level. Both sound conservative. Both are brutal:
settlements go where habitability is highest, habitability rewards coasts, and coasts are
exactly the low uneven ground those two rules throw away. It built beautiful empty
streets.

*A left-handed instance basis is a lighting bug that is not one.* With east x north = up,
the obvious frame (east*c + north*s, up, fwd) has determinant minus one — a mirror rather
than a rotation — so every model renders inside out, front faces culled and every normal
pointing into the building.

*Buildings need indirect light that terrain does not.* Terrain is draped over a sphere and
almost all of it faces the sky. A building is four vertical walls and one always faces
away from the sun; with only the terrain's ambient, that wall is not shadowed, it is
black.

**Still open here.** Buildings cast a sheared quad rather than a real shadow, which is
right for the cost but shows on a low sun. Towns are denser than they were and still
thinner than they should be at the top tiers. And the general ground scatter below is
still the missing half of "land detail": vegetation exists around towns and nowhere
else.

### Terrain detail textures · **M**
Procedural grain gets the ground surprisingly far, but triplanar grass, rock and sand at
close range would sharpen everything below about two hundred metres.

### Vegetation away from towns · **M**
Trees, crops and scrub exist in a ring around every settlement and nowhere else, so a
wilderness is bare ground. The instanced crossed-quad layer is already built; what it
needs is a scatter tied to the terrain LOD patches rather than to the town planner, which
is a different and larger problem: it has to be stable as patches split and merge.

---

## Tier 3 — shipping

### Real-device performance pass · **M** · *do this before Tier 1 finishes*
Every number in this repo was measured under software rasterisation. Nothing is known
about how it behaves on an actual mid-range Android phone: thermal throttling, fill rate
on the atmosphere raymarch, worker scheduling, memory. This is the single largest
unknown in the project, and it gets more expensive to discover the longer it waits.

### Capacitor wrap and Play internal test · **M**
The build is already a static site. Wrapping it is mostly configuration, an icon set,
and a signing key. Worth doing early for the same reason as above: to find out what
breaks.

### Local notifications · **S**
"143 years have passed. The Northern Empire has collapsed." This is what makes a
put-it-down game a come-back-to game, and it needs the Capacitor wrap.

### RevenueCat · **S**
Required for Shipaton. The honest monetization here is cosmetic — planet themes, more
simultaneous worlds, a longer offline cap — not anything that gates the simulation.

### Onboarding · **S**
Sixty seconds explaining that you set priorities rather than give orders, that collapse
is not failure, and that the world keeps running when you leave.

---

## Deliberately not doing

- **More eras** (Modern, Atomic, Spacefaring). Tempting, cheap-looking, and wrong: the
  four existing eras are not yet distinct enough to justify a fifth.
- **Units and armies you can move.** It would make this a different, worse, much larger
  game.
- **An LLM.** Still out. See `PLAN.md`.
- **Multiplayer.** Not at any price.

---

## Suggested order

1. Real-device performance pass — before building anything else on top of unknowns, and
   more urgent now than it was: the ground detail added instanced geometry, alpha-tested
   foliage and a transparent shadow pass, none of which has been seen on a phone
2. Timeline scrubber — the demo, and nearly free
3. Named rulers — cheapest chronicle improvement available
4. Capacitor wrap, notifications, onboarding — make it a thing people can actually keep
5. Trade routes, rivers, wonders that persist — depth, in whatever order stays interesting
