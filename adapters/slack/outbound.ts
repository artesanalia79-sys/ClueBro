import type { App } from "@slack/bolt";
import { makeResult, type ActionDecision, type ActionResult, type OutboundAdapter } from "@contracts";

/**
 * ActionDecision -> Slack.
 *
 * The core says "this person, privately" or "this surface, publicly". This
 * file is what turns that into conversations.open plus chat.postMessage, or a
 * channel post. The core does not know either call exists.
 */

export interface SlackOutboundOptions {
  app: App;
  /** Fall back to a channel post when a DM cannot be opened. Off by default:
   *  a private message turning into a public one is a bad surprise. */
  fallbackToChannelOnDmFailure?: boolean;
}

/** Sources are part of the contribution, not decoration. Always shown. */
export function formatMessage(decision: ActionDecision): string {
  const draft = decision.draft;
  if (!draft) return "";
  if (draft.sources.length === 0) return draft.body;
  const sources = draft.sources.map((s) => `• ${s.label} (${s.ref})`).join("\n");
  return `${draft.body}\n\n_Based on:_\n${sources}`;
}

export function createSlackOutbound(options: SlackOutboundOptions): OutboundAdapter {
  const { app } = options;

  return {
    name: "slack",

    async deliver(decision: ActionDecision): Promise<ActionResult> {
      const started = Date.now();
      const delivery = decision.delivery;

      if (!delivery || !decision.draft) {
        return makeResult({
          decision,
          status: "failed",
          adapter: "slack",
          error: { code: "nothing_to_send", message: "decision had no delivery or no draft" },
          latencyMs: Date.now() - started,
        });
      }

      const text = formatMessage(decision);

      try {
        let channel: string | undefined;

        if (delivery.target === "actor") {
          // A DM needs a conversation first. im:write is the scope people
          // forget, and it fails here with that exact name.
          const opened = await app.client.conversations.open({ users: delivery.actor_id ?? "" });
          channel = opened.channel?.id;
          if (!channel) throw new Error("conversations.open returned no channel id");
        } else {
          channel = delivery.surface_id ?? undefined;
          if (!channel) throw new Error("surface delivery with no surface_id");
        }

        const posted = await app.client.chat.postMessage({
          channel,
          text,
          ...(delivery.target === "surface" && delivery.thread_id
            ? { thread_ts: delivery.thread_id }
            : {}),
          unfurl_links: false,
        });

        return makeResult({
          decision,
          status: "delivered",
          adapter: "slack",
          externalId: typeof posted.ts === "string" ? posted.ts : null,
          latencyMs: Date.now() - started,
          deliveredAt: new Date(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Slack reports a missing scope as `missing_scope`, which is the most
        // common failure at a hackathon. Surface it verbatim.
        const code = /missing_scope/.test(message)
          ? "missing_scope"
          : /not_in_channel/.test(message)
            ? "not_in_channel"
            : /channel_not_found/.test(message)
              ? "channel_not_found"
              : "send_failed";
        return makeResult({
          decision,
          status: "failed",
          adapter: "slack",
          error: { code, message: message.slice(0, 600) },
          latencyMs: Date.now() - started,
        });
      }
    },
  };
}
