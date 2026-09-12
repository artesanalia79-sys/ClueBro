import { z } from "zod";

/**
 * Bump this only at an integration checkpoint, with the whole team present.
 * Every payload carries it, so a stale component fails loudly instead of
 * subtly.
 */
export const SCHEMA_VERSION = "1.0.0";

export const SchemaVersion = z.literal(SCHEMA_VERSION);
export const Id = z.string().min(1).max(200);
export const IsoDateTime = z.string().datetime({ offset: true });
export const Confidence = z.number().min(0).max(1);

/**
 * Where a message lives, described without naming any product.
 *   group        -> many people can read it (a Slack channel, a meeting room)
 *   direct       -> one to one (a Slack DM)
 *   live_meeting -> a real time spoken surface (stage 2: a video call)
 */
export const SurfaceType = z.enum(["group", "direct", "live_meeting"]);
export type SurfaceType = z.infer<typeof SurfaceType>;

/**
 * Free form on purpose. The core logs this string and never branches on it.
 * A comparison against a literal adapter name inside core/ is a design bug.
 */
export const AdapterName = z.string().min(1).max(40);
