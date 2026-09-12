# Working in this repo

Context for any coding agent working here. Read this before editing anything.

## What this is

An agent that sits passively in a Slack workspace, decides on its own when it
has something useful to add, and stays quiet the rest of the time. Built in a
three hour hackathon by four people working in parallel.

Two things are load-bearing:

1. **The silence is the product.** Every decision, including every decision not
   to speak, is logged with a typed reason. Code that makes a silent turn
   invisible is a bug, not an optimisation.
2. **The core does not know Slack exists.** It receives channel-agnostic
   `ContextEvent`s through an adapter port and returns `Delivery` instructions
   that say *this person, privately* or *this surface, publicly*. Slack is one
   adapter; a browser extension in a live meeting is another.

## Ownership

One person per folder. Do not edit outside the folder you were told to own.

| Folder | Owner |
| --- | --- |
| `adapters/**` | Person 1 |
| `core/detection/**`, `prompts/detector/**` | Person 2 |
| `core/action/**`, `prompts/policy/**`, `prompts/compose/**` | Person 3 |
| `harness/**`, `scripts/**`, `.github/**` | Person 4 |
| `contracts/**`, `prompts/loader.ts` | shared, frozen after checkpoint 1 |

If a task seems to need a change in somebody else's folder, stop and say so.
The usual answer is that their mock needs one line, not their implementation.

## Hard rules

Enforced by `npm run check:boundaries`, which CI runs:

- Nothing in `core/**` may import `@slack/*`, `openai`, `adapters/**` or
  `harness/**`.
- Nothing in `core/**` may read `process.env`. Only `harness/config.ts` does
  that, so every knob is discoverable in one place.
- Nothing in `adapters/**` may import `core/**`.
- Nothing in `contracts/**` may import anything but zod and node builtins.

Also, and not machine-checked:

- No prompt text in `.ts` files. Prompts live in `prompts/**/*.md`, are loaded
  at runtime, and are versioned. To change behaviour, add `*.v2.md`; do not
  edit a released version.
- Build contract payloads with the factories in `contracts/src/factories.ts`
  (`makeObservation`, `silentDecision`, `actDecision`, `makeResult`), never
  with object literals. The schema enforces invariants the factories get right
  for free.
- The detector always returns at least one `Observation`. `no_signal` is a
  conclusion; an empty array is an invisible decision.
- An observation with no `evidence` is treated as a hallucination and refused
  downstream. Always cite a real `event_id`.

## Commands

```bash
npm run replay:demo        # whole pipeline on a saved conversation, no network
npm run replay:silence     # a conversation the agent must ignore entirely
npm run replay:meet        # the same core on a live meeting surface
npm run ci                 # typecheck, boundaries, contracts, units, smoke
npm run check:units        # every check.ts in the repo
npm run prompt:eval -- --version v1
npm run prompt:diff -- <run-a.json> <run-b.json>
```

There is no build step. `tsx` runs TypeScript directly. `tsc --noEmit` is the
lint; there is no ESLint on purpose.

## Conventions

- ESM, path aliases (`@contracts`, `@core/*`, `@adapters/*`, `@harness/*`,
  `@prompts/*`), no relative climbing between top-level folders.
- Comments explain **why**, not what. The code says what.
- Everything in the repo is in English: code, comments, docs, UI, logs.
- Add assertions to `check.ts` in your own folder. `npm run check:units` finds
  it automatically — never edit `package.json` to register a test, that file
  causes the most merge conflicts.
- Fail loudly at boundaries. An adapter that emits a malformed event should
  produce a specific error naming the adapter, not a crash three layers down.
- A parse failure must never turn into accidental silence or an accidental
  message. When the veto prompt returns garbage it fails open; when a compose
  prompt returns garbage the decision still sends something true and small.

## Things that will look like bugs and are not

- **Cooldown advances on decision, not on delivery.** A failed send still buys
  quiet, otherwise a broken token becomes a retry storm in a live channel.
- **Replay runs on a conversation clock** (`harness/clock.ts`). A twelve minute
  transcript that replays in twenty seconds must still honour a two minute
  cooldown, or every decision after the first would be suppressed.
- **The Slack SDK is behind a dynamic import** in `harness/registry.ts`. A
  broken install must not stop a replay, because the replay is the demo path.
- **`DRY_RUN` is enforced twice** — the pipeline skips delivery *and* the
  registry swaps in a console outbound. One flag is not enough protection for a
  live workspace.
- **The fake LLM provider never vetoes.** Judgement needs a real model; under
  `LLM_PROVIDER=fake` silence comes from the prefilter and the thresholds.

## Scope discipline

This is a three hour hackathon, not a production system. Prefer the version
that demos well and can be explained in one sentence. If you find yourself
adding a queue, a database or a retry policy, you are solving tomorrow's
problem with today's hours.
