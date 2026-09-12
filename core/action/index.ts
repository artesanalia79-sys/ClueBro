import {
  SilenceReason,
  actDecision,
  silentDecision,
  type ActionDecision,
  type ActionEngine,
  type ContextEvent,
  type CoreDeps,
  type Draft,
  type Observation,
} from "@contracts";
import {
  DEFAULT_POLICY_CONFIG,
  POLICY_VERSION,
  emptyPolicyState,
  evaluate,
  topicKey,
  type PolicyConfig,
  type PolicyState,
} from "./policy";

/**
 * Judgement plus wording.
 *
 * policy.ts decides whether to speak and where it goes. This file turns that
 * into an ActionDecision, asking the model only for the words.
 *
 * Nothing in this folder knows what Slack is. It produces a Delivery that
 * says "this person, privately" or "this surface, publicly", and an adapter
 * works out what that means.
 */

export const ENGINE_NAME = "policy-action-engine";
export const ENGINE_VERSION = "0.1.0";

export const PROMPT_CHANNEL_REPLY = "compose.channel_reply";
export const PROMPT_DIRECT_MESSAGE = "compose.direct_message";
export const PROMPT_SHOULD_INTERVENE = "policy.should_intervene";

export interface ActionEngineOptions {
  policy?: Partial<PolicyConfig>;
  /** Injectable so tests can pre-load a cooldown. */
  state?: PolicyState;
  /**
   * Ask the model for a veto after the thresholds pass. The thresholds catch
   * "not sure enough", the veto catches "technically valid but would still be
   * annoying". Turn it off to make a run fully deterministic.
   */
  secondOpinion?: boolean;
}

interface Veto {
  intervene: boolean;
  reason: SilenceReason;
  rationale: string;
}

function parseVeto(raw: string): Veto {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const obj = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : {};
    const intervene = obj.intervene !== false;
    const parsedReason = SilenceReason.safeParse(obj.reason_code);
    return {
      intervene,
      reason: parsedReason.success ? parsedReason.data : "would_add_noise",
      rationale:
        typeof obj.rationale === "string" && obj.rationale.trim()
          ? obj.rationale.trim().slice(0, 600)
          : "The model judged that speaking here would not help.",
    };
  } catch {
    // A malformed veto must not silence a decision the policy already
    // justified. Fail open, and let the log show it.
    return { intervene: true, reason: "would_add_noise", rationale: "unparseable veto, ignored" };
  }
}

function parseDraft(raw: string, fallback: string): Draft {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const obj = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : {};
    const body = typeof obj.body === "string" && obj.body.trim() ? obj.body.trim() : fallback;
    const sources = Array.isArray(obj.sources)
      ? (obj.sources as unknown[])
          .filter((s): s is { label?: unknown; ref?: unknown } => typeof s === "object" && s !== null)
          .map((s) => ({
            label: String(s.label ?? "source").slice(0, 200),
            ref: String(s.ref ?? "").slice(0, 500),
          }))
          .filter((s) => s.ref.length > 0)
      : [];
    return { body: body.slice(0, 3000), sources };
  } catch {
    return { body: fallback, sources: [] };
  }
}

const transcript = (events: readonly ContextEvent[]): string =>
  events
    .slice(-12)
    .map((e) => `[${e.event_id}] ${e.actor.display_name} (${e.actor.actor_id}): ${e.text}`)
    .join("\n");

