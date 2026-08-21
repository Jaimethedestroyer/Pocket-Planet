/**
 * The game's interface.
 *
 * Plain DOM over the canvas. Text, panels and controls belong in the document,
 * where they get real typography, accessibility and hit-testing for free, and
 * where changing the layout does not mean touching a shader.
 *
 * Built for a phone held in one hand: everything interactive sits within reach
 * of a thumb along the bottom edge, and the planet keeps the whole screen.
 */

import { POLICIES } from '../sim/types';
import { ERA_NAMES } from '../sim/types';
import { polityColor } from '../sim/protocol';
import type { SimClient } from '../game/simClient';

const SPEEDS = [
  { label: 'II', value: 0, title: 'Pause' },
  { label: '1x', value: 4, title: '4 years a second' },
  { label: '3x', value: 14, title: '14 years a second' },
  { label: '9x', value: 45, title: '45 years a second' },
];

const POLICY_LABELS: Record<string, string> = {
  trade: 'Trade',
  war: 'War',
  education: 'Learning',
  expansion: 'Expansion',
  conservation: 'Conservation',
  culture: 'Culture',
};

const POLICY_HINTS: Record<string, string> = {
  trade: 'Wealth and contact with neighbours. Also how plague travels.',
  war: 'Armies and conquest, paid for in treasury and in war weariness.',
  education: 'The pace of discovery, and the road to the next age.',
  expansion: 'Appetite for new land. Sprawl beyond what you can administer.',
  conservation: 'Keeps the soil alive and the air clean for the generation after.',
  culture: 'Contentment at home, and how far your way of life spreads.',
};

function formatPopulation(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return n.toFixed(0);
}

export class Hud {
  readonly root: HTMLDivElement;

  private sim: SimClient;
  private yearEl: HTMLElement;
  private statsEl: HTMLElement;
  private stateNameEl: HTMLElement;
  private stateMetaEl: HTMLElement;
  private stateSwatch: HTMLElement;
  private feedEl: HTMLElement;
  private policyPanel: HTMLElement;
  private digestPanel!: HTMLElement;
  private policyRows: { name: string; fill: HTMLElement; value: HTMLElement }[] = [];
  private speedButtons: HTMLButtonElement[] = [];

  private renderedChronicle = 0;
  private policiesOpen = false;
  private currentSpeed = 4;

  constructor(sim: SimClient) {
    this.sim = sim;
    this.root = document.createElement('div');
    this.root.id = 'hud-game';
    this.root.innerHTML = `
      <div class="pp-top">
        <div class="pp-year"><b id="pp-year">Year 0</b><span id="pp-stats"></span></div>
      </div>

      <div class="pp-feed" id="pp-feed"></div>

      <div class="pp-dock">
        <button class="pp-btn pp-policy-toggle" id="pp-policy-toggle">
          <span class="pp-swatch" id="pp-swatch"></span>
          <span class="pp-state">
            <b id="pp-state-name">—</b>
            <i id="pp-state-meta"></i>
          </span>
        </button>
        <div class="pp-speeds" id="pp-speeds"></div>
      </div>

      <div class="pp-digest" id="pp-digest" hidden>
        <div class="pp-digest-inner">
          <b id="pp-digest-head"></b>
          <div id="pp-digest-lines"></div>
          <button class="pp-btn pp-digest-ok" id="pp-digest-ok">Continue</button>
        </div>
      </div>

      <div class="pp-policies" id="pp-policies" hidden>
        <div class="pp-policies-head">
          <b>Priorities</b>
          <span>Six shares of one people's attention. Raising one lowers the rest.</span>
        </div>
        <div id="pp-policy-list"></div>
      </div>
    `;

    this.yearEl = this.root.querySelector('#pp-year')!;
    this.statsEl = this.root.querySelector('#pp-stats')!;
    this.stateNameEl = this.root.querySelector('#pp-state-name')!;
    this.stateMetaEl = this.root.querySelector('#pp-state-meta')!;
    this.stateSwatch = this.root.querySelector('#pp-swatch')!;
    this.feedEl = this.root.querySelector('#pp-feed')!;
    this.policyPanel = this.root.querySelector('#pp-policies')!;
    this.digestPanel = this.root.querySelector('#pp-digest')!;
    this.root.querySelector('#pp-digest-ok')!.addEventListener('click', () => {
      this.digestPanel.setAttribute('hidden', '');
    });

    this.buildSpeeds();
    this.buildPolicies();

    this.root.querySelector('#pp-policy-toggle')!.addEventListener('click', () => {
      this.policiesOpen = !this.policiesOpen;
      this.policyPanel.toggleAttribute('hidden', !this.policiesOpen);
    });
  }

