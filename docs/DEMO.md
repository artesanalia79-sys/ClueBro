# The demo

Two minutes, recorded. This file is the operating manual for the take: what to
type, what appears, what to say over it, and what to do when something breaks
at T+170.

Read it once before you record. During the take, only the table in
[The script](#the-script) matters.

## Why the replay and not live Slack

The take is `npm run replay:demo`. It is deterministic, it needs no network, no
API key and no workspace, and it produces the same 11 decisions every single
time. Live Slack is a nicer 30 seconds and it is the one thing that can be
taken away from you five minutes before the deadline. Record Slack as B-roll
early (see [beat 2](#beat-2--0150045--it-is-really-in-slack)), and build the
video on the replay.

## Which provider you record with — decide this first

There is a `.env` in the repo now, and it selects `LLM_PROVIDER=openai`. That
changes what the take looks like, so choose deliberately instead of finding out
while recording.

| | `fake` | `openai` |
| --- | --- | --- |
| Run to run | **identical, every time** | varies |
| Interventions in this transcript | **always 3** | measured 0, 1, 2 and 3 across four runs |
| What the agent says | a restatement of the problem | a real answer that names who to ask |
| Costs money | no | yes |

**The numbers in this script are the `fake` numbers.** Every count below — 3
interventions, 8 silences, 4 silence reasons — is what the deterministic
provider produces. With `openai` they will not match, and a take can come out
with the agent staying quiet all eleven times, which is not the video you want.

To pin the deterministic run, put it in front of the command. A shell variable
beats the `.env` file:

```bash
LLM_PROVIDER=fake npm run replay:demo
```

**Recommendation.** Record the replay with `fake`: it is the version this
script describes, it cannot surprise you, and it cannot fail because somebody's
API quota ran out mid-take. Then use `openai` for the live Slack segment in
beat 2, where the message quality is what you are showing off and a single good
take is all you need.

If you do record the replay with `openai`, run it three times first and keep
recording until you get a take with at least two interventions. Do not narrate
counts you have not just seen on screen.

## Measured timings

Wall clock, on a cold run, `LLM_PROVIDER=fake`:

| Command | Duration | Produces |
| --- | --- | --- |
| `npm run replay:demo` | **26s** | 11 events, 3 interventions, 8 explained silences, 4 distinct silence reasons |
| `npm run replay:silence` | **18s** | 8 events, 0 interventions, 8 silences |
| `npm run replay:meet` | **16s** | 7 events, 1 private intervention, 6 silences |

Pacing is capped at 2.5s between blocks regardless of `--speed`, so a twelve
minute conversation always plays in about twenty-five seconds. Append
`-- --speed 0` to any of them to dump the whole run in **0.6s**, which is what
you want when you need to scroll back rather than watch it arrive.

The whole take is 26s of demo plus 16s of meet inside a 120s video. The
remaining 78 seconds are you talking. That is the right ratio.

## Before you hit record

Run this block. All of it. It takes forty seconds and it removes every reason
a take gets thrown away.

```bash
# 0. Node 22.13 or newer. The meeting memory uses node:sqlite, so `npm run ci`
#    dies on the browser checks without it. The replay itself still runs on
#    older Node -- the check suite does not, and you are the one who runs the
#    drill at a checkpoint.
node -v

# 1. Clean state. decisions.jsonl APPENDS across runs: a stale file makes the
#    jq counts in beat 3 lie, and that is the one number a judge might check.
rm -rf logs/

# 1b. Pin the provider. Without this the .env picks openai and the counts in
#     this script stop matching. See the section above.
export LLM_PROVIDER=fake

# 2. Prove the machine is green before the camera is on, not after.
npm run ci

# 3. A throwaway run so the first take is not also the first time you see it.
npm run replay:demo
```

Then the terminal itself:

- **Font size up first, not after.** Text must be legible at 720p. Roughly 18–20pt.
- **Window at about 100 columns.** The log truncates text at 88 characters;
  narrower than that and the `because` lines wrap into mush.
- Dark background, and leave the colours on — `STAY QUIET` is yellow and
  `SPEAK` is green only when stdout is a TTY, which it is in a terminal and is
  not in a pipe.
- Clear the scrollback (`clear`) so the first thing on screen is your command.
- Turn off notifications. A Slack toast over your own demo is a bad look.

## The script

| Time | You type | On screen | You say |
| --- | --- | --- | --- |
| 0:00–0:15 | nothing | title card or the channel | "Every agent you have used lives in a window you have to go visit. This one lives in the channel you are already in. Nobody invites it. Nobody mentions it. And most of the time, it says nothing." |
| 0:15–0:45 | nothing (B-roll) | the Slack recording | "Here it is in a real workspace. Ana asks whether the deploy went out. Two people talk past it. The agent answers on its own — nobody invoked it." |
| 0:45–1:20 | `npm run replay:demo` | the decision log, 26s | **the winning beat, scripted below** |
| 1:20–1:45 | `npm run replay:meet` | 16s, then the summary | "Same core, different surface. This is a live interview instead of Slack, and nothing in `core/` changed — CI fails the build if anything in there so much as imports a Slack SDK." |
| 1:45–2:00 | nothing | repo / summary on screen | "Three hours, four people. What is next is more surfaces and a better veto. Thanks." |

### Beat 2 — 0:15–0:45 — it is really in Slack

Record this **early**, at CP2, while Slack definitely works. Thirty seconds of
screen capture:

1. the `#product` channel with the conversation already in it
2. Ana's question sitting unanswered
3. the agent's reply appearing without anyone typing `@`

No narration inside the capture. You talk over it in the edit.

If Slack never worked, cut this beat and give the thirty seconds to beat 3.
Say out loud in the description that the demo is a reproducible replay. A
deterministic demo is a feature; apologising for it turns it into an excuse.

### Beat 3 — 0:45–1:20 — the part that wins it

Type the command, then **stop talking for four seconds** and let the blocks
arrive. The silence in the room while the silences scroll is the whole pitch.

```bash
npm run replay:demo
```

Then talk over it. Three blocks, in the order they appear. Do not read every
line — point at these:

**At about 8 seconds in**, the agent speaks:

```
14:02:30 #product Mar: brb
  saw      unanswered_question (0.78) Ana asked a question and 2 later message(s) went past without answering it.
  decided  SPEAK -> post in C09PRODUCT [unanswered_question_timeout]
```

> "It waited. One message went past, confidence 0.58 — under the bar, stayed
> quiet. Two messages, 0.78 — now it speaks."

**Three seconds later**, the line this project is about:

```
14:03:40 #product Luis: we should clean up the old feature flags at some point
  saw      plan_without_owner (0.66) Luis proposed something with no owner and no date attached.
  decided  STAY QUIET [cooldown_active]
  because  Already spoke here 70s ago. Holding for 120s so the agent does not dominate the channel.
```

> "It saw a real signal here — a plan with nobody's name on it. And it stayed
> quiet, because it had spoken seventy seconds ago. That is not a bug being
> logged. That is the decision."

**At the end**, the one that reads best out loud:

```
14:11:30 #product Ana: who is actually doing the flag cleanup?
  decided  STAY QUIET [duplicate_of_recent_action]
  because  Same plan_without_owner for the same person was handled 150s ago.
```

> "A human asks the same thing again. The agent already handled it privately,
> so it does not repeat itself in public."

Land on the summary:

```
  events seen     11
  spoke           3
  stayed quiet    8
```

> "Eleven messages. It spoke three times and chose silence eight, and every one
> of those eight has a typed reason you can query."

If you have five spare seconds, this is the strongest thing you can put on
screen after the log:

```bash
cat logs/decisions.jsonl | jq -r 'select(.decision.act == false) | .decision.reason_code' | sort | uniq -c
```

```
      1 below_confidence_threshold
      3 cooldown_active
      1 duplicate_of_recent_action
      3 no_actionable_signal
```

> "Four different reasons to say nothing. The silence is queryable."

### Beat 4 — 1:20–1:45 — the architecture

Do not draw a diagram on camera. Run the thing:

```bash
npm run replay:meet
```

It prints `Interview - Backend Engineer` instead of `#product`, and the one
intervention is a **direct message to Dana**, never a broadcast:

```
  decided  SPEAK -> direct message to U-DANA [unanswered_question_timeout]
  because  ... Surfacing privately to the person being supported.
```

> "Same core, same policy, same prompts. The surface is a live interview and the
> agent routes privately to the interviewer instead of posting. The core does
> not know Slack exists, and that is enforced, not promised."

If you are short on time, cut the run and show only this:

```bash
npm run check:boundaries
# Boundaries OK: N files, core/ has no idea what Slack is.
```

## Where the takes go

Record into a scratch folder, not the repo. `logs/` is gitignored but video
files are not, and nobody wants a 200MB commit at T+165.

## When it breaks

| Symptom | Fix, in under a minute |
| --- | --- |
| `npm run replay:demo` errors | `rm -rf node_modules && npm install`. The replay path has zero SDK dependencies; if it still fails, `npm run smoke` will say which check broke. |
| Blocks arrive too slowly | `npm run replay -- --transcript fixtures/transcripts/demo-main.json --dry-run --speed 0` dumps the whole run instantly. Scroll instead of waiting. |
| No colour in the recording | You are piping stdout somewhere. Record the terminal directly. |
| The counts do not match this file | You did not `rm -rf logs/`, or somebody changed `demo-main.json`. `npm run smoke` asserts the shape of all three runs — run it. |
| Slack is down | You are already recording a replay. Say so in the description and keep going. |
| No video at all at T+165 | One take, no narration, `npm run replay:demo`, subtitles later. Forty seconds of a working decision log beats nothing. See [ENTREGA.md](../ENTREGA.md). |

## Locked

`fixtures/transcripts/demo-main.json` is the demo. It is locked: 11 events, 3
interventions, 8 silences, 4 distinct silence reasons (exactly the bar
CHECKPOINTS.md sets for CP2). `npm run smoke` asserts
that shape, so a change to the transcript that breaks the story breaks CI
instead of breaking the take.

Changing it after CP3 is not a tweak, it is a re-record.
