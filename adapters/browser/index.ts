import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  ContextEventSchema,
  makeResult,
  type ActionDecision,
  type ActionResult,
  type ContextEvent,
  type InboundAdapter,
  type OutboundAdapter,
} from "@contracts";
import { AsyncQueue } from "../shared/queue";

/**
 * Stage 2 adapter: a browser extension feeding the same agent.
 *
 * The extension posts caption lines to POST /captions and listens on
 * GET /suggestions for anything the agent decides to surface. Nothing about
 * the core changes: it receives ContextEvents with surface_type
 * "live_meeting" and returns Deliveries, exactly as with Slack.
 *
 * Consent is a property of this adapter, not of the core: the panel is
 * visible to the person using it, it always shows sources, and the agent
 * never writes into the meeting itself. Delivery is private to the principal.
 */

export interface BrowserBridgeOptions {
  port: number;
  /** The person the agent is supporting. Suggestions go only to them. */
  principalActorId: string;
}

interface CaptionPayload {
  meeting_id?: string;
  meeting_label?: string;
  speaker_id?: string;
  speaker_name?: string;
  speaker_role?: string;
  text?: string;
  caption_id?: string;
  offset_ms?: number;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 64_000) reject(new Error("caption payload too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

export interface BrowserBridge {
  inbound: InboundAdapter;
  outbound: OutboundAdapter;
}

export function createBrowserBridge(options: BrowserBridgeOptions): BrowserBridge {
  const queue = new AsyncQueue<ContextEvent>();
  const listeners = new Set<ServerResponse>();
  let server: Server | null = null;
  let sequence = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS).end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { ...CORS, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, principal: options.principalActorId }));
      return;
    }

    // The extension holds this open and renders whatever arrives.
    if (req.method === "GET" && req.url === "/suggestions") {
      res.writeHead(200, {
        ...CORS,
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      listeners.add(res);
      req.on("close", () => listeners.delete(res));
      return;
    }

    if (req.method === "POST" && req.url === "/captions") {
      try {
        const payload = JSON.parse(await readBody(req)) as CaptionPayload;
        const text = (payload.text ?? "").trim();
        if (text.length === 0) {
          res.writeHead(204, CORS).end();
          return;
        }

        sequence++;
        const meetingId = payload.meeting_id ?? "unknown-meeting";
        const event = ContextEventSchema.parse({
          schema_version: "1.0.0",
          event_id: `browser:${meetingId}:${payload.caption_id ?? `cap-${sequence}`}`,
          source: {
            adapter: "browser",
            surface_id: meetingId,
            surface_type: "live_meeting",
            ...(payload.meeting_label ? { surface_label: payload.meeting_label } : {}),
          },
          actor: {
            actor_id: payload.speaker_id ?? payload.speaker_name ?? "unknown-speaker",
            display_name: payload.speaker_name ?? "Unknown speaker",
            is_agent: false,
            ...(payload.speaker_role ? { role: payload.speaker_role } : {}),
          },
          occurred_at: new Date().toISOString(),
          text,
          thread_id: null,
          reply_to_event_id: null,
          mentions: [],
          metadata: { caption_offset_ms: payload.offset_ms ?? null },
        } satisfies Record<string, unknown>);

        queue.push(event);
        res.writeHead(202, CORS).end();
      } catch (err) {
        res.writeHead(400, { ...CORS, "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "bad request" }));
      }
      return;
    }

    res.writeHead(404, CORS).end();
  };

  const inbound: InboundAdapter = {
    name: "browser",
    async start() {
      server = createServer((req, res) => {
        void handle(req, res);
      });
      await new Promise<void>((resolve) => server?.listen(options.port, resolve));
      console.log(`  browser bridge listening on http://127.0.0.1:${options.port}`);
    },
    stream() {
      return queue;
    },
    async stop() {
      queue.close();
      for (const res of listeners) res.end();
      listeners.clear();
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
    },
  };

  const outbound: OutboundAdapter = {
    name: "browser",
    async deliver(decision: ActionDecision): Promise<ActionResult> {
      const started = Date.now();

      // A live meeting is never broadcast. If the core ever asks for a public
      // delivery here, refuse it rather than surprising the room.
      if (decision.delivery?.visibility !== "private") {
        return makeResult({
          decision,
          status: "failed",
          adapter: "browser",
          error: {
            code: "public_delivery_refused",
            message: "the browser adapter only surfaces privately to the principal",
          },
          latencyMs: Date.now() - started,
        });
      }

      if (listeners.size === 0) {
        return makeResult({
          decision,
          status: "failed",
          adapter: "browser",
          error: { code: "no_panel_connected", message: "no extension is listening on /suggestions" },
          latencyMs: Date.now() - started,
        });
      }

      const frame = JSON.stringify({
        decision_id: decision.decision_id,
        reason_code: decision.reason_code,
        rationale: decision.rationale,
        body: decision.draft?.body ?? "",
        sources: decision.draft?.sources ?? [],
        confidence: decision.confidence,
      });
      for (const res of listeners) res.write(`data: ${frame}\n\n`);

      return makeResult({
        decision,
        status: "delivered",
        adapter: "browser",
        externalId: decision.decision_id,
        latencyMs: Date.now() - started,
        deliveredAt: new Date(),
      });
    },
  };

  return { inbound, outbound };
}
