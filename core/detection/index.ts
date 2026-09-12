import {
  makeObservation,
  type ContextEvent,
  type CoreDeps,
  type Detector,
  type Observation,
  type ObservationKind,
  type WindowContext,
} from "@contracts";
import { humansOnly, prefilter, type HeuristicHit } from "./heuristics";
import { applyTiming } from "./timing";

/**
 * Perception. Answers one question: is there anything in this conversation
 * worth a reply, and what exactly is it?
 *
 * It does NOT decide whether to speak. That is core/action. Keeping those
 * apart is what lets us tune the silence threshold without touching the
 * detector, and vice versa.
 *
 * Nothing in this folder knows what Slack is.
 */

export const DETECTOR_NAME = "llm-detector";
export const DETECTOR_VERSION = "0.2.0";

export const DETECTOR_PROMPT_ID = "detector.conversation_scan";

export interface DetectionConfig {
  /** Below this many human messages the agent has no idea what is going on. */
  minWindowEvents: number;
  /** Skip the model when the cheap pass finds nothing. Saves cost and latency. */
  skipModelWhenNoHeuristicHit: boolean;
  /** Cap on how much the model has to read. */
  maxEventsInPrompt: number;
}

export const DEFAULT_DETECTION_CONFIG: DetectionConfig = {
  minWindowEvents: 2,
  skipModelWhenNoHeuristicHit: true,
  maxEventsInPrompt: 12,
};

const KINDS: ObservationKind[] = [
  "unanswered_question",
  "information_gap",
  "plan_without_owner",
  "no_signal",
];

interface ModelVerdict {
  kind: ObservationKind;
  summary: string;
  confidence: number;
  subject_actor_id: string | null;
  /** The line that states the need. Prompts before v2 do not return it. */
  need_event_id: string | null;
  evidence: { event_id: string; quote: string }[];
}

/** Conversation as the model sees it. Plain text, no product vocabulary. */
export function renderTranscript(events: readonly ContextEvent[], limit: number): string {
  return events
    .slice(-limit)
    .map(
      (e) =>
        `[${e.event_id}] ${e.actor.display_name} (${e.actor.actor_id})` +
        `${e.actor.role ? ` [${e.actor.role}]` : ""}: ${e.text}`,
    )
    .join("\n");
}

function clamp01(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(1, Math.max(0, v));
}

const nonEmptyString = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

function parseVerdict(raw: string, hint: HeuristicHit | undefined): ModelVerdict {
  let obj: Record<string, unknown> = {};
  try {
    // Models occasionally wrap JSON in prose or a fence. Take the first object.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    obj = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : {};
  } catch {
    obj = {};
  }

  const kind = KINDS.includes(obj["kind"] as ObservationKind)
    ? (obj["kind"] as ObservationKind)
    : (hint?.kind ?? "no_signal");

  const evidence = Array.isArray(obj["evidence"])
    ? (obj["evidence"] as { event_id?: unknown; quote?: unknown }[])
        .filter((e) => typeof e?.event_id === "string")
        .map((e) => ({ event_id: String(e.event_id), quote: String(e.quote ?? "").slice(0, 400) }))
    : [];

  return {
    kind,
    summary:
      typeof obj["summary"] === "string" && obj["summary"].trim().length > 0
        ? obj["summary"].slice(0, 600)
        : (hint?.note ?? "Nothing actionable in this window."),
    confidence: clamp01(obj["confidence"], hint?.strength ?? 0.1),
    subject_actor_id: nonEmptyString(obj["subject_actor_id"]) ?? hint?.event.actor.actor_id ?? null,
    need_event_id: nonEmptyString(obj["need_event_id"]),
    evidence,
  };
}

export function createDetector(
  deps: CoreDeps,
  config: DetectionConfig = DEFAULT_DETECTION_CONFIG,
): Detector {
  return {
    name: DETECTOR_NAME,
    version: DETECTOR_VERSION,

    async observe(window: readonly ContextEvent[], ctx: WindowContext): Promise<Observation[]> {
      const started = Date.now();
      const humans = humansOnly(window);

      // Too little conversation to judge anything. Say so out loud rather
      // than returning nothing: an empty array is an invisible decision.
      if (humans.length < config.minWindowEvents) {
        return [
          makeObservation({
            events: window,
            kind: "no_signal",
            summary: `Only ${humans.length} human message(s) in view. Not enough context to judge.`,
            confidence: 0.05,
            detector: {
              name: "heuristic-prefilter",
              version: DETECTOR_VERSION,
              prompt_id: null,
              prompt_version: null,
              model: null,
              latency_ms: Date.now() - started,
            },
            createdAt: deps.clock.now(),
          }),
        ];
      }

      const hits = prefilter(window);
      const top = hits[0];

      if (!top && config.skipModelWhenNoHeuristicHit) {
        deps.log.debug("prefilter found nothing, skipping the model", {
          surface_id: ctx.surfaceId,
          events: humans.length,
        });
        return [
          makeObservation({
            events: window,
            kind: "no_signal",
            summary:
              "No unanswered question, no search for a fact and no ownerless plan in this window.",
            confidence: 0.08,
            detector: {
              name: "heuristic-prefilter",
              version: DETECTOR_VERSION,
              prompt_id: null,
              prompt_version: null,
              model: null,
              latency_ms: Date.now() - started,
            },
            createdAt: deps.clock.now(),
          }),
        ];
      }

      const prompt = deps.prompts.get(DETECTOR_PROMPT_ID);
      const rendered = prompt.render({
        transcript: renderTranscript(window, config.maxEventsInPrompt),
        surface_type: ctx.surfaceType,
        heuristic_hint: top ? `${top.kind} (${top.note})` : "none",
      });

      const response = await deps.llm.complete({
        system: rendered,
        user: "Return the JSON object now.",
        json: true,
        promptId: prompt.id,
        temperature: 0,
        maxTokens: 500,
      });

      const verdict = parseVerdict(response.text, top);

      // The model names the need; code decides whether the newest line is the
      // moment to report it. Without a need_event_id, the first citation is the
      // best guess at the line that states the need.
      const timed = applyTiming(
        verdict.kind,
        verdict.confidence,
        verdict.need_event_id ?? verdict.evidence[0]?.event_id ?? top?.event.event_id ?? null,
        window,
      );

      // The model is allowed to say no_signal even when the cheap pass fired.
      // That is the point of having it.
      const evidence =
        timed.kind === "no_signal"
          ? []
          : verdict.evidence.length > 0
            ? verdict.evidence.map((e) => ({
                event_id: e.event_id,
                actor_id:
                  window.find((w) => w.event_id === e.event_id)?.actor.actor_id ??
                  verdict.subject_actor_id ??
                  "unknown",
                quote: e.quote,
              }))
            : top
              ? [{ event_id: top.event.event_id, actor_id: top.event.actor.actor_id, quote: top.quote }]
              : [];

      return [
        makeObservation({
          events: window,
          kind: timed.kind,
          summary: timed.note ?? verdict.summary,
          confidence: timed.kind === "no_signal" ? Math.min(timed.confidence, 0.3) : timed.confidence,
          evidence,
          subjectActorId: timed.kind === "no_signal" ? null : verdict.subject_actor_id,
          detector: {
            name: DETECTOR_NAME,
            version: DETECTOR_VERSION,
            prompt_id: prompt.id,
            prompt_version: prompt.version,
            model: response.model,
            latency_ms: response.latencyMs,
          },
          createdAt: deps.clock.now(),
        }),
      ];
    },
  };
}
