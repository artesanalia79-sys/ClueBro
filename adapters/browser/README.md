# adapters/browser

Stage 2, and the proof that the architecture is real: the same agent core, fed
by a browser extension during a live meeting, with nothing in `core/` changed.

Today this is the second adapter, not the demo we depend on. If it lands, the
demo gets much stronger because it shows one core on two surfaces. If it does
not land by T+120, it gets cut and nobody else is affected.

## The use case

Support for an **interviewer** during a live interview. The candidate asks
something the interviewer does not have to hand, or mentions something worth
following up on, and the agent surfaces context — with sources — in a panel
only the interviewer sees.

This is transparent, consented support:

- the panel is visible to the person using it, and to anyone looking at their
  screen
- every card shows where its claim came from, plus the confidence and the
  reason code
- the agent never writes into the meeting. The outbound adapter **refuses** a
  public delivery outright, so the core cannot broadcast even by mistake
- the professional keeps the judgement. The agent brings references, it does
  not answer for them

## How it fits together

```
Meet tab
  content.js  --POST /captions-->  bridge (node)  -->  ContextEvent
                                                        surface_type: live_meeting
  panel.css   <--SSE /suggestions--  bridge       <--  ActionDecision
                                                        target: actor, private
```

The core sees `ContextEvent`s with `surface_type: "live_meeting"` and returns
a `Delivery`. It does not know a browser exists, exactly as it does not know
Slack exists.

## How I run this alone

### Without a meeting, without Chrome

```bash
npm run replay:meet
```

This replays `fixtures/transcripts/meet-interview.json`, which is a real
interview shaped as `ContextEvent`s from the `browser` adapter. It proves the
routing: the agent surfaces privately to the interviewer, never to the room.

### With the bridge, without a meeting

```bash
PRINCIPAL_ACTOR_ID=U-PRINCIPAL npm run dev -- --adapter browser --dry-run
curl -X POST http://127.0.0.1:8787/captions \
  -H 'content-type: application/json' \
  -d '{"meeting_id":"test","speaker_name":"Sam","speaker_role":"candidate","text":"what does the on-call rotation look like for this team?"}'
```

Send three or four lines and watch the decision log. `GET /health` confirms
the bridge is up.

### With a real meeting

1. `chrome://extensions`, enable **Developer mode**, **Load unpacked**, and
   pick `adapters/browser/extension/`.
2. Start the bridge: `npm run dev -- --adapter browser`.
3. Join a Meet call and **turn captions on** (the extension reads captions, it
   does not touch audio).
4. The panel appears bottom right and shows `connected`.

## The fragile part, stated plainly

Google Meet has no public caption API. `content.js` reads the caption DOM, and
those selectors change. Expect to open DevTools on the day, find the caption
container, and add its selector to `CAPTION_SELECTORS`.

That is a ten minute job, not a redesign: the bridge only ever receives text,
so nothing downstream cares. Budget those ten minutes or cut the adapter — do
not spend an hour on it.
