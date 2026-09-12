import {
  actDecision,
  silentDecision,
  surfaceDelivery,
  type ActionEngine,
  type SilenceReason,
} from "@contracts";

/**
 * Stand-ins for core/action, so nobody waits for it.
 *
 * The adapter owner uses `alwaysActEngine` to exercise the outbound path
 * before any real judgement exists. The harness owner uses `alwaysSilentEngine`
 * to prove the silence path logs correctly.
 */

const POLICY = {
  version: "mock-policy",
  min_confidence: 0.62,
  min_confidence_public: 0.72,
  cooldown_seconds: 0,
  cooldown_active: false,
};

/** Speaks on anything actionable. Posts publicly unless a subject is known. */
export const alwaysActEngine: ActionEngine = {
  name: "mock-always-act",
  version: "0.0.0",
  async decide(observation) {
    if (observation.kind === "no_signal") {
      return silentDecision({
        observation,
        reason: "no_actionable_signal",
        rationale: "mock engine: nothing to act on",
        policy: POLICY,
        decidedBy: { engine: "mock-always-act" },
      });
    }
    return actDecision({
      observation,
      reason:
        observation.kind === "information_gap"
          ? "information_gap_resolvable"
          : observation.kind === "plan_without_owner"
            ? "plan_missing_owner_or_date"
            : "unanswered_question_timeout",
      rationale: "mock engine: acting so the outbound path can be tested",
      delivery: surfaceDelivery({ surfaceId: observation.window.surface_id, surfaceType: "group" }),
      draft: {
        body: `MOCK REPLY for ${observation.kind}: ${observation.summary}`,
        sources: [{ label: "mock source", ref: observation.window.first_event_id }],
      },
      policy: POLICY,
      decidedBy: { engine: "mock-always-act" },
    });
  },
};

/** Never speaks. Pass a reason to exercise a specific silence path. */
export function alwaysSilentEngine(reason: SilenceReason = "no_actionable_signal"): ActionEngine {
  return {
    name: "mock-always-silent",
    version: "0.0.0",
    async decide(observation) {
      return silentDecision({
        observation,
        reason,
        rationale: `mock engine: forced silence (${reason})`,
        policy: POLICY,
        decidedBy: { engine: "mock-always-silent" },
      });
    },
  };
}
