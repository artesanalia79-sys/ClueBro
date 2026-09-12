# adapters/replay

The most valuable adapter in this repo, and the one to build first.

It reads a saved conversation from a JSON file and feeds it to the agent as
`ContextEvent`s. No Slack, no network, no typing messages into a channel by
hand.

That buys three things:

1. **A two second iteration loop** on detection logic. Change a threshold or a
   prompt, run it, see every decision again.
2. **A reproducible run.** Same input, same output, every time, so a prompt
   change is measurable instead of arguable.
3. **A demo that cannot be taken away.** If Slack rate limits, the workspace
   misbehaves, or the conference wifi dies five minutes before the deadline,
   the video still gets recorded.

## How I run this alone

```bash
npm run replay:demo        # the demo conversation
npm run replay:silence     # a conversation the agent should ignore entirely
npm run replay:meet        # the stage 2 surface, a live meeting
npm run replay -- --transcript fixtures/transcripts/demo-main.json --speed 0
```

`--speed` controls pacing: `1` is the original timing, `6` is six times
faster, `0` fires everything immediately. Long pauses are capped at 2.5s so a
twelve minute conversation never stalls a recording.

## Writing a new transcript

A transcript is a JSON array of `ContextEvent`. The quickest way is to copy
`fixtures/transcripts/demo-main.json` and edit the `text` and `occurred_at`
fields. CI validates every transcript against the contract, so a typo fails
the build rather than the demo.

Timestamps matter more than they look. The pipeline runs replays on a
**conversation clock** (`harness/clock.ts`), so the two minute cooldown in
`core/action` is measured against the times in the file, not against how long
the run takes. Put two signals 30 seconds apart and the second one will be
suppressed as `cooldown_active` — which is a real behaviour worth showing.

## What is in here

- `createReplayInbound({ path, speed })` — the file as an event stream
- `createConsoleOutbound(label)` — prints what would have been sent. Used for
  replay, and as the safe default anywhere a real adapter is not configured
- `loadTranscript(path)` — validates and returns the events, used by
  `prompts/bin/eval.ts` too
