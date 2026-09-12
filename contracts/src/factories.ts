import { randomUUID } from "node:crypto";
import {
  ActionDecisionSchema,
  type ActionDecision,
  type ActReason,
  type Delivery,
  type Draft,
  type SilenceReason,
} from "./action-decision";
import { ActionResultSchema, type ActionResult } from "./action-result";
import type { ContextEvent } from "./context-event";
import { ObservationSchema, type Observation, type ObservationKind } from "./observation";
import { SCHEMA_VERSION } from "./common";

/**
 * Builders that produce contract-valid payloads. Use these instead of writing
 * object literals: they keep the act/delivery invariants correct for free and
 * they mean a schema change breaks in one place instead of four folders.
 */

export interface PolicySnapshot {
  version: string;
  min_confidence: number;
  min_confidence_public: number;
  cooldown_seconds: number;
  cooldown_active: boolean;
}

export interface DecidedBy {
  engine: string;
  prompt_id?: string | null;
  prompt_version?: string | null;
  model?: string | null;
  latency_ms?: number;
}

const iso = (d: Date | string | undefined): string =>
  typeof d === "string" ? d : (d ?? new Date()).toISOString();

/** Describes the window of events a detector looked at. */
export function windowOf(events: readonly ContextEvent[]): Observation["window"] {
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) throw new Error("windowOf requires at least one event");
  return {
    surface_id: first.source.surface_id,
    surface_type: first.source.surface_type,
    first_event_id: first.event_id,
    last_event_id: last.event_id,
    event_count: events.length,
    started_at: first.occurred_at,
    ended_at: last.occurred_at,
  };
}

export function makeObservation(input: {
  events: readonly ContextEvent[];
  kind: ObservationKind;
  summary: string;
  confidence: number;
  evidence?: Observation["evidence"];
  subjectActorId?: string | null;
  detector: Observation["detector"];
  createdAt?: Date | string;
}): Observation {
  return ObservationSchema.parse({
    schema_version: SCHEMA_VERSION,
    observation_id: `obs_${randomUUID()}`,
    window: windowOf(input.events),
    kind: input.kind,
    summary: input.summary,
    evidence: input.evidence ?? [],
    subject_actor_id: input.subjectActorId ?? null,
    confidence: input.confidence,
    detector: input.detector,
    created_at: iso(input.createdAt),
  } satisfies Record<string, unknown>);
}

/** The agent decided to stay quiet, and says why. */
export function silentDecision(input: {
  observation: Observation;
  reason: SilenceReason;
  rationale: string;
  confidence?: number;
  policy: PolicySnapshot;
  decidedBy: DecidedBy;
  createdAt?: Date | string;
}): ActionDecision {
  return ActionDecisionSchema.parse({
    schema_version: SCHEMA_VERSION,
    decision_id: `dec_${randomUUID()}`,
    observation_id: input.observation.observation_id,
    act: false,
    confidence: input.confidence ?? input.observation.confidence,
    reason_code: input.reason,
    rationale: input.rationale,
    delivery: null,
    draft: null,
    policy: input.policy,
    decided_by: {
      engine: input.decidedBy.engine,
      prompt_id: input.decidedBy.prompt_id ?? null,
      prompt_version: input.decidedBy.prompt_version ?? null,
      model: input.decidedBy.model ?? null,
      latency_ms: input.decidedBy.latency_ms ?? 0,
    },
    created_at: iso(input.createdAt),
  } satisfies Record<string, unknown>);
}

/** The agent decided to speak, and carries everything needed to do it. */
export function actDecision(input: {
  observation: Observation;
  reason: ActReason;
  rationale: string;
  confidence?: number;
  delivery: Delivery;
  draft: Draft;
  policy: PolicySnapshot;
  decidedBy: DecidedBy;
  createdAt?: Date | string;
}): ActionDecision {
  return ActionDecisionSchema.parse({
    schema_version: SCHEMA_VERSION,
    decision_id: `dec_${randomUUID()}`,
    observation_id: input.observation.observation_id,
    act: true,
    confidence: input.confidence ?? input.observation.confidence,
    reason_code: input.reason,
    rationale: input.rationale,
    delivery: input.delivery,
    draft: input.draft,
    policy: input.policy,
    decided_by: {
      engine: input.decidedBy.engine,
      prompt_id: input.decidedBy.prompt_id ?? null,
      prompt_version: input.decidedBy.prompt_version ?? null,
      model: input.decidedBy.model ?? null,
      latency_ms: input.decidedBy.latency_ms ?? 0,
    },
    created_at: iso(input.createdAt),
  } satisfies Record<string, unknown>);
}

export function makeResult(input: {
  decision: ActionDecision;
  status: ActionResult["status"];
  adapter?: string;
  externalId?: string | null;
  error?: { code: string; message: string } | null;
  latencyMs?: number;
  deliveredAt?: Date | string | null;
}): ActionResult {
  const ref =
    input.adapter === undefined
      ? null
      : {
          adapter: input.adapter,
          surface_id: input.decision.delivery?.surface_id ?? null,
          external_id: input.externalId ?? null,
        };
  return ActionResultSchema.parse({
    schema_version: SCHEMA_VERSION,
    result_id: `res_${randomUUID()}`,
    decision_id: input.decision.decision_id,
    status: input.status,
    delivered_at:
      input.deliveredAt === null
        ? null
        : input.status === "delivered"
          ? iso(input.deliveredAt ?? undefined)
          : null,
    delivery_ref: ref,
    error: input.error ?? null,
    latency_ms: input.latencyMs ?? 0,
  } satisfies Record<string, unknown>);
}

/** Routes a decision to the person, privately. Used for individual help. */
export function dmDelivery(input: {
  actorId: string;
  surfaceId?: string | null;
  inReplyToEventId?: string | null;
}): Delivery {
  return {
    target: "actor",
    visibility: "private",
    surface_id: input.surfaceId ?? null,
    surface_type: null,
    actor_id: input.actorId,
    thread_id: null,
    in_reply_to_event_id: input.inReplyToEventId ?? null,
  };
}

/** Routes a decision to the whole surface, publicly. */
export function surfaceDelivery(input: {
  surfaceId: string;
  surfaceType?: Delivery["surface_type"];
  threadId?: string | null;
  inReplyToEventId?: string | null;
}): Delivery {
  return {
    target: "surface",
    visibility: "public",
    surface_id: input.surfaceId,
    surface_type: input.surfaceType ?? null,
    actor_id: null,
    thread_id: input.threadId ?? null,
    in_reply_to_event_id: input.inReplyToEventId ?? null,
  };
}
