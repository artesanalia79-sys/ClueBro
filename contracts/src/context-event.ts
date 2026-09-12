import { z } from "zod";
import { AdapterName, Id, IsoDateTime, SchemaVersion, SurfaceType } from "./common";

/**
 * ContextEvent -- one normalized thing that happened in a conversation.
 *
 * This is the ONLY inbound shape the core ever receives. A Slack message, a
 * Meet caption line and a replayed fixture all arrive as this. Adapters
 * translate, the core interprets.
 */
export const ContextEventSchema = z.object({
  schema_version: SchemaVersion,
  event_id: Id.describe("Stable and adapter scoped. Used for deduplication."),

  source: z.object({
    adapter: AdapterName,
    surface_id: Id.describe("Opaque to the core: a channel id, a meeting id."),
    surface_type: SurfaceType,
    surface_label: z.string().max(200).optional().describe("Human name, for logs only."),
  }),

  actor: z.object({
    actor_id: Id,
    display_name: z.string().max(200),
    is_agent: z
      .boolean()
      .describe("True for our agent and any other bot. Detection must ignore these."),
    role: z
      .string()
      .max(80)
      .optional()
      .describe("Adapter supplied hint, e.g. host, candidate, interviewer."),
  }),

  occurred_at: IsoDateTime,
  text: z.string().describe("Plain text. Adapters strip markup and mention syntax."),

  thread_id: Id.nullable().default(null),
  reply_to_event_id: Id.nullable().default(null),
  mentions: z.array(Id).default([]).describe("actor_ids explicitly addressed."),

  /**
   * Adapter specific passthrough. The core MUST NOT read this. It exists so
   * the outbound side of the same adapter can recover what it needs (a Slack
   * thread timestamp, a caption offset) without leaking it into the contract.
   */
  metadata: z.record(z.unknown()).default({}),
});

export type ContextEvent = z.infer<typeof ContextEventSchema>;
