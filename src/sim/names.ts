/**
 * Name generation.
 *
 * Each culture draws from one of several phoneme sets, so two cultures sound
 * different from each other and consistent with themselves across a thousand
 * years. Entirely deterministic from the world seed — a given planet always
 * produces the same Vashti Empire.
 */

import { makeRng, mixSeed } from '../core/rng';

interface Phonemes {
  onsets: string[];
  vowels: string[];
  codas: string[];
  /** Endings applied to place and polity names. */
  suffixes: string[];
}

const PHONEME_SETS: Phonemes[] = [
  {
    onsets: ['k', 'v', 'sh', 't', 'm', 'dr', 'n', 'z', 'th', 'g'],
    vowels: ['a', 'e', 'i', 'o', 'ae', 'ia'],
    codas: ['n', 'r', 'sh', 'l', 'm', 'th', ''],
    suffixes: ['ia', 'or', 'anth', 'esh', 'ara', 'un'],
  },
  {
    onsets: ['b', 'd', 'g', 'l', 'r', 'kh', 'tz', 'p', 'w'],
    vowels: ['u', 'o', 'aa', 'e', 'oo', 'ou'],
    codas: ['k', 'g', 'd', 'rr', 'n', ''],
    suffixes: ['ok', 'ur', 'agh', 'oth', 'um', 'dan'],
  },
  {
    onsets: ['s', 'f', 'h', 'y', 'ch', 'l', 'n', 'm', 'qu'],
    vowels: ['i', 'e', 'ai', 'ei', 'y', 'ie'],
    codas: ['l', 's', 'n', 'th', 'f', ''],
    suffixes: ['iel', 'wyn', 'is', 'ath', 'ell', 'ryn'],
  },
  {
    onsets: ['t', 'k', 'p', 'n', 'm', 'ts', 'h', 'w', 'r'],
    vowels: ['a', 'u', 'o', 'ao', 'ua', 'i'],
    codas: ['n', 'k', 'm', ''],
    suffixes: ['ana', 'uku', 'oa', 'ari', 'iti', 'onu'],
  },
  {
    onsets: ['gr', 'br', 'st', 'kr', 'v', 'd', 'th', 'sk', 'h'],
    vowels: ['o', 'a', 'ei', 'u', 'y', 'ae'],
    codas: ['rd', 'st', 'lf', 'nn', 'g', ''],
    suffixes: ['heim', 'gard', 'vik', 'mark', 'stad', 'fell'],
  },
];

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function syllable(p: Phonemes, rng: { next(): number; int(a: number, b: number): number }): string {
  const onset = p.onsets[rng.int(0, p.onsets.length)];
  const vowel = p.vowels[rng.int(0, p.vowels.length)];
  const coda = rng.next() < 0.45 ? p.codas[rng.int(0, p.codas.length)] : '';
  return onset + vowel + coda;
}

export class NameGenerator {
  private phonemes: Phonemes;
  private seed: number;
  private counter = 0;
  private used = new Set<string>();

  constructor(cultureSeed: number) {
    this.seed = cultureSeed >>> 0;
    this.phonemes =
      PHONEME_SETS[Math.abs(cultureSeed) % PHONEME_SETS.length];
  }

  private next(minSyllables: number, maxSyllables: number, suffix: boolean): string {
    // Retry on collision rather than accept a duplicate: two "Kaeth"s in one
    // chronicle read as a bug, not as a coincidence.
    for (let attempt = 0; attempt < 24; attempt++) {
      const rng = makeRng(mixSeed(this.seed, this.counter++ * 7919 + attempt));
      const count = rng.int(minSyllables, maxSyllables + 1);
      let word = '';
      for (let i = 0; i < count; i++) word += syllable(this.phonemes, rng);
      if (suffix && rng.next() < 0.55) {
        word += this.phonemes.suffixes[rng.int(0, this.phonemes.suffixes.length)];
      }
      word = capitalise(word);
      if (!this.used.has(word)) {
        this.used.add(word);
        return word;
      }
    }
    return capitalise(`${this.phonemes.onsets[0]}${this.phonemes.vowels[0]}${this.counter}`);
  }

  culture(): string {
    return this.next(2, 3, false);
  }

  settlement(): string {
    return this.next(1, 3, true);
  }

  /** Polities take a form appropriate to their size and era. */
  polity(era: number, size: number): string {
    const stem = this.next(2, 3, true);
    const forms =
      size > 40
        ? ['the {} Empire', 'the Empire of {}', 'Greater {}', 'the {} Dominion']
        : size > 14
          ? ['the Kingdom of {}', 'the {} Realm', '{}', 'the {} Confederacy']
          : ['the {} Tribes', '{}', 'the People of {}', 'the {} Clans'];
    const rng = makeRng(mixSeed(this.seed, this.counter * 31 + era));
    return forms[rng.int(0, forms.length)].replace('{}', stem);
  }

  religion(): string {
    const stem = this.next(2, 3, false);
    const rng = makeRng(mixSeed(this.seed, this.counter * 17));
    const forms = [
      'the Way of {}',
      'the {} Faith',
      '{}ism',
      'the Cult of {}',
      'the {} Communion',
      'the Path of {}',
    ];
    return forms[rng.int(0, forms.length)].replace('{}', stem);
  }
}
