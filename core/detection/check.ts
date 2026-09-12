/**
 * Detection checks. Timing is a pure function, so the rules that decide when a
 * need is reported can be asserted with no model, no prompt and no pipeline.
 *
 *   npm run check:units
 *
 * Conversations are built inline on purpose: demo-main.json belongs to the demo
 * and may change, and these rules must not change with it.
 */
import type { ContextEvent } from "@contracts";
import { applyTiming, ONE_REPLY_MAX_CONFIDENCE } from "./timing";
import { check, checkEqual, report } from "../../scripts/expect";

let seq = 0;

const say = (actor: string, text: string, isAgent = false): ContextEvent => {
  seq++;
  return {
    schema_version: "1.0.0",
    event_id: `e${seq}`,
    source: { adapter: "test", surface_id: "S1", surface_type: "group" },
    actor: { actor_id: actor, display_name: actor, is_agent: isAgent },
    occurred_at: new Date(Date.UTC(2026, 8, 12, 14, 0, seq)).toISOString(),
    text,
    thread_id: null,
    reply_to_event_id: null,
    mentions: [],
    metadata: {},
  } as ContextEvent;
};

// --- questions -------------------------------------------------------------

{
  const q = say("ana", "did the staging deploy go out?");
  const t = applyTiming("unanswered_question", 0.8, q.event_id, [q]);
  checkEqual("a question nobody has had a chance to answer is not reported", t.kind, "no_signal");
  check("and the silence says why", t.note !== null);
}

{
  const q = say("ana", "did the staging deploy go out?");
  const t = applyTiming("unanswered_question", 0.8, q.event_id, [q, say("luis", "gonna grab coffee")]);
  checkEqual("one reply past a question is still an unanswered question", t.kind, "unanswered_question");
  check(
    "but stays under the speak bar",
    t.confidence <= ONE_REPLY_MAX_CONFIDENCE,
    `confidence ${t.confidence}`,
  );
}

{
  const q = say("ana", "did the staging deploy go out?");
  const t = applyTiming("unanswered_question", 0.8, q.event_id, [
    q,
    say("luis", "gonna grab coffee"),
    say("mar", "brb"),
  ]);
  checkEqual("two replies past it make it worth reporting", t.kind, "unanswered_question");
  checkEqual("with the model's own confidence", t.confidence, 0.8);
}

{
  const q = say("ana", "did the staging deploy go out?");
  const t = applyTiming("unanswered_question", 0.8, q.event_id, [
    q,
    say("ana", "anyone?"),
    say("luis", "gonna grab coffee"),
  ]);
  check(
    "the asker's own follow-up does not count as a reply going past",
    t.confidence <= ONE_REPLY_MAX_CONFIDENCE,
    `confidence ${t.confidence}`,
  );
}

{
  const q = say("ana", "did the staging deploy go out?");
  const t = applyTiming("unanswered_question", 0.8, q.event_id, [
    q,
    say("agent", "here is what I found", true),
    say("luis", "gonna grab coffee"),
  ]);
  check(
    "the agent's own messages never count as replies",
    t.kind === "unanswered_question" && t.confidence <= ONE_REPLY_MAX_CONFIDENCE,
    `${t.kind} ${t.confidence}`,
  );
}

{
  const q = say("ana", "did the staging deploy go out?");
  const t = applyTiming("unanswered_question", 0.8, q.event_id, [
    q,
    say("luis", "gonna grab coffee"),
    say("mar", "brb"),
    say("luis", "we should clean up the old flags at some point"),
  ]);
  checkEqual("a question three replies old was already reported, so it is not repeated", t.kind, "no_signal");
}

// --- searches and plans ----------------------------------------------------

{
  const s = say("mar", "I cannot find the Q2 churn number anywhere");
  const t = applyTiming("information_gap", 0.85, s.event_id, [say("luis", "morning"), s]);
  checkEqual("a search is reported on the line that states it", t.kind, "information_gap");
}

{
  const s = say("mar", "I cannot find the Q2 churn number anywhere");
  const t = applyTiming("information_gap", 0.85, s.event_id, [s, say("luis", "thanks!")]);
  checkEqual("a search already open before the newest line is not repeated", t.kind, "no_signal");
}

{
  const agreed = say("mar", "let's do the flag cleanup next week");
  const t = applyTiming("plan_without_owner", 0.85, agreed.event_id, [
    say("luis", "we should clean up the old flags at some point"),
    agreed,
  ]);
  checkEqual("a plan is reported on the line where it was agreed", t.kind, "plan_without_owner");
}

{
  const agreed = say("mar", "let's do the flag cleanup next week");
  const t = applyTiming("plan_without_owner", 0.85, agreed.event_id, [
    agreed,
    say("ana", "who is actually doing the flag cleanup?"),
  ]);
  checkEqual(
    "asking who owns an open plan rechecks it so policy can record a duplicate",
    t.kind,
    "plan_without_owner",
  );
}

// --- honesty ---------------------------------------------------------------

{
  const t = applyTiming("information_gap", 0.9, "not-in-window", [say("mar", "I cannot find the doc")]);
  checkEqual("a need citing a line outside the window becomes no_signal", t.kind, "no_signal");
}

{
  const t = applyTiming("no_signal", 0.2, null, [say("ana", "morning all")]);
  check("no_signal passes through untouched", t.kind === "no_signal" && t.confidence === 0.2 && t.note === null);
}

report("core/detection timing");
