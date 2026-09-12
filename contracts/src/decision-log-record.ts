import { z } from "zod";
import { ActionDecisionSchema } from "./action-decision";
import { ActionResultSchema } from "./action-result";
import { ContextEventSchema } from "./context-event";
import { Id, IsoDateTime, SchemaVersion } from "./common";
import { ObservationSchema } from "./observation";

/**
 * One line of the agent's reasoning, joined end to end. The harness writes
 * this to logs/decisions.jsonl and the demo reads it out loud.
 *
 * Silent turns produce a record too. That is the whole point.
 */
export const DecisionLogRecordSchema = z.object({
  schema_version: SchemaVersion,
  record_id: Id,
  trace_id: Id.describe("Shared by every record produced from one incoming event."),
  logged_at: IsoDateTime,
  trigger_event: ContextEventSchema,
  observation: ObservationSchema,
  decision: ActionDecisionSchema,
  result: ActionResultSchema.nullable().default(null),
  timings_ms: z.object({
    detect: z.number().nonnegative(),
    decide: z.number().nonnegative(),
    deliver: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
});

export type DecisionLogRecord = z.infer<typeof DecisionLogRecordSchema>;
