import assert from "node:assert/strict";
import type { App } from "@slack/bolt";
import { actDecision, dmDelivery, makeObservation, surfaceDelivery } from "@contracts";
import { toContextEvent, toPlainText } from "./slack/inbound";
import { createSlackOutbound, formatMessage } from "./slack/outbound";

assert.equal(
  toPlainText("<@U123> <@U456|Sam> see <https://example.com|the guide> <https://example.org> <#C123|demo> &amp; notes"),
  "see the guide https://example.org #demo & notes",
);

const input = {
  message: { channel: "C123", user: "U123", ts: "1789239776.927039", text: "Where is the guide?" },
  botUserId: "UBOT",
  displayName: "Sam",
  surfaceLabel: "#demo",
};
for (const subtype of ["channel_join", "group_join", "message_changed", "message_deleted"]) {
  assert.equal(toContextEvent({ ...input, message: { ...input.message, subtype } }), null);
}
assert.equal(toContextEvent({ ...input, message: { ...input.message, user: "UBOT" } })?.actor.is_agent, true);
assert.equal(toContextEvent({ ...input, message: { ...input.message, bot_id: "B123" } })?.actor.is_agent, true);
const event = toContextEvent(input);
assert.ok(event);
assert.equal(event.actor.is_agent, false);
assert.equal(event.actor.display_name, "Sam");
assert.equal(event.text, input.message.text);

const observation = makeObservation({
  events: [event], kind: "information_gap", summary: "Sam needs the guide.", confidence: 0.9,
  evidence: [{ event_id: event.event_id, actor_id: event.actor.actor_id, quote: event.text }],
  subjectActorId: event.actor.actor_id,
  detector: { name: "adapter-test", version: "1", prompt_id: null, prompt_version: null, model: null, latency_ms: 0 },
});
const decision = actDecision({
  observation, reason: "information_gap_resolvable", rationale: "The guide is available.",
  delivery: surfaceDelivery({ surfaceId: "C123", inReplyToEventId: event.event_id }),
  draft: { body: "Here is the guide.", sources: [
    { label: "Guide", ref: "https://example.com/guide" },
    { label: "Conversation", ref: event.event_id },
  ] },
  policy: { version: "1", min_confidence: 0.62, min_confidence_public: 0.72, cooldown_seconds: 120, cooldown_active: false },
  decidedBy: { engine: "adapter-test" },
});
for (const source of decision.draft!.sources) {
  assert.ok(formatMessage(decision).includes(`${source.label} (${source.ref})`));
}
const originalSources = decision.draft!.sources;
decision.draft!.sources = [];
assert.ok(formatMessage(decision).includes(event.event_id));
decision.delivery!.in_reply_to_event_id = null;
assert.ok(formatMessage(decision).includes("_Based on:_\nNo sources provided."));
decision.draft!.sources = originalSources;
decision.delivery!.in_reply_to_event_id = event.event_id;

const calls: Array<{ channel: string; thread_ts?: string }> = [];
const openedUsers: string[] = [];
let failure: string | undefined;
const app = { client: {
  conversations: { open: async ({ users }: { users: string }) => {
    openedUsers.push(users);
    if (failure) throw { data: { error: failure } };
    return { channel: { id: "D123" } };
  } },
  chat: { postMessage: async (message: { channel: string; thread_ts?: string }) => {
    if (failure) throw { data: { error: failure } };
    calls.push(message);
    return { ts: "1789239785.636769" };
  } },
} } as unknown as App;
const outbound = createSlackOutbound({ app });
assert.equal((await outbound.deliver(decision)).status, "delivered");
assert.equal(calls[0]?.thread_ts, input.message.ts);
decision.delivery!.thread_id = "1789239700.000001";
await outbound.deliver(decision);
assert.equal(calls[1]?.thread_ts, "1789239700.000001");
for (const code of ["missing_scope", "not_in_channel", "channel_not_found"]) {
  failure = code;
  const result = await outbound.deliver(decision);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.error, { code, message: code });
}
failure = undefined;
decision.delivery = dmDelivery({ actorId: "U123", surfaceId: "C123" });
assert.equal((await outbound.deliver(decision)).status, "delivered");
assert.deepEqual(openedUsers, ["U123"]);
assert.equal(calls[2]?.channel, "D123");
assert.equal(calls[2]?.thread_ts, undefined);
failure = "missing_scope";
assert.equal((await outbound.deliver(decision)).error?.code, "missing_scope");
assert.equal(calls.length, 3, "A failed DM must never fall back to a public message.");
console.log("Adapters: normalization, subtypes, bot identity, sources, threads, DM routing and error checks passed.");
