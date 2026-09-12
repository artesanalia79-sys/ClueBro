# Meeting integration review

Reviewed remote heads on 2026-09-12:

| Branch | Commit | Status |
| --- | --- | --- |
| main | 8369ae4 | Contains harness and action via PRs #1 and #4, plus earlier adapters via #2 |
| action | f9dc146 | Already included in main; do not merge a second time |
| adapters | f026595 | Persistent meeting memory and extension |
| detection | f7762c6 | Separate timing change, not yet included in main |

`integration/meeting-main` combines the adapters work with main. There were no
textual conflicts. Automatic merging duplicated `PRINCIPAL_ACTOR_ID` and
`BROWSER_BRIDGE_PORT` in `.env.example`; those entries are now unique, and the
harness config check catches duplicate keys as well as undocumented keys.

## How the components fit

1. The browser bridge validates and persists a caption before acknowledging it.
2. New captions enter the existing harness window and detector. The action policy
   decides whether to surface private help. Main's logging and silence metrics
   apply unchanged.
3. The extension retrieves earlier meeting excerpts from its project's durable
   memory. This is separate from action-policy decisions and their cooldowns.
4. Finishing a meeting organizes source-backed notes; querying memory can produce
   an AI answer using retrieved excerpts. Neither operation posts into Meet.

No shared contracts or core-to-adapter boundaries changed. The new action policy
does not prevent caption persistence: even a silent decision is archived.
Historical excerpts are not fed back into the detector as if they were fresh
captions, so they do not distort reply counts or trigger old conversations again.

## Findings before release

### High: action treats unrelated replies as answers

`core/action/policy.ts` implements `answersQuestion()` using a four-word minimum
and an English deferral blacklist. It does not check relevance or reject questions.
With a high-confidence unanswered-question observation citing “Did the deploy go
out?”, a different participant saying any of these produces
`already_answered_by_human`:

- “Can you repeat that question?”
- “The cafeteria is closed today.”
- “No sé la respuesta todavía.”

These cases were reproduced against the combined branch. Current CI passes
because the action checks cover a real answer and an English deferral, not these
counterexamples. Preserve this distinction when fixing the action policy: reply
length alone cannot establish that the cited question was answered. Add regression
cases before changing the semantic gate; coordinate that change with detection.
This review does not alter the teammate's answer-classification behavior.

### Pending decision: v2 prompts are present but not active

Action adds `should_intervene.v2.md`, `channel_reply.v2.md`, and
`direct_message.v2.md`. `prompts/registry.json` still selects v1 for all three.
The TypeScript policy and fallback changes run, but the new prompt wording does
not run by default. Keep activation as an explicit, evaluated change rather than
silently changing it during a merge.

### Separate follow-up: detection timing

The detection branch introduces deterministic timing: one reply caps confidence,
two permit reporting, and three or more suppress an older question. It also
limits search/plan reports to the latest event. It changes no contracts and has
its own tests. Review and merge it separately so changes to silence counts and
the demo's expected shape can be attributed to that branch. It is not included
in this integration candidate.

## Validation and rollout

`npm run ci` passes on the combined code, including the action, adapter, meeting
memory, panel, harness, secret-scan and smoke checks. The additional config check
guards the duplicate defaults found during integration. No live Slack messages,
Meet calls or paid model requests were used for this review.

Recommended sequence: resolve the action finding, choose/evaluate prompt versions,
then submit this integration branch as a PR to main. Keep detection as a separate
PR with replay verification. Main is protected and receives changes through PRs;
this review does not push or merge into main.
