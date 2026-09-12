# core/action

Judgement, then wording. The part of the agent that decides to shut up.

## Contracts

- **in:** one `Observation` plus the `ContextEvent[]` window it came from
- **out:** one `ActionDecision`
- **deps:** `CoreDeps`. The model writes the words. It never decides whether
  to speak.

## How I run this alone

```bash
npm run replay:demo     # whole pipeline, no Slack, no key
npm run smoke           # asserts the silence paths still fire
```

To work before `core/detection` exists, use its mocks:

```ts
import { fixtureDetector, scriptedDetector } from "@core/detection/mock";
```

`fixtureDetector()` replays the committed `Observation` fixtures in order, so
you get an `unanswered_question`, an `information_gap` and a `no_signal`
without anybody having written a detector yet.

## What is in here

- `policy.ts` — pure, deterministic rules. Same observation plus same state
  gives the same outcome every time, which is what makes the demo repeatable.
  `evaluate()` is a plain function: call it directly in a test.
- `index.ts` — turns a policy outcome into an `ActionDecision`, with two model
  calls: an optional veto (`policy.should_intervene`) and the wording
  (`compose.channel_reply` or `compose.direct_message`).
- `mock.ts` — `alwaysActEngine` and `alwaysSilentEngine(reason)` for the other
  three folders.

## The two gates

1. **Arithmetic.** Thresholds, cooldown, dedupe, evidence present. Catches
   "not sure enough".
2. **Judgement.** One model call that can veto a decision the thresholds
   already allowed. Catches "technically valid but would still be annoying".
   Set `POLICY_SECOND_OPINION=false` to make a run fully deterministic.

The fake provider never vetoes, because judgement needs a real model. Under
`LLM_PROVIDER=fake` the silences come from the prefilter and the thresholds,
which is still four distinct reasons on the demo transcript.

## Routing, without naming any product

The decision says who, and how public. Never which app.

| Situation | Delivery |
| --- | --- |
| an individual need (`information_gap`, or a direct surface) | `target: actor`, `visibility: private` |
| a shared need, confident enough for the public bar | `target: surface`, `visibility: public` |
| a shared need, over the speak bar but under the public bar | downgraded to `target: actor`. Not confident enough to say it in front of everyone. |
| a live meeting | always private to the principal. Never broadcast. |

## Rules

- Never import `adapters/`, `harness/`, `@slack/*` or `openai`.
- Never read `process.env`. Configuration arrives as an argument.
- Cooldown advances when the decision is made, not when delivery succeeds. A
  failed send should still buy quiet, otherwise a broken token turns into a
  retry storm in a live channel.

## Tuning knobs, in .env

| Variable | Default | Effect |
| --- | --- | --- |
| `POLICY_MIN_CONFIDENCE` | 0.62 | below this the agent says nothing at all |
| `POLICY_MIN_CONFIDENCE_PUBLIC` | 0.72 | below this it will not post in a channel, only DM |
| `POLICY_COOLDOWN_SECONDS` | 120 | quiet window per surface after speaking |
| `POLICY_DEDUPE_SECONDS` | 600 | do not help the same person with the same thing twice |
| `POLICY_SECOND_OPINION` | true | ask the model for a veto |

Raising the two thresholds makes the demo quieter and safer. Lowering them
makes it chatty. If the demo is going badly, raise them.
