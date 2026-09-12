# Integration checkpoints

Three hours, three checkpoints, roughly every 45 minutes. At each one everybody
merges to `main` and we run the real flow with no mocks for ten minutes.

```bash
npm run clock:start    # once, on one machine, at the start
npm run clock          # what time is the next checkpoint
```

## The rule that matters most

> **If a checkpoint fails, we revert. We do not debug on `main`.**

`main` goes back to the last commit where `npm run ci` was green, and whoever
broke it fixes it on their own branch while the other three keep going. Nobody
watches one person debug. Person 4 makes the call, and the call is not
negotiable at minute 100.

`git revert -m 1 <merge commit>` keeps history honest. Use that, not
`reset --hard`, because somebody else has already pulled.

---

## CP1 — T+45 — the skeleton is alive

**Goal:** every folder is merged and the whole thing runs end to end, even
trivially. First the complete skeleton, then the intelligence. A clever
detector wired to nothing is worth zero at T+180.

Merge order: `adapters`, then `detection`, then `action`, then `harness`.

Ten minute drill:

```bash
git checkout main && git pull
npm ci
npm run ci               # typecheck, boundaries, contracts, units, smoke
npm run replay:demo      # everybody watches this together
npm run dev:dry          # somebody types in the real channel
```

Pass means: a message typed in the real Slack channel produces a decision block
in the log, and `npm run replay:demo` produces at least one intervention and
several explained silences.

**Also at CP1:** `contracts/src/**` and `prompts/loader.ts` are declared frozen.
After this point a schema change is a team decision, announced out loud.

---

## CP2 — T+90 — it works for real

**Goal:** the agent reads a live channel and posts once, on purpose, with a
real model.

Ten minute drill:

```bash
git checkout main && git pull
npm run ci
LLM_PROVIDER=openai npm run dev:dry     # three or four real messages
LLM_PROVIDER=openai npm run dev         # let it post exactly once
```

Pass means: one real message in a real channel that a stranger would agree was
useful, and at least four distinct silence reasons visible in the log from the
same session.

If the agent is too chatty, raise `POLICY_MIN_CONFIDENCE_PUBLIC` and move on.
Do not redesign the detector at T+90.

**Decide at CP2, out loud:** does the browser adapter ship? If it is not
accepting captions from a real Meet call by now, cut it and say so. A cut
feature costs nothing; a half-finished one costs the demo.

---

## CP3 — T+135 — freeze

**Goal:** nothing new. Demo script locked, recording started.

```bash
git checkout main && git pull
npm run ci
npm run replay:demo      # the take that goes in the video
```

After CP3 the only commits allowed are:

- a fix for something broken in the demo path
- README, ENTREGA.md and docs

Not allowed: a new detector kind, a new adapter, a refactor, "one more prompt
tweak". If it is not in the video it does not exist.

**T+150: stop building.** The last 30 minutes are for submitting. See
[ENTREGA.md](ENTREGA.md).

---

## What each checkpoint costs if you skip it

- Skip CP1 and you find out at T+120 that two people built against different
  assumptions about `Observation`.
- Skip CP2 and you find out at T+160 that the bot was never invited to the
  channel.
- Skip CP3 and you submit no video.
