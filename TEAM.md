# Who owns what

Four people, four folders, four branches. Nobody waits for anybody, because
every folder has mocks of the other three built from the shared fixtures.

| Person | Branch | Folder | Owns |
| --- | --- | --- | --- |
| **1** | `adapters` | `adapters/**` | Slack in and out, the replay adapter, the browser bridge |
| **2** | `detection` | `core/detection/**`, `prompts/detector/**` | is there anything here worth a reply |
| **3** | `action` | `core/action/**`, `prompts/policy/**`, `prompts/compose/**` | should we speak, to whom, saying what |
| **4** | `harness` | `harness/**`, `scripts/**`, `.github/**` | orchestration, observability, the demo |

`contracts/**` is shared and frozen after checkpoint 1. Changing it needs the
team, not a PR.

## Before anybody writes code

```bash
git clone <repo> && cd cluebro
npm install
npm run replay:demo     # this must already work. If it does not, say so now.
npm run clock:start     # stamps the three hours, once, on one machine
git checkout -b <your branch>
```

Ten minutes of everybody reading `contracts/src/` and
[`harness/pipeline.ts`](harness/pipeline.ts) is the highest return ten minutes
of the day. `pipeline.ts` is 120 lines and it is the entire system.

---

## Person 1 — adapters

**Branch** `adapters` · **Folder** `adapters/**`

**Contracts** produce `ContextEvent`, consume `ActionDecision.delivery`,
return `ActionResult`. Never import from `core/`.

**First task (aim for T+40).** Get real Slack events flowing into
`ContextEvent` and one real message back out.

1. Create the Slack app from `adapters/slack/manifest.json`, Socket Mode on,
   install to the workspace, `/invite` the bot into the demo channel.
2. `cp .env.example .env`, fill `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`, put
   the demo channel id in `SLACK_ALLOWED_CHANNELS`.
3. `npm run dev:dry`, type in the channel, confirm a decision block prints per
   message with the right author and the right text.
4. Post the tokens to the team channel, or to whoever needs them. Everybody
   else can work without them, but nobody can demo without them.

**Done means** a screenshot of the decision log reacting to a live channel,
and `npm run dev` posting one real message on purpose.

**Then (T+40 to T+120).** The browser bridge for stage 2, in this order:
`npm run replay:meet` already passes; get the bridge accepting `curl` posts;
then load the unpacked extension and fix the caption selectors against a real
Meet call. If the selectors fight you for more than ten minutes, stop and say
so — it is a nice-to-have, not the demo.

**Do not touch** `core/**`, `contracts/**`, `prompts/**`, `harness/pipeline.ts`.

<details>
<summary>Paste this into your coding agent</summary>

