# contracts

The single source of truth between the four of us. Everything else in this
repo is a leaf that depends on this folder.

**Owner: nobody.** This folder is shared, and after checkpoint 1 it is frozen.
A schema change changes all four folders at once, so it happens at a
checkpoint, out loud, with everyone present. Adding an optional field with a
default is cheap. Renaming or removing anything is not.

## What is in here

| File | What it defines |
| --- | --- |
| `src/context-event.ts` | `ContextEvent` — one normalized thing that happened in a conversation. The only inbound shape the core ever sees. |
| `src/observation.ts` | `Observation` — what the detector concluded from a window of events, including `no_signal`. |
| `src/action-decision.ts` | `ActionDecision` — speak or stay quiet, with what confidence, through which route, and why. |
| `src/action-result.ts` | `ActionResult` — what happened when we tried to deliver it. |
| `src/decision-log-record.ts` | The four joined together. What the harness logs and what the demo shows. |
| `src/ports.ts` | The interfaces: `InboundAdapter`, `OutboundAdapter`, `Detector`, `ActionEngine`, `LlmClient`, `PromptRegistry`, `Clock`, `Logger`. |
| `src/factories.ts` | Builders that produce contract-valid payloads. Use these instead of object literals. |
| `fixtures/` | A worked example of every contract, plus examples that must be REJECTED. |

## How I run this alone

```bash
npm run validate:contracts
```

It checks three things:

1. every fixture under `fixtures/<contract>/` parses
2. every fixture under `fixtures/invalid/` **fails** to parse — a schema that
   accepts everything protects nothing
3. every replay transcript in `fixtures/transcripts/` is a list of valid
   `ContextEvent`s

## Two invariants worth knowing

`ActionDecision` enforces these in the schema, so no component can get them
wrong on its own:

- `act: true` requires a `delivery` AND a `draft` AND an act reason
- `act: false` requires `delivery: null` AND `draft: null` AND a silence reason

That is what stops the classic bug: deciding not to speak, and speaking anyway.

## The rule about metadata

`ContextEvent.metadata` is an adapter-specific passthrough. The core MUST NOT
read it. It exists so the outbound side of the same adapter can recover what
it needs (a Slack thread timestamp, a caption offset) without that leaking
into the contract.

## Adding a field without breaking anyone

```ts
// safe: optional, with a default. Old payloads still parse.
new_field: z.string().nullable().default(null),
```

Anything else waits for a checkpoint.
