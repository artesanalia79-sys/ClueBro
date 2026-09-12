import {
  dmDelivery,
  surfaceDelivery,
  type ActReason,
  type ContextEvent,
  type Delivery,
  type Observation,
  type SilenceReason,
} from "@contracts";

/**
 * Judgement. The part of the agent that decides to shut up.
 *
 * Every rule here is pure and deterministic: same observation plus same state
 * gives the same outcome, every time. That is what makes the demo repeatable
 * and what makes the silence explainable.
 *
 * The model composes wording. It never decides whether to speak.
 */

export const POLICY_VERSION = "policy-0.2.0";

export interface PolicyConfig {
  minConfidence: number;
  /** A public mistake is louder than a private one, so the bar is higher. */
  minConfidencePublic: number;
  cooldownSeconds: number;
  /** Empty means every surface is allowed. */
  allowedSurfaceIds: string[];
  /**
   * Who the agent works for on a private surface (stage 2: the professional
   * running the browser extension). Channel-agnostic on purpose.
   */
  principalActorId: string | null;
  /** Do not repeat the same kind of help to the same person this soon. */
  dedupeSeconds: number;
  /**
   * Fallback for finding the principal when none is configured: an actor
   * carrying one of these adapter-supplied roles. Still channel-agnostic --
   * the core reads a role string, it does not know what produced it.
   */
  principalRoles: string[];
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  minConfidence: 0.62,
  minConfidencePublic: 0.72,
  cooldownSeconds: 120,
  allowedSurfaceIds: [],
  principalActorId: null,
  dedupeSeconds: 600,
  principalRoles: ["principal", "host", "interviewer", "operator"],
};

export interface PolicyState {
  /** surface_id -> last time the agent delivered anything there. */
  lastDeliveryBySurface: Map<string, Date>;
  /** `${surface_id}:${kind}:${subject}` -> last time we helped with that. */
  lastHelpByTopic: Map<string, Date>;
}

export const emptyPolicyState = (): PolicyState => ({
  lastDeliveryBySurface: new Map(),
  lastHelpByTopic: new Map(),
});

export const topicKey = (o: Observation): string =>
  `${o.window.surface_id}:${o.kind}:${o.subject_actor_id ?? "-"}`;

export type PolicyOutcome =
  | { act: false; reason: SilenceReason; rationale: string }
  | { act: true; reason: ActReason; delivery: Delivery; rationale: string; downgraded: boolean };

const ACT_REASON: Record<string, ActReason> = {
  unanswered_question: "unanswered_question_timeout",
  information_gap: "information_gap_resolvable",
  plan_without_owner: "plan_missing_owner_or_date",
};

/** Individual needs go to the person. Shared needs go to the room. */
const prefersPrivate = (o: Observation): boolean =>
  o.kind === "information_gap" || o.window.surface_type === "direct";

const secondsSince = (then: Date | undefined, now: Date): number =>
  then === undefined ? Number.POSITIVE_INFINITY : (now.getTime() - then.getTime()) / 1000;

const answersQuestion = (text: string): boolean => {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const defersAnAnswer =
    /\b(let me|i(?:'ll| will)|we(?:'ll| will)|checking|check and|pull that up|hold on|one moment|be right back)\b/i.test(
      text,
    );
  return words.length >= 4 && !defersAnAnswer;
};

const answeredByAnotherPerson = (
  observation: Observation,
  window: readonly ContextEvent[],
): ContextEvent | null => {
  if (observation.kind !== "unanswered_question") return null;

  const evidenceIds = new Set(observation.evidence.map((e) => e.event_id));
  const evidenceIndex = window.reduce(
    (latest, event, index) => (evidenceIds.has(event.event_id) ? index : latest),
    -1,
  );
  const question = evidenceIndex >= 0 ? window[evidenceIndex] : undefined;
  if (!question) return null;

  return (
    window
      .slice(evidenceIndex + 1)
      .find(
        (event) =>
          !event.actor.is_agent &&
          event.actor.actor_id !== question.actor.actor_id &&
          answersQuestion(event.text),
      ) ?? null
  );
};

