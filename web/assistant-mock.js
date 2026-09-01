/**
 * What the microphone would have heard, for testing where it cannot.
 *
 * ── What this file used to be ────────────────────────────────────────────
 *
 * A mock PROVIDER: a fake assistant that produced plausible proposals so the
 * interaction could be built before a model existed. That is gone — the
 * assistant is real, plans on the server, and writes through domain services.
 * A fake that produced proposals alongside a real one would be indistinguishable
 * from it right up until somebody trusted the wrong one.
 *
 * ── What remains, and why ────────────────────────────────────────────────
 *
 * Fixed transcripts, which substitute for a MICROPHONE rather than for the
 * assistant. Speech recognition is a Chrome and Safari feature, behaves
 * differently in each, and is absent in Firefox entirely; without these the
 * interaction could only be walked on one browser. The text they produce goes
 * to the same server turn a spoken sentence would.
 */
const DEMO_TRANSCRIPT = 'I finished the website changes. I need a haircut tomorrow. '
  + 'Add milk, chicken and toothpaste to groceries. '
  + 'And move my meeting with John from 2 to 3.';

export const MOCK_TRANSCRIPTS = [
  {
    id: 'demo',
    label: 'The full demonstration',
    text: DEMO_TRANSCRIPT,
    /* Word timings, so the transcript ARRIVES rather than appearing. Watching
     * it build is most of what tells somebody the app is listening, and a
     * block of text that materialises at once tests none of that. */
    pace: 190,
  },
  { id: 'one', label: 'One task', text: 'Remind me to call the dentist tomorrow', pace: 210 },
  { id: 'ask', label: 'A question', text: 'What does my day look like', pace: 200 },
];
