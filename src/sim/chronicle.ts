/**
 * The chronicle: structured events rendered as readable history.
 *
 * A template grammar, not a language model. It is deterministic, instant, free,
 * works offline, and costs nothing per player — and because the phrasing is
 * chosen by hashing the event rather than by a running random number, the same
 * event always reads the same way, even after a save is reloaded and the log is
 * re-rendered from the middle.
 */

import { makeRng, mixSeed } from '../core/rng';
import { CollapseKind, CrisisKind, ERA_NAMES } from './types';
import type { SimEvent } from './types';
import type { Simulation } from './sim';

type Templates = Record<string, string[]>;

const TEMPLATES: Templates = {
  founded: [
    'The first stones of {polity} are laid.',
    'In a green valley, {polity} takes root.',
    'A people gather, and name themselves {polity}.',
  ],
  era: [
    'The {era} age begins in {polity}.',
    'The {era} age dawns over {polity}.',
    'Scholars of {polity} usher in the {era} age.',
  ],
  settlement: [
    'The town of {place} is founded under {polity}.',
    'Settlers of {polity} raise {place}.',
    'The banners of {polity} rise over the new town of {place}.',
  ],
  resettled: [
    '{place} is raised again from ruins, under {polity}.',
    'After long silence, {polity} resettles the ruins at {place}.',
    'The old stones at {place} are cleared, and {polity} builds anew.',
  ],
  'crisis-famine': [
    'Famine grips {polity}. The granaries stand open and empty.',
    'The harvest fails across {polity}, and hunger follows.',
    'Three lean years in a row. {polity} starves.',
  ],
  'crisis-plague': [
    'A plague moves along the trade roads of {polity}.',
    'Sickness sweeps {polity}. The roads are closed, too late.',
    'Pestilence takes hold in {polity}.',
  ],
  'crisis-civil-war': [
    'Civil war breaks out in {polity}.',
    'Rebellion tears through {polity}.',
    'Two claimants, one throne. Blood is shed across {polity}.',
  ],
  'crisis-ecological': [
    'The soil of {polity} gives out. The rivers run foul.',
    'Poisoned land and dying rivers across {polity}.',
    'What {polity} took from the land, the land stops giving.',
  ],
  war: ['War is declared by {polity} upon {other}.', 'War between {polity} and {other}.'],
  peace: [
    'After {years} years, {polity} and {other} lay down arms.',
    'Peace at last between {polity} and {other}, {years} years on.',
  ],
  'collapse-fragmentation': [
    'Collapse comes to {polity}. {count} successor states rise from its territory.',
    'The centre of {polity} fails. What remains breaks into {count} rival states.',
    'After {age} years, {polity} is gone. {count} successors divide the land.',
  ],
  'collapse-wasteland': [
    'The fall of {polity} empties the land. Only ruins remain.',
    'The last of {polity} scatters. Its cities are left to the weather.',
    'After {age} years, nothing of {polity} remains, and nothing rises to replace it.',
  ],
  'collapse-conquest': ['The whole of {polity} is swallowed by its neighbours.'],
  succession: ['The rulers of {polity} declare themselves the true heirs of {other}.'],
  schism: ['The faith of {polity} splits. {religion} is proclaimed.'],
  'religion-born': ['{religion} is first preached in {polity}.'],
  'culture-born': ['A new people emerge from the ruins of {polity}: the {culture}.'],
  'golden-age': ['{polity} enters a golden age.'],
};

function templateKey(event: SimEvent): string {
  if (event.kind === 'crisis') return `crisis-${event.detail ?? CrisisKind.Famine}`;
  if (event.kind === 'collapse') return `collapse-${event.detail ?? CollapseKind.Wasteland}`;
  return event.kind;
}

/** Render one event as a sentence. */
export function renderEvent(sim: Simulation, event: SimEvent): string {
  const key = templateKey(event);
  const options = TEMPLATES[key];
  if (!options || options.length === 0) return '';

  // Phrasing is chosen by hashing the event, not by drawing from a running
  // generator: re-rendering an old log must produce the same words.
  const rng = makeRng(mixSeed(event.tick * 2654435761, (event.polity ?? 0) * 97 + key.length));
  const template = options[rng.int(0, options.length)];

  const polity = event.polity !== undefined ? sim.polities[event.polity] : undefined;
  const other = event.otherPolity !== undefined ? sim.polities[event.otherPolity] : undefined;
  const religion = event.religion !== undefined ? sim.religions[event.religion] : undefined;
  const culture = event.culture !== undefined ? sim.cultures[event.culture] : undefined;

  const text = template
    .replace(/\{polity\}/g, polity?.name ?? 'a forgotten people')
    .replace(/\{other\}/g, other?.name ?? 'a rival')
    .replace(/\{religion\}/g, religion?.name ?? 'a new faith')
    .replace(/\{culture\}/g, culture?.name ?? 'a new people')
    .replace(/\{place\}/g, event.detail ?? 'a nameless place')
    .replace(/\{era\}/g, ERA_NAMES[event.value ?? 0] ?? 'new')
    .replace(/\{count\}/g, String(event.count ?? 0))
    .replace(/\{years\}/g, String(event.value ?? 0))
    .replace(/\{age\}/g, String(polity ? polity.ended - polity.founded : 0));

  // Polity names begin with a lowercase article ("the Kingdom of ..."), which
  // is right mid-sentence and wrong at the start of one.
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface ChronicleLine {
  tick: number;
  text: string;
  weight: number;
}

/** Render the most significant events in a span of history. */
export function chronicle(
  sim: Simulation,
  fromTick: number,
  toTick: number,
  limit = 40,
): ChronicleLine[] {
  const lines: ChronicleLine[] = [];
  for (const event of sim.events) {
    if (event.tick < fromTick || event.tick > toTick) continue;
    const text = renderEvent(sim, event);
    if (text) lines.push({ tick: event.tick, text, weight: event.weight });
  }
  if (lines.length <= limit) return lines;

  // Keep the most significant, then restore chronological order — a digest
  // that jumps about in time is not a history.
  return lines
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .sort((a, b) => a.tick - b.tick);
}

/**
 * The "while you were away" summary: a headline plus the few events that most
 * deserve to interrupt someone who has just opened the app.
 */
export function digest(sim: Simulation, sinceTick: number, limit = 5): string[] {
  const years = sim.tick - sinceTick;
  const head =
    years <= 0
      ? 'No time has passed.'
      : `${years} year${years === 1 ? '' : 's'} have passed.`;
  const lines = chronicle(sim, sinceTick + 1, sim.tick, limit).map((l) => l.text);
  return [head, ...lines];
}
