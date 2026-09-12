import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  ContextEventSchema,
  makeResult,
  type ActionDecision,
  type ActionResult,
  type ContextEvent,
  type InboundAdapter,
  type OutboundAdapter,
} from "@contracts";

/**
 * Replay: the most valuable adapter in this repo.
 *
 * It reads a saved conversation from a file and feeds it to the agent as
 * ContextEvents. No Slack, no network, no typing messages by hand.
 *
 * That buys three things:
 *   - the detection logic can be iterated on in a two second loop
 *   - a run is identical every time, so a prompt change is measurable
 *   - the demo video can be recorded even if Slack is down or the workspace
 *     misbehaves five minutes before the deadline
 */

export interface ReplayOptions {
  /** JSON file holding an array of ContextEvent. */
  path: string;
  /**
   * Pacing. 1 replays at the original speed, 6 is six times faster, 0 fires
   * everything immediately. Capped so a long pause never stalls a demo.
   */
  speed: number;
  maxGapMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function loadTranscript(path: string): ContextEvent[] {
  const full = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const raw: unknown = JSON.parse(readFileSync(full, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error(`${path} must contain a JSON array of ContextEvent`);
  }
  return raw.map((item, i) => {
    const parsed = ContextEventSchema.safeParse(item);
    if (!parsed.success) {
      throw new Error(
        `${path}[${i}] is not a valid ContextEvent:\n  ` +
          parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("\n  "),
      );
    }
    return parsed.data;
  });
}

export function createReplayInbound(options: ReplayOptions): InboundAdapter {
  const maxGapMs = options.maxGapMs ?? 2500;

  return {
    name: "replay",

    async *stream(): AsyncIterable<ContextEvent> {
      const events = loadTranscript(options.path);
      let previous: number | null = null;

      for (const event of events) {
        const at = new Date(event.occurred_at).getTime();
        if (previous !== null && options.speed > 0) {
          const gap = Math.max(0, at - previous) / options.speed;
          await sleep(Math.min(gap, maxGapMs));
        }
        previous = at;
        yield event;
      }
    },
  };
}

/**
 * Prints what would have been sent instead of sending it. Used for replay and
 * as the safe default anywhere a real adapter is not configured.
 */
export function createConsoleOutbound(label = "replay"): OutboundAdapter {
  return {
    name: label,
    async deliver(decision: ActionDecision): Promise<ActionResult> {
      const route =
        decision.delivery?.target === "actor"
          ? `DM -> ${decision.delivery.actor_id}`
          : `POST -> ${decision.delivery?.surface_id}`;
      console.log(`      [${label}] ${route}: ${decision.draft?.body ?? ""}`);
      return makeResult({
        decision,
        status: "delivered",
        adapter: label,
        externalId: `${label}-${decision.decision_id}`,
        deliveredAt: new Date(),
      });
    },
  };
}
