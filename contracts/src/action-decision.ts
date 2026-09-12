import { z } from "zod";
import { Confidence, Id, IsoDateTime, SchemaVersion, SurfaceType } from "./common";

/** Why the agent spoke. Small closed list: these end up on screen. */
export const ActReason = z.enum([
  "unanswered_question_timeout",
  "information_gap_resolvable",
  "plan_missing_owner_or_date",
]);
export type ActReason = z.infer<typeof ActReason>;

/**
 * Why the agent stayed quiet. This is the hardest thing to demo and the most
 * impressive thing to see, so it is a typed enum and never a free string.
 */
export const SilenceReason = z.enum([
  "no_actionable_signal",
  "below_confidence_threshold",
  "below_public_confidence_threshold",
  "already_answered_by_human",
  "cooldown_active",
  "duplicate_of_recent_action",
  "conversation_still_active",
  "would_add_noise",
  "insufficient_context",
  "surface_not_allowed",
  "nothing_useful_to_add",
]);
export type SilenceReason = z.infer<typeof SilenceReason>;

export const ReasonCode = z.union([ActReason, SilenceReason]);
export type ReasonCode = z.infer<typeof ReasonCode>;

/**
 * Where the answer goes, expressed without product concepts.
 *   surface + public  -> the adapter posts in the channel or room
 *   actor   + private -> the adapter opens a direct message with that person
 */
export const DeliverySchema = z.object({
  target: z.enum(["surface", "actor"]),
  visibility: z.enum(["public", "private"]),
  surface_id: Id.nullable().default(null),
  surface_type: SurfaceType.nullable().default(null),
  actor_id: Id.nullable().default(null),
  thread_id: Id.nullable().default(null),
  in_reply_to_event_id: Id.nullable()
    .default(null)
    .describe("Copied from the triggering event so the adapter can reply in place."),
});
export type Delivery = z.infer<typeof DeliverySchema>;

export const DraftSchema = z.object({
  body: z.string().min(1).max(3000),
  sources: z
    .array(z.object({ label: z.string().max(200), ref: z.string().max(500) }))
    .default([])
    .describe("Shown to the user. Stage 2 requires visible sources: support, not substitution."),
});
export type Draft = z.infer<typeof DraftSchema>;

export const ActionDecisionSchema = z
  .object({
    schema_version: SchemaVersion,
    decision_id: Id,
    observation_id: Id,

    act: z.boolean(),
    confidence: Confidence,
    reason_code: ReasonCode,
    rationale: z.string().max(600).describe("One sentence a judge can read out loud."),

    delivery: DeliverySchema.nullable().default(null),
    draft: DraftSchema.nullable().default(null),

    policy: z.object({
      version: z.string().min(1),
      min_confidence: Confidence,
      min_confidence_public: Confidence,
      cooldown_seconds: z.number().nonnegative(),
      cooldown_active: z.boolean(),
    }),

    decided_by: z.object({
      engine: z.string().min(1),
      prompt_id: z.string().nullable().default(null),
      prompt_version: z.string().nullable().default(null),
      model: z.string().nullable().default(null),
      latency_ms: z.number().nonnegative().default(0),
    }),

    created_at: IsoDateTime,
  })
  /**
   * The invariant that prevents the classic failure: deciding not to speak
   * and speaking anyway. Enforced in the schema, so no component can get it
   * wrong on its own.
   */
  .superRefine((d, ctx) => {
    if (d.act) {
      if (!d.delivery) {
        ctx.addIssue({ code: "custom", path: ["delivery"], message: "act=true needs a delivery" });
      }
      if (!d.draft) {
        ctx.addIssue({ code: "custom", path: ["draft"], message: "act=true needs a draft" });
      }
      if (!ActReason.safeParse(d.reason_code).success) {
        ctx.addIssue({
          code: "custom",
          path: ["reason_code"],
          message: "act=true needs an ActReason",
        });
      }
      if (d.delivery?.target === "actor" && !d.delivery.actor_id) {
        ctx.addIssue({
          code: "custom",
          path: ["delivery", "actor_id"],
          message: "target=actor needs actor_id",
        });
      }
      if (d.delivery?.target === "surface" && !d.delivery.surface_id) {
        ctx.addIssue({
          code: "custom",
          path: ["delivery", "surface_id"],
          message: "target=surface needs surface_id",
        });
      }
    } else {
      if (d.delivery) {
        ctx.addIssue({
          code: "custom",
          path: ["delivery"],
          message: "act=false must carry delivery=null",
        });
      }
      if (d.draft) {
        ctx.addIssue({ code: "custom", path: ["draft"], message: "act=false must carry draft=null" });
      }
      if (!SilenceReason.safeParse(d.reason_code).success) {
        ctx.addIssue({
          code: "custom",
          path: ["reason_code"],
          message: "act=false needs a SilenceReason",
        });
      }
    }
  });

export type ActionDecision = z.infer<typeof ActionDecisionSchema>;
