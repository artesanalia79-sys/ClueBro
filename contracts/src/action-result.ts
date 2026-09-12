import { z } from "zod";
import { AdapterName, Id, IsoDateTime, SchemaVersion } from "./common";

export const ActionResultSchema = z.object({
  schema_version: SchemaVersion,
  result_id: Id,
  decision_id: Id,

  status: z.enum(["delivered", "dry_run", "failed", "skipped_no_action"]),

  delivered_at: IsoDateTime.nullable().default(null),

  delivery_ref: z
    .object({
      adapter: AdapterName,
      surface_id: Id.nullable().default(null),
      external_id: z
        .string()
        .nullable()
        .default(null)
        .describe("Whatever the adapter uses: a Slack ts, a DOM node id."),
    })
    .nullable()
    .default(null),

  error: z
    .object({ code: z.string().min(1), message: z.string().max(600) })
    .nullable()
    .default(null),

  latency_ms: z.number().nonnegative().default(0),
});

export type ActionResult = z.infer<typeof ActionResultSchema>;