export function createActionEngine(
  deps: CoreDeps,
  options: ActionEngineOptions = {},
): ActionEngine {
  const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, ...options.policy };
  const state: PolicyState = options.state ?? emptyPolicyState();
  const secondOpinion = options.secondOpinion ?? true;

  const snapshot = (cooldownActive: boolean) => ({
    version: POLICY_VERSION,
    min_confidence: config.minConfidence,
    min_confidence_public: config.minConfidencePublic,
    cooldown_seconds: config.cooldownSeconds,
    cooldown_active: cooldownActive,
  });

  return {
    name: ENGINE_NAME,
    version: ENGINE_VERSION,

    async decide(
      observation: Observation,
      window: readonly ContextEvent[],
    ): Promise<ActionDecision> {
      const started = Date.now();
      const now = deps.clock.now();
      const outcome = evaluate(observation, window, state, config, now);

      if (!outcome.act) {
        return silentDecision({
          observation,
          reason: outcome.reason,
          rationale: outcome.rationale,
          policy: snapshot(outcome.reason === "cooldown_active"),
          decidedBy: { engine: ENGINE_NAME, latency_ms: Date.now() - started },
          createdAt: now,
        });
      }

      // Second gate: the thresholds said "allowed", now ask whether it is
      // actually worth it. A veto here is the most interesting silence of all,
      // because it is judgement rather than arithmetic.
      if (secondOpinion) {
        const gate = deps.prompts.get(PROMPT_SHOULD_INTERVENE);
        const gateResponse = await deps.llm.complete({
          system: gate.render({
            transcript: transcript(window),
            observation_kind: observation.kind,
            observation_summary: observation.summary,
            confidence: observation.confidence.toFixed(2),
            planned_route: `${outcome.delivery.target}/${outcome.delivery.visibility}`,
          }),
          user: "Return the JSON object now.",
          json: true,
          promptId: gate.id,
          temperature: 0,
          maxTokens: 300,
        });
        const veto = parseVeto(gateResponse.text);
        if (!veto.intervene) {
          return silentDecision({
            observation,
            reason: veto.reason,
            rationale: veto.rationale,
            policy: snapshot(false),
            decidedBy: {
              engine: ENGINE_NAME,
              prompt_id: gate.id,
              prompt_version: gate.version,
              model: gateResponse.model,
              latency_ms: gateResponse.latencyMs,
            },
            createdAt: now,
          });
        }
      }

      const isPrivate = outcome.delivery.visibility === "private";
      const promptId = isPrivate ? PROMPT_DIRECT_MESSAGE : PROMPT_CHANNEL_REPLY;
      const prompt = deps.prompts.get(promptId);

      const subjectName =
        window.find((e) => e.actor.actor_id === observation.subject_actor_id)?.actor.display_name ??
        "them";

      const response = await deps.llm.complete({
        system: prompt.render({
          transcript: transcript(window),
          observation_kind: observation.kind,
          observation_summary: observation.summary,
          evidence: observation.evidence.map((e) => `[${e.event_id}] ${e.quote}`).join("\n"),
          subject_name: subjectName,
        }),
        user: "Return the JSON object now.",
        json: true,
        promptId: prompt.id,
        temperature: 0.2,
        maxTokens: 400,
      });

      const draft = parseDraft(
        response.text,
        // If the model gives us nothing usable we still say something true
        // and small, rather than dropping a decision we already justified.
        `${observation.summary}`,
      );

      // Cooldown and dedupe advance when the decision is made, not when the
      // adapter confirms: a failed send should still buy quiet, otherwise a
      // broken token turns into a retry storm in a live channel.
      state.lastDeliveryBySurface.set(observation.window.surface_id, now);
      state.lastHelpByTopic.set(topicKey(observation), now);

      return actDecision({
        observation,
        reason: outcome.reason,
        rationale: outcome.rationale,
        delivery: outcome.delivery,
        draft,
        policy: snapshot(false),
        decidedBy: {
          engine: ENGINE_NAME,
          prompt_id: prompt.id,
          prompt_version: prompt.version,
          model: response.model,
          latency_ms: response.latencyMs,
        },
        createdAt: now,
      });
    },

    noteDelivered(surfaceId: string, at: Date) {
      state.lastDeliveryBySurface.set(surfaceId, at);
    },
  };
}

export { DEFAULT_POLICY_CONFIG, POLICY_VERSION, emptyPolicyState, evaluate } from "./policy";
export type { PolicyConfig, PolicyOutcome, PolicyState } from "./policy";