```
You are working in the ClueBro repo, on branch `adapters`. You own `adapters/**`
and nothing else.

Read first, in this order:
  adapters/slack/README.md
  contracts/src/context-event.ts
  contracts/src/ports.ts
  harness/pipeline.ts

Your job: adapters translate a surface into contracts and back. Inbound turns a
Slack message event into a ContextEvent. Outbound turns an ActionDecision into
either a channel post or a direct message, and returns an ActionResult.

The contracts you must respect exactly:
- ContextEvent is the only inbound shape. Build it with ContextEventSchema.parse
  so an invalid event fails at the boundary, in your code, not three layers down.
- ActionDecision.delivery says `target: "surface" | "actor"` and
  `visibility: "public" | "private"`. Your job is to know that target=actor plus
  private means conversations.open followed by chat.postMessage. The core does
  not know either call exists.
- Return ActionResult through the `makeResult` factory in contracts/src/factories.ts.
- ContextEvent.metadata is yours: put Slack-specific things there (thread ts,
  channel type). Nothing outside adapters/ may read it.

Hard rules, enforced by `npm run check:boundaries`:
- Never import from core/ or harness/.
- Never change anything in contracts/, core/, prompts/, or harness/.
- The agent is passive: no app_mention subscription, no slash commands, no
  interactivity. It is never invoked.
- Events where actor.is_agent is true must be marked as such. The pipeline drops
  them, and without that the first reply starts an infinite loop.

Verify your work with, in order:
  npm run replay:demo          (must still pass, it does not use Slack)
  npm run dev:dry              (live Slack, decides, sends nothing)
  npm run check:boundaries
  npm run typecheck

Add your own assertions in adapters/check.ts and run `npm run check:units`.
Good candidates: toPlainText strips mention and link markup, toContextEvent
returns null for a join subtype, formatMessage always includes sources.

First deliverable: a real Slack channel produces decision blocks in the log,
with correct author names and text. Then one real message posted on purpose.

Keep diffs small, one PR per working piece. In the PR say: which contract you
touched (ideally none), which mock you used, and the exact command to check it.
```
</details>

---

## Person 2 — detection

**Branch** `detection` · **Folder** `core/detection/**`, `prompts/detector/**`

**Contracts** in `ContextEvent[]` plus `WindowContext`, out `Observation[]`.
Dependencies arrive as `CoreDeps`.

**First task (aim for T+40).** Make the detector good with a real model, and
prove it with numbers rather than vibes.

1. `LLM_PROVIDER=openai` and `OPENAI_API_KEY` in your `.env`.
2. `npm run prompt:eval -- --version v1` on all three transcripts. Read what
   it concluded for every single message.
3. Copy `conversation_scan.v1.md` to `v2.md`, fix whatever was wrong, and
   `npm run prompt:diff` the two runs.
4. The number that matters is at the bottom: **would speak on A: n B: m**. If
   v2 is louder than v1, justify it or throw it away.

**Done means** a prompt version where `silence-only.json` produces zero
actionable observations and `demo-main.json` produces exactly the three you
want, with the evidence citing the right message.

**Then.** A fourth observation kind, only if the first three are solid. Three
that work beat four that are noisy.

**Do not touch** `core/action/**`, `adapters/**`, `contracts/**`,
`harness/pipeline.ts`.

<details>
<summary>Paste this into your coding agent</summary>

```
You are working in the ClueBro repo, on branch `detection`. You own
`core/detection/**` and `prompts/detector/**`, and nothing else.

Read first, in this order:
  core/detection/README.md
  contracts/src/observation.ts
  prompts/detector/conversation_scan.v1.md
  core/detection/heuristics.ts

Your job is perception only: given a window of ContextEvents, say what is
happening. You do NOT decide whether to speak — core/action does that, and the
separation is deliberate.

The contracts you must respect exactly:
- Return Observation[] built with makeObservation from contracts/src/factories.ts.
- ALWAYS return at least one observation. `no_signal` is a conclusion, not an
  empty array. An empty array is an invisible decision and this product is about
  making decisions visible.
- Any kind other than no_signal MUST cite at least one real event_id in
  `evidence`. core/action refuses an unsupported claim, so an uncited
  observation is wasted work.
- Set subject_actor_id to the person with the need. It drives whether the reply
  is a channel post or a direct message.
- Record prompt_id, prompt_version and model in `detector`. That is how a bad
  decision gets traced back to the wording that caused it.

Hard rules, enforced by `npm run check:boundaries`:
- Never import from adapters/, harness/, @slack/* or openai.
- Never read process.env. Configuration arrives as a function argument.
- Never change contracts/, core/action/, adapters/ or harness/.
- Prompt text lives in prompts/detector/*.md, never in a .ts file. To change
  behaviour, add a new version file, do not edit a released one.

Iterate like this, not by staring at the code:
  npm run prompt:eval -- --version v1
  (edit prompts/detector/conversation_scan.v2.md)
  npm run prompt:eval -- --version v2
  npm run prompt:diff -- prompts/runs/<v1 run>.json prompts/runs/<v2 run>.json

Set LLM_PROVIDER=openai first, or you are measuring the fake provider.

Target behaviour:
- fixtures/transcripts/silence-only.json: zero actionable observations. Every
  message must come back no_signal.
- fixtures/transcripts/demo-main.json: exactly the three real signals, with
  confidence high enough to clear 0.62, and evidence pointing at the right line.
- The prefilter must prefer the most recent signal. A stale signal from ten
  messages ago winning means the agent answers the wrong thing on camera.

Verify with: npm run replay:demo && npm run replay:silence && npm run smoke
Add assertions in core/detection/check.ts, run `npm run check:units`.
```
</details>

---

## Person 3 — action

**Branch** `action` · **Folder** `core/action/**`, `prompts/policy/**`,
`prompts/compose/**`

**Contracts** in one `Observation` plus its window, out one `ActionDecision`.

**First task (aim for T+40).** Make the silence criterion the best part of the
demo.

1. `npm run check:units` — 13 policy assertions already pass. Read
   `core/action/check.ts` to see what the rules are.
2. Turn on the veto with a real model (`LLM_PROVIDER=openai`) and make
   `policy.should_intervene` actually veto things. The fake provider never
   vetoes, so this is only visible with a key.
3. Add the deterministic guard that is still missing: a question a human
   answered while the agent was thinking should come back
   `already_answered_by_human`. The reason code already exists; the rule does
   not.
4. Tune `POLICY_MIN_CONFIDENCE` and `POLICY_MIN_CONFIDENCE_PUBLIC` against the
   demo transcript and write the values you chose into `.env.example`.

**Done means** the demo replay shows at least four distinct silence reasons,
and every message the agent does send is short, specific and cites a source.

**Then.** The wording. `compose.channel_reply` should read like a colleague,
not like a support bot. Two sentences, no "I noticed that", no offers to help
further.

**Do not touch** `core/detection/**`, `adapters/**`, `contracts/**`,
`harness/pipeline.ts`.

<details>
<summary>Paste this into your coding agent</summary>

```
You are working in the ClueBro repo, on branch `action`. You own
`core/action/**`, `prompts/policy/**` and `prompts/compose/**`, nothing else.

Read first, in this order:
  core/action/README.md
  core/action/policy.ts
  core/action/check.ts
  contracts/src/action-decision.ts
  prompts/policy/should_intervene.v1.md

Your job is judgement, then wording. Given an Observation, decide whether to
speak, to whom, how publicly, and what the message says. The model writes the
words. It never decides whether to speak — `evaluate()` in policy.ts does, and
it is a pure function so it can be asserted directly.

The contracts you must respect exactly:
- Build decisions with silentDecision() and actDecision() from
  contracts/src/factories.ts. Do not hand-write the object: the schema enforces
  that act=true carries a delivery and a draft, and act=false carries neither.
- reason_code is a typed enum. Silence always gets a SilenceReason and a
  one-sentence rationale that a judge could read out loud. This is the most
  important text in the product.
- Delivery says who and how public, never which app. `target: "actor"` plus
  `visibility: "private"` means the adapter opens a DM. You never mention Slack.
- Record prompt_id, prompt_version and model in `decided_by`.

The behaviour that matters most: silence. An agent that replies to everything is
noise. Two gates, in this order:
  1. arithmetic — thresholds, cooldown, dedupe, evidence present. A public post
     needs a higher bar than a DM, because a public mistake is louder.
  2. judgement — one model call that can veto something the thresholds allowed.
Bias toward silence. A veto that fails to parse must FAIL OPEN, so silence is
always a decision and never a side effect of a parse error.

Hard rules, enforced by `npm run check:boundaries`:
- Never import adapters/, harness/, @slack/* or openai.
- Never read process.env.
- Never change contracts/, core/detection/, adapters/ or harness/.
- Prompt text lives in prompts/**/*.md. New behaviour means a new version file.

