# core/detection

Perception. Answers exactly one question: is there anything in this
conversation worth a reply, and what precisely is it?

It does NOT decide whether to speak. That is `core/action`. Keeping those
apart is what lets the silence threshold be tuned without touching the
detector, and the detector be improved without touching the policy.

## Contracts

- **in:** `ContextEvent[]` (a window) plus a `WindowContext`
- **out:** `Observation[]`
- **deps:** `CoreDeps` — an `LlmClient`, a `PromptRegistry`, a `Clock`, a
  `Logger`. All injected, never constructed here.

## How I run this alone

No Slack, no API key, no code from anybody else:

```bash
npm run replay:demo                  # whole pipeline on a saved conversation
npm run replay:silence               # a conversation it should ignore entirely
npm run prompt:eval -- --version v1  # this detector only, over a transcript
```

`prompt:eval` is the tight loop. It runs the detector over every window of a
transcript, prints what it concluded for each message, and saves the run to
`prompts/runs/`. Change the prompt, run it again, diff the two:

```bash
npm run prompt:eval -- --version v2
npm run prompt:diff -- prompts/runs/detector.conversation_scan__v1__demo-main.json prompts/runs/detector.conversation_scan__v2__demo-main.json
```

With a real key, set `LLM_PROVIDER=openai` in `.env` first. Otherwise you are
measuring the fake provider, and the script tells you so.

## What is in here

- `heuristics.ts` — the cheap pass. No model, no network. It throws away
  banter before it reaches a paid model, and it keeps the pipeline alive when
  the model is down. Crude on purpose: a rule that needs judgement belongs in
  a prompt, not here.
- `index.ts` — the real detector. Prefilter, then one model call driven by
  `prompts/detector/conversation_scan.v1.md`, then an `Observation`.
- `mock.ts` — stand-ins other people import: `fixtureDetector()`,
  `scriptedDetector()`, `silentDetector`.

## Rules

- `no_signal` is a conclusion, not an absence of one. ALWAYS return an
  observation. An empty array is an invisible decision, and this whole project
  is about making decisions visible.
- An actionable observation with no `evidence` is a hallucination, and
  `core/action` will refuse it. Always cite a real `event_id`.
- The prefilter sorts by recency first. A stale signal from ten messages ago
  must not keep winning, or the agent spends the demo answering the wrong
  thing.
- Never import from `adapters/`, `harness/`, `@slack/*` or `openai`, and never
  read `process.env`. `npm run check:boundaries` fails the build if you do.

## Where the quality actually lives

In `prompts/detector/conversation_scan.v1.md`, not in this TypeScript. If you
want the agent to be smarter, copy that file to `.v2.md`, edit it, and measure
the difference with `prompt:eval` plus `prompt:diff`. Editing the prompt does
not require a code review; changing this folder does.
