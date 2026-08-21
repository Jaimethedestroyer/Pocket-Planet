# Where Pocket Planet goes next

Ordered by what it buys, not by what is interesting to build. The planet and the
simulation both work; almost everything below is about closing the gap between *a
world that runs* and *a game someone wants to keep on their phone*.

Each item carries a rough size — **S** is a sitting, **M** is a day or two, **L** is a
week — and what it actually gets you.

---

## The one big gap

**You cannot touch your world.** Every interaction today goes through six sliders. You
cannot tap a city, follow a war, or look at the empire that just collapsed. That is the
difference between a simulation you watch and a place you visit, and it is worth more
than any amount of extra shader work.

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

### 2. Tap to inspect · **M**

Tap a city: its name, founding year, population, who rules it, what it has lived
through. Tap open ground: the terrain, the climate, who claims it. Tap a chronicle line:
the camera flies to where it happened.

Ray-cast the tap against the sea sphere for a world direction, then find the nearest
simulation cell — cheap, and exactly what the invisible cell graph is already for. The
fly-to camera is the same rig with an eased target.

This turns the chronicle from a ticker into a set of doorways.

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

### Wonders and ruins as landmarks · **M**
Great works that persist through collapse and show as distinct markers. Excellent
chronicle material, gives ruins a reason to be found, and makes a planet's history
visible in its geography.

### Ground detail: buildings, roads and citizens · **L**

The milestone deliberately left alone, and the one where the 3D-or-2D question
actually matters. The answer differs per thing, and one rule decides it:

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

### Terrain detail textures · **M**
Procedural grain gets the ground surprisingly far, but triplanar grass, rock and sand at
close range would sharpen everything below about two hundred metres.

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

1. Real-device performance pass — before building anything else on top of unknowns
2. Timeline scrubber — the demo, and nearly free
3. Tap to inspect — closes the interaction gap
4. Named rulers — cheapest chronicle improvement available
5. Capacitor wrap, notifications, onboarding — make it a thing people can actually keep
6. Trade routes, rivers, wonders — depth, in whatever order stays interesting
