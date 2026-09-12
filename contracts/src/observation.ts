import { z } from "zod";
import { Confidence, Id, IsoDateTime, SchemaVersion } from "./common";

/**
 * What the detector concluded from a window of events.
 *
 * `no_signal` is a first class conclusion, not the absence of one. That is
 * what makes the agent's silence explainable instead of invisible.
 */
export const ObservationKind = z.enum([
  "unanswered_question",
  "information_gap",
  "plan_without_owner",
  "no_signal",
]);
export type ObservationKind = z.infer<typeof ObservationKind>;

export const ObservationSchema = z.object({
  schema_version: SchemaVersion,
  observation_id: Id,

  window: z.object({
    surface_id: Id,
    surface_type: z.string().min(1),
    first_event_id: Id,
    last_event_id: Id,
    event_count: z.number().int().positive(),
    started_at: IsoDateTime,
    ended_at: IsoDateTime,
  }),

  kind: ObservationKind,
  summary: z
    .string()
    .max(600)
    .describe("One sentence, human readable: what the agent believes it saw."),

  evidence: z
    .array(
      z.object({
        event_id: Id,
        actor_id: Id,
        quote: z.string().max(400),
      }),
    )
    .default([])
    .describe("Non-empty for every kind except no_signal. Keeps the agent honest."),

  subject_actor_id: Id.nullable()
    .default(null)
    .describe("Whose need this is. Drives the DM versus channel routing."),

  confidence: Confidence,

  detector: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    prompt_id: z.string().nullable().default(null),
    prompt_version: z.string().nullable().default(null),
    model: z.string().nullable().default(null),
    latency_ms: z.number().nonnegative().default(0),
  }),

  created_at: IsoDateTime,
});

export type Observation = z.infer<typeof ObservationSchema>;