export function evaluate(
  observation: Observation,
  window: readonly ContextEvent[],
  state: PolicyState,
  config: PolicyConfig,
  now: Date,
): PolicyOutcome {
  const surfaceId = observation.window.surface_id;
  const trigger = window[window.length - 1];

  if (config.allowedSurfaceIds.length > 0 && !config.allowedSurfaceIds.includes(surfaceId)) {
    return {
      act: false,
      reason: "surface_not_allowed",
      rationale: `This agent is not configured to speak on surface ${surfaceId}.`,
    };
  }

  if (observation.kind === "no_signal") {
    return {
      act: false,
      reason: "no_actionable_signal",
      rationale: observation.summary,
    };
  }

  // An actionable claim with nothing to point at is a hallucination.
  if (observation.evidence.length === 0) {
    return {
      act: false,
      reason: "insufficient_context",
      rationale: `Detector claimed ${observation.kind} but cited no message. Not acting on an unsupported claim.`,
    };
  }

  if (observation.confidence < config.minConfidence) {
    return {
      act: false,
      reason: "below_confidence_threshold",
      rationale: `Confidence ${observation.confidence.toFixed(2)} is under the ${config.minConfidence.toFixed(
        2,
      )} bar for speaking at all.`,
    };
  }

  const humanAnswer = answeredByAnotherPerson(observation, window);
  if (humanAnswer) {
    return {
      act: false,
      reason: "already_answered_by_human",
      rationale: `${humanAnswer.actor.display_name} added a substantive reply after the cited question, so the agent does not repeat it.`,
    };
  }

  const sinceDelivery = secondsSince(state.lastDeliveryBySurface.get(surfaceId), now);
  if (sinceDelivery < config.cooldownSeconds) {
    return {
      act: false,
      reason: "cooldown_active",
      rationale: `Already spoke here ${Math.round(sinceDelivery)}s ago. Holding for ${
        config.cooldownSeconds
      }s so the agent does not dominate the channel.`,
    };
  }

  const sinceTopic = secondsSince(state.lastHelpByTopic.get(topicKey(observation)), now);
  if (sinceTopic < config.dedupeSeconds) {
    return {
      act: false,
      reason: "duplicate_of_recent_action",
      rationale: `Same ${observation.kind} for the same person was handled ${Math.round(
        sinceTopic,
      )}s ago.`,
    };
  }

  const reason = ACT_REASON[observation.kind];
  if (!reason) {
    return {
      act: false,
      reason: "nothing_useful_to_add",
      rationale: `No action is defined for observation kind ${observation.kind}.`,
    };
  }

  // A live meeting is never broadcast. The agent supports one professional,
  // visibly and with sources, and says nothing to the room.
  if (observation.window.surface_type === "live_meeting") {
    const principal =
      config.principalActorId ??
      window.find((e) => e.actor.role && config.principalRoles.includes(e.actor.role))?.actor
        .actor_id ??
      null;
    if (!principal) {
      return {
        act: false,
        reason: "insufficient_context",
        rationale:
          "Live meeting surface with no principal configured and no actor carrying a principal role. Refusing to broadcast.",
      };
    }
    return {
      act: true,
      reason,
      rationale: `${observation.summary} Surfacing privately to the person being supported.`,
      delivery: dmDelivery({
        actorId: principal,
        surfaceId,
        inReplyToEventId: trigger?.event_id ?? null,
      }),
      downgraded: false,
    };
  }

  if (prefersPrivate(observation) && observation.subject_actor_id) {
    return {
      act: true,
      reason,
      rationale: `${observation.summary} Only one person needs this, so it goes as a direct message.`,
      delivery: dmDelivery({
        actorId: observation.subject_actor_id,
        surfaceId,
        inReplyToEventId: trigger?.event_id ?? null,
      }),
      downgraded: false,
    };
  }

  // Public route. Needs the higher bar.
  if (observation.confidence < config.minConfidencePublic) {
    if (observation.subject_actor_id) {
      return {
        act: true,
        reason,
        rationale: `Confidence ${observation.confidence.toFixed(
          2,
        )} is under the ${config.minConfidencePublic.toFixed(
          2,
        )} bar for a public post, so this goes privately to the person instead of to the channel.`,
        delivery: dmDelivery({
          actorId: observation.subject_actor_id,
          surfaceId,
          inReplyToEventId: trigger?.event_id ?? null,
        }),
        downgraded: true,
      };
    }
    return {
      act: false,
      reason: "below_public_confidence_threshold",
      rationale: `Confidence ${observation.confidence.toFixed(
        2,
      )} is under the public bar and there is nobody to tell privately.`,
    };
  }

  return {
    act: true,
    reason,
    rationale: observation.summary,
    delivery: surfaceDelivery({
      surfaceId,
      surfaceType: "group",
      threadId: trigger?.thread_id ?? null,
      inReplyToEventId: trigger?.event_id ?? null,
    }),
    downgraded: false,
  };
}