  private buildSpeeds(): void {
    const host = this.root.querySelector('#pp-speeds')!;
    for (const speed of SPEEDS) {
      const btn = document.createElement('button');
      btn.className = 'pp-btn pp-speed';
      btn.textContent = speed.label;
      btn.title = speed.title;
      btn.addEventListener('click', () => {
        this.currentSpeed = speed.value;
        this.sim.setSpeed(speed.value);
        this.syncSpeeds();
      });
      host.appendChild(btn);
      this.speedButtons.push(btn);
    }
    this.syncSpeeds();
  }

  private syncSpeeds(): void {
    this.speedButtons.forEach((btn, i) => {
      btn.classList.toggle('on', SPEEDS[i].value === this.currentSpeed);
    });
  }

  private buildPolicies(): void {
    const host = this.root.querySelector('#pp-policy-list')!;
    POLICIES.forEach((name, index) => {
      const row = document.createElement('div');
      row.className = 'pp-policy';
      row.innerHTML = `
        <div class="pp-policy-head">
          <b>${POLICY_LABELS[name]}</b><span class="pp-policy-value">0.0</span>
        </div>
        <div class="pp-track"><span class="pp-fill"></span></div>
        <i class="pp-hint">${POLICY_HINTS[name]}</i>
      `;
      const track = row.querySelector('.pp-track') as HTMLElement;
      const fill = row.querySelector('.pp-fill') as HTMLElement;
      const value = row.querySelector('.pp-policy-value') as HTMLElement;

      const setFromEvent = (clientX: number): void => {
        const rect = track.getBoundingClientRect();
        const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        // The dial's own share of a fixed budget; the simulation renormalises
        // the others, so pushing one up necessarily pulls the rest down.
        this.sim.setPolicy(index, t * 3.5);
      };

      let dragging = false;
      track.addEventListener('pointerdown', (e) => {
        dragging = true;
        track.setPointerCapture(e.pointerId);
        setFromEvent(e.clientX);
      });
      track.addEventListener('pointermove', (e) => {
        if (dragging) setFromEvent(e.clientX);
      });
      const stop = (): void => {
        dragging = false;
      };
      track.addEventListener('pointerup', stop);
      track.addEventListener('pointercancel', stop);

      host.appendChild(row);
      this.policyRows.push({ name, fill, value });
    });
  }

  /**
   * The welcome-back card, shown once when returning to a world that kept
   * running. This is the whole point of the game's shape: the interesting part
   * is not what you did, it is what happened while you were not watching.
   */
  showDigest(lines: string[]): void {
    if (lines.length === 0) return;
    const [head, ...rest] = lines;
    this.root.querySelector('#pp-digest-head')!.textContent = head;
    const host = this.root.querySelector('#pp-digest-lines')!;
    host.innerHTML = '';
    if (rest.length === 0) {
      const el = document.createElement('p');
      el.textContent = 'The world turned quietly.';
      host.appendChild(el);
    }
    for (const line of rest) {
      const el = document.createElement('p');
      el.textContent = line;
      host.appendChild(el);
    }
    this.digestPanel.removeAttribute('hidden');
  }

  /** Called whenever the simulation reports new state. */
  update(): void {
    const sim = this.sim;
    this.yearEl.textContent = `Year ${sim.tick}`;
    this.statsEl.textContent =
      `${formatPopulation(sim.totalPopulation)} people · ` +
      `${sim.livingPolities} state${sim.livingPolities === 1 ? '' : 's'}`;

    const player = sim.player();
    if (player) {
      const [r, g, b] = polityColor(player.hue);
      this.stateSwatch.setAttribute(
        'style',
        `background: rgb(${(r * 255) | 0}, ${(g * 255) | 0}, ${(b * 255) | 0})`,
      );
      this.stateNameEl.textContent = player.name;
      this.stateMetaEl.textContent =
        `${ERA_NAMES[player.era]} · ${formatPopulation(player.population)} · ` +
        `${Math.round(player.stability * 100)}% settled`;

      this.policyRows.forEach((row, i) => {
        const v = player.policies[i] ?? 0;
        row.fill.setAttribute('style', `width: ${Math.min(100, (v / 3.5) * 100).toFixed(1)}%`);
        row.value.textContent = v.toFixed(1);
      });
    }

    // Append only what is new: rebuilding the feed each update would restart
    // every entry's fade-in and make the history flicker.
    for (let i = this.renderedChronicle; i < sim.chronicle.length; i++) {
      const line = sim.chronicle[i];
      const el = document.createElement('div');
      el.className = 'pp-line';
      if (line.weight >= 0.8) el.classList.add('major');
      el.innerHTML = `<span>${line.tick}</span>${line.text}`;
      this.feedEl.appendChild(el);
    }
    this.renderedChronicle = sim.chronicle.length;
    while (this.feedEl.childElementCount > 8) {
      this.feedEl.removeChild(this.feedEl.firstElementChild!);
    }
  }
}
