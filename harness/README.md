# harness

Orchestration, observability and the demo. The only place the four pieces
meet, and the only place that knows which implementation sits behind each
port.

Read `pipeline.ts` to understand the whole system. Everything else is a leaf.

## How I run this alone

```bash
npm run replay:demo    # the demo, no Slack, no key
npm run smoke          # the end to end assertions CI runs
npm run ci             # everything CI runs, about 6 seconds locally
```

The demo itself has its own script: [docs/DEMO.md](../docs/DEMO.md).

The harness never needs anybody else to be finished: swap in
`@core/detection/mock` and `@core/action/mock` and the pipeline still runs.

## What is in here

| File | Job |
| --- | --- |
| `pipeline.ts` | ingest, window, detect, decide, deliver, log. ~120 lines, and that is the whole system |
| `registry.ts` | composition root. Picks the adapter, the provider, the detector and the engine from config |
| `config.ts` | every knob, read from the environment exactly once. Nobody else reads `process.env` |
| `observability.ts` | the pretty decision log and the JSONL file. This is the demo surface |
| `check.ts` | the harness's own assertions. `npm run check:units` finds it |
| `window.ts` | per-surface conversation memory, bounded by count and by age |
| `clock.ts` | wall clock for live, conversation clock for replay |
| `llm/fake.ts` | deterministic provider. No network, no key |
| `llm/openai.ts` | the ONLY file in the repo that imports a model vendor SDK |
| `bin/run.ts` | the CLI |
| `bin/smoke.ts` | end to end assertions |

## The output that matters

One block per incoming event, whether or not the agent spoke:

```
14:02:30 #product Mar: brb
  saw      unanswered_question (0.78) Ana asked a question and 2 later message(s) went past without answering it.
  decided  SPEAK -> post in C09PRODUCT [unanswered_question_timeout]
  says     On "does anyone know if the staging deploy from last night went out?" ...
  sources  the message this refers to <slack:C09PRODUCT:1789221670.000000>

14:03:40 #product Luis: we should clean up the old feature flags at some point
  saw      plan_without_owner (0.66) Luis proposed something with no owner and no date attached.
  decided  STAY QUIET [cooldown_active]
  because  Already spoke here 70s ago. Holding for 120s so the agent does not dominate the channel.
```

The second block is the one to point at in the video.

Three things are deliberately **not** in that block. `because` is skipped when
the rationale only restates what `saw` already said, so the same sentence never
appears twice. Prompt provenance and the dry-run delivery line are behind
`--debug`, because a judge does not need them and every block is three lines
shorter without them. None of it is lost: every silent turn writes a full
`DecisionLogRecord` to `logs/decisions.jsonl`, so the reasoning stays
queryable:

```bash
# what did it decide, and why
cat logs/decisions.jsonl | jq -r '[.decision.act, .decision.reason_code, .decision.rationale] | @tsv'

# only the times it chose silence
cat logs/decisions.jsonl | jq -r 'select(.decision.act == false) | .decision.reason_code' | sort | uniq -c
```

## Two design notes worth keeping

**Lazy adapter loading.** `registry.ts` imports the Slack SDK only when the
Slack adapter is selected. A broken install cannot stop a replay, which is the
path the demo depends on.

**Dry run is enforced twice.** `DRY_RUN=true` both skips the delivery call and
swaps the outbound adapter for a console printer, so a mistake in the pipeline
still cannot post to a real channel.
