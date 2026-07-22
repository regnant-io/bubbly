/**
 * Dynamic prompt suggestions for the welcome composer.
 *
 * A curated pool of realistic coding tasks, grouped by intent so the welcome
 * screen can surface a varied, rotating handful instead of the same four static
 * strings every time. Selection is seeded per-session and rotates gently, so it
 * feels alive without ever depending on network state.
 */

export interface PromptSuggestion {
  /** Short label shown on the chip. */
  label: string;
  /** Full prompt dropped into the composer when clicked. */
  prompt: string;
  /** Intent group — drives which icon/tint the chip gets. */
  kind: 'build' | 'explore' | 'fix' | 'test' | 'refactor' | 'plan';
}

const POOL: PromptSuggestion[] = [
  { kind: 'explore', label: 'Explain this codebase', prompt: 'Give me a guided tour of this codebase — the architecture, the main modules, and how a request flows through the system.' },
  { kind: 'explore', label: 'Find where X is handled', prompt: 'Find where authentication is handled in this project and walk me through the flow.' },
  { kind: 'build', label: 'Add a new feature', prompt: 'Add a new feature: describe what you want and I\'ll plan the change, implement it, and wire it in.' },
  { kind: 'fix', label: 'Track down a bug', prompt: 'There\'s a bug I need help with. Explore the relevant code, form a hypothesis, and propose a fix.' },
  { kind: 'test', label: 'Write tests', prompt: 'Add unit tests for the most important untested module, covering the main paths and edge cases.' },
  { kind: 'refactor', label: 'Clean up a messy file', prompt: 'Find the messiest, most complex file in this project and refactor it for clarity without changing behavior.' },
  { kind: 'plan', label: 'Plan a big change', prompt: 'I\'m planning a larger change. Help me scope it into a spec with concrete steps before we write any code.' },
  { kind: 'explore', label: 'Review recent changes', prompt: 'Review the most recent changes in this project for correctness, edge cases, and anything that looks risky.' },
  { kind: 'refactor', label: 'Improve performance', prompt: 'Profile the hot paths in this project and suggest targeted performance improvements.' },
  { kind: 'build', label: 'Scaffold a component', prompt: 'Scaffold a new UI component that matches the existing design system and conventions.' },
  { kind: 'fix', label: 'Fix failing tests', prompt: 'Run the test suite, find what\'s failing, and fix the underlying issues.' },
  { kind: 'plan', label: 'Draft documentation', prompt: 'Draft clear README/usage docs for the most important part of this project that lacks them.' },
];

/** Small deterministic PRNG so a given seed always yields the same rotation. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Return `count` suggestions for the given rotation index, shuffled by seed. */
export function pickSuggestions(seed: number, count = 4): PromptSuggestion[] {
  const rand = mulberry32(seed);
  const shuffled = [...POOL]
    .map((s) => ({ s, k: rand() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.s);
  return shuffled.slice(0, count);
}

/** Time-of-day aware sub-greeting, used under the main welcome line. */
export function timeGreeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return 'Burning the midnight oil';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 22) return 'Good evening';
  return 'Working late';
}