Verify with:
  npm run check:units      (extend core/action/check.ts with every rule you add)
  npm run replay:demo      (read every silence reason it prints)
  npm run replay:silence   (must produce zero messages)
  npm run smoke

Concrete targets:
- At least four distinct silence reasons appear in the demo replay.
- silence-only.json produces zero messages, every one explained.
- Cooldown advances when the decision is made, not when delivery succeeds. A
  failed send must still buy quiet, or a broken token becomes a retry storm in a
  live channel.
```
</details>

---

## Person 4 — harness

**Branch** `harness` · **Folder** `harness/**`, `scripts/**`, `.github/**`

**Contracts** you wire every port together and own nothing else. You are also
the integrator: at each checkpoint you run the merge and call the revert.

**First task (aim for T+40).** Own the demo, from the first minute.

1. Write `fixtures/transcripts/demo-main.json` into what the video will
   actually show, and lock it. Right now it produces three interventions and
   eight explained silences; decide whether that is the story.
2. Write `docs/DEMO.md`: the 2 minute script, second by second, with the exact
   commands and what you say over each beat.
3. Record a throwaway take of `npm run replay:demo` at T+45. A bad video that
   exists beats a good one that does not.

**Done means** `docs/DEMO.md` exists, the replay reads well on camera, and a
first take is recorded.

**Then.** Make the log more legible, not more detailed. If a judge cannot read
a block in two seconds, it is too dense. You also run the three checkpoints
and you are the one who says "revert".

**Do not touch** `core/**` or `adapters/**` beyond wiring them in
`registry.ts`. If a mock is not good enough for you, ask its owner for a
better mock instead of editing their folder.

<details>
<summary>Paste this into your coding agent</summary>

```
You are working in the ClueBro repo, on branch `harness`. You own `harness/**`,
`scripts/**` and `.github/**`. You also own the demo.

Read first, in this order:
  harness/README.md
  harness/pipeline.ts
  harness/observability.ts
  adapters/replay/README.md

Your job is orchestration and observability. The pipeline is
  inbound adapter -> window -> detector -> action engine -> outbound adapter
and registry.ts is the only file that decides which implementation sits behind
each port.

The contracts you must respect exactly:
- Validate every inbound event with ContextEventSchema at the pipeline boundary,
  so a broken adapter produces a specific error instead of a mystery crash.
- Write a DecisionLogRecord for EVERY event, including the silent ones. That is
  the product. A silent turn with no log line is a bug.
- Never bypass a port. If you need something from core/ or adapters/ that is not
  in contracts/src/ports.ts, that is a contract change for a checkpoint.

Hard rules:
- Do not edit core/** or adapters/**. If a mock is insufficient, ask its owner.
- harness/config.ts is the ONLY place that reads process.env. Every new setting
  goes there and into .env.example in the same commit.
- DRY_RUN must be enforced twice: skip the delivery call AND swap the outbound
  adapter for the console printer. A single flag is not enough protection for a
  live workspace.
- Keep the Slack SDK behind a dynamic import in registry.ts. A broken install
  must never stop a replay, because the replay is the demo we cannot lose.

Your real deliverable is the demo:
- docs/DEMO.md, a 2 minute script, beat by beat, with the exact commands.
- The pretty log must read in two seconds per block. Right now each block is
  time, surface, author, text, then saw / decided / because / says / sources /
  sent / prompts. Cut anything a judge does not need.
- The single most valuable line on screen is `STAY QUIET [reason] because ...`.
  Make it impossible to miss.

Verify with: npm run ci  (typecheck, boundaries, contracts, units, smoke)
It must stay under two minutes or people stop waiting for it.
```
</details>

---

## When you are blocked on somebody else

You are not. Use their mock:

```ts
import { fixtureDetector, scriptedDetector, silentDetector } from "@core/detection/mock";
import { alwaysActEngine, alwaysSilentEngine } from "@core/action/mock";
import { createReplayInbound, createConsoleOutbound } from "@adapters/replay/index";
```

If a mock does not do what you need, that is a two line PR **to the mock**, by
its owner, not a change to their real implementation.
