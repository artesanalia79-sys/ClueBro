/**
 * Policy checks. `evaluate()` is a pure function, so the silence rules can be
 * asserted directly with no model, no adapter and no pipeline.
 *
 *   npm run check:units
 *
 * These are the rules the demo depends on. Add a case here whenever you
 * change a threshold, so a tuning session at minute 100 cannot quietly break
 * the behaviour you showed at minute 60.
 */
import { ObservationSchema, type ContextEvent, type Observation } from "@contracts";
import { DEFAULT_POLICY_CONFIG, emptyPolicyState, evaluate } from "./policy";
import { parseVeto } from "./index";
import { check, report } from "../../scripts/expect";

const AT = "2026-09-12T14:00:00.000Z";

const event = (overrides: Partial<ContextEvent> = {}): ContextEvent =>
  ({
    schema_version: "1.0.0",
    event_id: "e1",
    source: { adapter: "test", surface_id: "S1", surface_type: "group" },
    actor: { actor_id: "A1", display_name: "A", is_agent: false },
    occurred_at: AT,
    text: "hello there everyone",
    thread_id: null,
    reply_to_event_id: null,
    mentions: [],
    metadata: {},
    ...overrides,
  }) as ContextEvent;

const observation = (over: Partial<Observation> = {}): Observation =>
  ObservationSchema.parse({
    schema_version: "1.0.0",
    observation_id: "obs_test",
    window: {
      surface_id: "S1",
      surface_type: "group",
      first_event_id: "e1",
      last_event_id: "e1",
      event_count: 3,
      started_at: AT,
      ended_at: AT,
    },
    kind: "unanswered_question",
    summary: "a question went unanswered",
    evidence: [{ event_id: "e1", actor_id: "A1", quote: "why" }],
    subject_actor_id: "A1",
    confidence: 0.8,
    detector: { name: "test", version: "1", latency_ms: 0 },
    created_at: AT,
    ...over,
  });

const now = new Date(AT);
const window = [event()];
const config = { ...DEFAULT_POLICY_CONFIG };

// --- silence ---------------------------------------------------------------

const noSignal = evaluate(
  observation({ kind: "no_signal", evidence: [], subject_actor_id: null, confidence: 0.05 }),
  window,
  emptyPolicyState(),
  config,
  now,
);
check("no_signal never speaks", noSignal.act === false);
check(
  "and reports no_actionable_signal",
  !noSignal.act && noSignal.reason === "no_actionable_signal",
  !noSignal.act ? noSignal.reason : "",
);

const unsupported = evaluate(
  observation({ evidence: [] }),
  window,
  emptyPolicyState(),
  config,
  now,
);
check(
  "an actionable claim with no evidence is refused",
  !unsupported.act && unsupported.reason === "insufficient_context",
);

const lowConfidence = evaluate(
  observation({ confidence: 0.3 }),
  window,
  emptyPolicyState(),
  config,
  now,
);
check(
  "below the speak threshold it says nothing",
  !lowConfidence.act && lowConfidence.reason === "below_confidence_threshold",
);

const cooled = emptyPolicyState();
cooled.lastDeliveryBySurface.set("S1", new Date(now.getTime() - 30_000));
const cooling = evaluate(observation(), window, cooled, config, now);
check(
  "the cooldown holds the agent back after it just spoke",
  !cooling.act && cooling.reason === "cooldown_active",
);

const wrongSurface = evaluate(
  observation(),
  window,
  emptyPolicyState(),
  { ...config, allowedSurfaceIds: ["SOMEWHERE-ELSE"] },
  now,
);
check(
  "an unlisted surface is off limits",
  !wrongSurface.act && wrongSurface.reason === "surface_not_allowed",
);

const answeredWindow = [
  event({ event_id: "question", actor: { actor_id: "ASKER", display_name: "Ana", is_agent: false }, text: "Did the deploy go out?" }),
  event({
    event_id: "answer",
    actor: { actor_id: "REPLIER", display_name: "Luis", is_agent: false },
    text: "Yes, I checked the pipeline and the deploy completed.",
  }),
];
const answered = evaluate(
  observation({ evidence: [{ event_id: "question", actor_id: "ASKER", quote: "Did the deploy go out?" }] }),
  answeredWindow,
  emptyPolicyState(),
  config,
  now,
);
check(
  "a human answer after the cited question keeps the agent silent",
  !answered.act && answered.reason === "already_answered_by_human",
);

const unanswered = evaluate(
  observation({ evidence: [{ event_id: "question", actor_id: "ASKER", quote: "Did the deploy go out?" }] }),
  [
    answeredWindow[0]!,
    event({
      event_id: "deferred",
      actor: { actor_id: "REPLIER", display_name: "Luis", is_agent: false },
      text: "Let me pull that up before I answer.",
    }),
  ],
  emptyPolicyState(),
  config,
  now,
);
check("a deferred answer does not suppress a useful reply", unanswered.act);

const malformedVeto = parseVeto('{"intervene":false,"reason_code":"not_a_reason"}');
check("an invalid model veto fails open", malformedVeto.intervene);

// --- speaking --------------------------------------------------------------

const publicPost = evaluate(observation(), window, emptyPolicyState(), config, now);
check("a confident shared need is posted publicly", publicPost.act === true);
check(
  "to the surface, not to a person",
  publicPost.act && publicPost.delivery.target === "surface" && publicPost.delivery.visibility === "public",
);

const individual = evaluate(
  observation({ kind: "information_gap" }),
  window,
  emptyPolicyState(),
  config,
  now,
);
check(
  "an individual need goes as a direct message",
  individual.act && individual.delivery.target === "actor" && individual.delivery.visibility === "private",
);

const downgraded = evaluate(
  observation({ confidence: 0.66 }),
  window,
  emptyPolicyState(),
  config,
  now,
);
check(
  "over the speak bar but under the public bar, it downgrades to a DM",
  downgraded.act && downgraded.downgraded && downgraded.delivery.target === "actor",
);

const noSubject = evaluate(
  observation({ confidence: 0.66, subject_actor_id: null }),
  window,
  emptyPolicyState(),
  config,
  now,
);
check(
  "and stays silent when there is nobody to tell privately",
  !noSubject.act && noSubject.reason === "below_public_confidence_threshold",
);

// --- stage 2 ---------------------------------------------------------------

const meetingWindow = [
  event({ actor: { actor_id: "HOST", display_name: "Dana", is_agent: false, role: "interviewer" } }),
];
const meeting = evaluate(
  observation({
    window: { ...observation().window, surface_type: "live_meeting" },
    subject_actor_id: "CANDIDATE",
  }),
  meetingWindow,
  emptyPolicyState(),
  config,
  now,
);
check(
  "a live meeting is never broadcast",
  meeting.act && meeting.delivery.visibility === "private",
);
check(
  "and goes to the principal, not to whoever spoke",
  meeting.act && meeting.delivery.actor_id === "HOST",
  meeting.act ? String(meeting.delivery.actor_id) : "",
);

report("core/action policy");
