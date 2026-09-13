# ClueBro

[![ci](https://github.com/artesanalia79-sys/ClueBro/actions/workflows/ci.yml/badge.svg)](https://github.com/artesanalia79-sys/ClueBro/actions/workflows/ci.yml)

An agent that lives inside a Slack workspace as one more member of the team.

Nobody invites it into a conversation. Nobody mentions it. It reads the
channels, works out on its own when it has something genuinely useful to add,
and — most of the time — decides to say nothing.

The interesting part is not the messages it sends. It is the running account of
what it saw and what it decided **not** to do about it.

```
14:03:40 #product Luis: we should clean up the old feature flags at some point
  saw      plan_without_owner (0.66) Luis proposed something with no owner and no date attached.
  decided  STAY QUIET [cooldown_active]
  because  Already spoke here 70s ago. Holding for 120s so the agent does not dominate the channel.
```

## Run it in 30 seconds

No Slack account, no API key, no network:

```bash
npm install
npm run replay:demo
```

Node 22.13 or newer. The replay itself runs on older Node; `npm run ci` does
not, because the meeting memory uses the built-in `node:sqlite`.

That replays a saved conversation through the real pipeline and prints every
decision. Then:

```bash
npm run replay:silence    # a conversation it should ignore completely
npm run replay:meet       # the same core on a live meeting surface
npm run ci                # typecheck, boundaries, contracts, end to end
```

## Run it against live Slack

```bash
cp .env.example .env      # add SLACK_BOT_TOKEN and SLACK_APP_TOKEN
npm run dev:dry           # reads a real channel, decides, sends nothing
npm run dev               # actually posts
```

App setup, scopes, and what breaks without each one:
[adapters/slack/README.md](adapters/slack/README.md).

## How it is put together

```
          ┌─────────────────┐
 Slack ──►│                 │
          │  ContextEvent   │──► core/detection ──► Observation
 Meet  ──►│   (contract)    │                            │
          │                 │                            ▼
 file  ──►└─────────────────┘                      core/action
                   ▲                                     │
                   │                                     ▼
            adapters/*  ◄──────── ActionDecision ────────┘
                   │              (who, how public)
                   ▼
             ActionResult
```

One rule holds the whole thing up:

> **The core does not know that Slack exists.**

It receives `ContextEvent`s through an adapter port and returns `Delivery`
instructions that say *this person, privately* or *this surface, publicly*. An
adapter works out what that means. Slack is the first adapter; a browser
extension in a live meeting is the second, and it required no change to
`core/`.

This is not an aspiration in a document. `npm run check:boundaries` fails the
build if anything under `core/` imports a Slack SDK, an adapter, the harness, a
model vendor, or reads `process.env`.

## The four folders

| Folder | Job | Read |
| --- | --- | --- |
| [`contracts/`](contracts/) | the schemas every component agrees on. Shared, frozen after checkpoint 1 | [README](contracts/README.md) |
| [`adapters/`](adapters/) | surfaces in and out: Slack, replay, browser | [slack](adapters/slack/README.md) · [replay](adapters/replay/README.md) · [browser](adapters/browser/README.md) |
| [`core/detection/`](core/detection/) | is there anything here worth a reply, and what is it | [README](core/detection/README.md) |
| [`core/action/`](core/action/) | should we speak, to whom, saying what | [README](core/action/README.md) |
| [`harness/`](harness/) | orchestration, observability, the demo | [README](harness/README.md) |
| [`prompts/`](prompts/) | the agent behaviour, as versioned files | [README](prompts/README.md) |

Every folder runs on its own, with mocks of the others built from the shared
fixtures. Nobody waits for anybody.

## Why silence is the feature

An agent that replies to everything is noise, and noise is what makes people
mute a bot on day two. So the decision to speak passes two gates:

1. **Arithmetic** — confidence thresholds, a per-channel cooldown, deduping,
   and a refusal to act on a claim with no cited evidence. A public post needs
   a higher bar than a private message, because a public mistake is louder.
2. **Judgement** — one model call that can veto a decision the thresholds
   already allowed, for the cases that are technically valid and still
   annoying.

Both gates record a typed reason. `SilenceReason` is an enum, never a free
string, because those reasons end up on screen.

## Stage 2

The same core, fed by a browser extension during a live interview, showing
contextual support to the interviewer. Transparent and consented by design:
the panel is visible, every card shows its sources, the agent never writes
into the meeting, and the outbound adapter refuses a public delivery outright.
The professional keeps the judgement; the agent brings references.

Try it with no Chrome and no meeting: `npm run replay:meet`.

## Team docs

- [TEAM.md](TEAM.md) — who owns what, first tasks, and a paste-ready brief per
  person
- [CHECKPOINTS.md](CHECKPOINTS.md) — the three integration checkpoints and the
  revert rule
- [CONTRIBUTING.md](CONTRIBUTING.md) — branches, PRs, what is frozen
- [ENTREGA.md](ENTREGA.md) — the submission checklist
