import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type RawData, type WebSocket as AudioSocket } from "ws";
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
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MeetingMemory, MemoryHit } from "./memory";

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
  memory: MeetingMemory;
  answer?: (
    question: string,
    hits: MemoryHit[],
  ) => Promise<{ answer: string; sources: string[] } | null>;
  /** Turns meeting audio into lines. Absent means captions come from Meet. */
  transcribe?: OpenTranscription;
}

/** One audio stream in, finished lines out. The vendor lives in the harness. */
export type OpenTranscription = (handlers: {
  onLine(text: string): void;
  onError(error: Error): void;
}) => { append(pcm16: Buffer): void; close(): void };

interface CaptionPayload {
  meeting_id?: string;
  meeting_label?: string;
  speaker_id?: string;
  speaker_name?: string;
  speaker_role?: string;
  text?: string;
  caption_id?: string;
  offset_ms?: number;
  occurred_at?: string;
}

const CaptionSchema = z.object({
  meeting_id: z.string().uuid(),
  text: z.string().trim().min(1).max(8000),
  caption_id: z.string().min(1).max(100),
  speaker_id: z.string().min(1).max(200).optional(),
  speaker_name: z.string().min(1).max(200).optional(),
  speaker_role: z.string().max(80).optional(),
  offset_ms: z.number().finite().nonnegative().optional(),
  occurred_at: z.string().datetime().optional(),
});

const CORS = {
  "Access-Control-Allow-Origin": "https://meet.google.com",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 64_000) {
        reject(new Error("request payload too large"));
        req.destroy();
      }
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
  const listeners = new Map<ServerResponse, string>();
  const polling = new Map<string, { at: number; frames: unknown[] }>();
  const contextAnswers = new Map<
    string,
    { key: string; synthesis: { answer: string; sources: string[] } | null }
  >();
  let server: Server | null = null;
  let stopped = false;

  // Typed captions and transcribed audio are the same thing to everything
  // downstream, so both enter memory and the pipeline through here.
  const ingest = (payload: CaptionPayload): void => {
    const text = (payload.text ?? "").trim();
    const meetingId = payload.meeting_id!;
    const meeting = options.memory.get(meetingId);
    const event = ContextEventSchema.parse({
      schema_version: "1.0.0",
      event_id: `browser:${meetingId}:${payload.caption_id ?? randomUUID()}`,
      source: {
        adapter: "browser",
        surface_id: meetingId,
        surface_type: "live_meeting",
        surface_label: meeting.label,
      },
      actor: {
        actor_id: payload.speaker_id ?? payload.speaker_name ?? "unknown-speaker",
        display_name: payload.speaker_name ?? "Unknown speaker",
        is_agent: false,
        ...(payload.speaker_role ? { role: payload.speaker_role } : {}),
      },
      occurred_at: payload.occurred_at ?? new Date().toISOString(),
      text,
      thread_id: null,
      reply_to_event_id: null,
      mentions: [],
      metadata: { caption_offset_ms: payload.offset_ms ?? null },
    } satisfies Record<string, unknown>);
    if (options.memory.append(event)) queue.push(event);
  };

  const audioSockets = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

  // One socket per audio source. The extension opens one for the tab (the
  // other people) and one for the microphone (the principal), which is how
  // speaker attribution survives a transcriber that returns no speaker labels.
  const streamAudio = (socket: AudioSocket, meetingId: string, speaker: "self" | "room") => {
    // Audio problems happen in a browser nobody is watching, so the terminal
    // running the bridge is the one place that has to say what the recorder did.
    const source = speaker === "self" ? "microphone" : "tab";
    console.log(`  audio: ${source} connected (meeting ${meetingId.slice(0, 8)})`);
    let chunks = 0;
    const stream = options.transcribe!({
      onLine(text) {
        try {
          ingest({
            meeting_id: meetingId,
            text,
            caption_id: `audio-${speaker}-${randomUUID()}`,
            ...(speaker === "self"
              ? { speaker_id: options.principalActorId, speaker_name: "You", speaker_role: "principal" }
              : { speaker_id: "room", speaker_name: "Others", speaker_role: "participant" }),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "ingest failed";
          console.log(`  audio: ${source} line could not be stored: ${message}`);
          socket.close(1011, message.slice(0, 120));
        }
      },
      onError(error) {
        console.log(`  audio: ${source} transcription failed: ${error.message}`);
        socket.close(1011, error.message.slice(0, 120));
      },
    });
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      if (++chunks === 1) console.log(`  audio: ${source} is receiving sound`);
      stream.append(
        Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data),
      );
    });
    socket.on("close", (code: number) => {
      console.log(`  audio: ${source} disconnected (code ${code}) after ${chunks} chunks`);
      stream.close();
    });
  };

  const json = (res: ServerResponse, value: unknown, status = 200) => {
    res.writeHead(status, { ...CORS, "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // The bridge contains private meeting history and only listens on loopback.
    if (
      req.headers.origin &&
      req.headers.origin !== "https://meet.google.com" &&
      !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin)
    ) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS).end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { ...CORS, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, principal: options.principalActorId }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/meetings") {
      const input = z
        .object({
          room: z.string().min(1).max(200),
          label: z.string().min(1).max(200),
          project: z.string().trim().min(1).max(120),
        })
        .parse(JSON.parse(await readBody(req)));
      json(res, options.memory.start(input.room, input.label, input.project), 201);
      return;
    }
    if (req.method === "GET" && url.pathname === "/meetings") {
      json(res, options.memory.list(url.searchParams.get("project") ?? ""));
      return;
    }
    if (req.method === "GET" && url.pathname === "/memory/search") {
      const query = z.string().trim().min(1).max(1000).parse(url.searchParams.get("q"));
      const project = z.string().trim().min(1).max(120).parse(url.searchParams.get("project"));
      const hits = options.memory.search(project, query);
      try {
        json(res, { hits, synthesis: (await options.answer?.(query, hits)) ?? null });
      } catch {
        json(res, {
          hits,
          synthesis: null,
          warning: "Answer unavailable. Original matching sources are shown below.",
        });
      }
      return;
    }
    const meetingRoute = /^\/meetings\/([a-f0-9-]+)(?:\/(finish|export|context))?$/.exec(
      url.pathname,
    );
    if (meetingRoute) {
      const id = z.string().uuid().parse(meetingRoute[1]);
      const meeting = options.memory.get(id);
      if (req.method === "POST" && meetingRoute[2] === "finish") {
        // Long transcripts outlive a browser request timeout.
        void options.memory.finish(id).catch(() => {});
        json(res, options.memory.get(id), 202);
        return;
      }
      if (req.method === "GET" && meetingRoute[2] === "export") {
        const markdown = options.memory.export(id);
        res.writeHead(200, {
          ...CORS,
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="Meeting-${id}.md"`,
        });
        res.end(markdown);
        return;
      }
      if (req.method === "GET" && meetingRoute[2] === "context") {
        const recent = options.memory
          .events(id)
          .slice(-3)
          .map((e) => e.text)
          .join(" ");
        const hits = options.memory.search(meeting.project, recent, id);
        if (hits.length === 0) {
          json(res, { hits, synthesis: null });
          return;
        }
        // The panel polls this while people talk. Answering the same set of
        // excerpts again on every poll would spend a model call per minute to
        // produce the same paragraph, so the answer is kept until the
        // excerpts themselves change.
        const key = hits.map((hit) => hit.event_id).join(",");
        const cached = contextAnswers.get(id);
        if (cached?.key === key) {
          json(res, { hits, synthesis: cached.synthesis });
          return;
        }
        try {
          const synthesis =
            (await options.answer?.(
              `This is being discussed right now: "${recent}". What in these earlier meetings is relevant to it?`,
              hits,
            )) ?? null;
          contextAnswers.set(id, { key, synthesis });
          json(res, { hits, synthesis });
        } catch {
          json(res, {
            hits,
            synthesis: null,
            warning: "Answer unavailable. Original matching sources are shown below.",
          });
        }
        return;
      }
      if (req.method === "GET" && !meetingRoute[2]) {
        json(res, meeting);
        return;
      }
    }

    // The extension holds this open and renders whatever arrives.
    if (req.method === "GET" && url.pathname === "/suggestions") {
      const meetingId = z.string().uuid().parse(url.searchParams.get("meeting_id"));
      options.memory.get(meetingId);
      if (url.searchParams.get("poll") === "1") {
        for (const [key, value] of polling) if (Date.now() - value.at > 60000) polling.delete(key);
        const mailbox = polling.get(meetingId) ?? { at: Date.now(), frames: [] };
        json(res, { frames: mailbox.frames });
        polling.set(meetingId, { at: Date.now(), frames: [] });
        return;
      }
      res.writeHead(200, {
        ...CORS,
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      listeners.set(res, meetingId);
      req.on("close", () => listeners.delete(res));
      return;
    }

    if (req.method === "POST" && req.url === "/captions") {
      try {
        const payload: CaptionPayload = CaptionSchema.parse(JSON.parse(await readBody(req)));
        if ((payload.text ?? "").trim().length === 0) {
          res.writeHead(204, CORS).end();
          return;
        }
        ingest(payload);
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
        void handle(req, res).catch((err) => {
          if (!res.headersSent && !res.destroyed)
            json(
              res,
              { error: err instanceof Error ? err.message : "Request failed" },
              err instanceof z.ZodError ? 400 : 500,
            );
          else res.end();
        });
      });
      server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const origin = req.headers.origin;
        const meetingId = z.string().uuid().safeParse(url.searchParams.get("meeting_id"));
        // Same rule as the HTTP routes: a page that is not the extension
        // must not be able to push audio into someone's meeting memory.
        if (
          url.pathname !== "/audio" ||
          !options.transcribe ||
          !meetingId.success ||
          (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))
        ) {
          socket.destroy();
          return;
        }
        const speaker = url.searchParams.get("speaker") === "self" ? "self" : "room";
        audioSockets.handleUpgrade(req, socket, head, (client) =>
          streamAudio(client, meetingId.data, speaker),
        );
      });
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(options.port, "127.0.0.1", resolve);
      });
      console.log(`  browser bridge listening on http://127.0.0.1:${options.port}`);
    },
    stream() {
      return queue;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      queue.close();
      for (const res of listeners.keys()) res.end();
      listeners.clear();
      polling.clear();
      for (const client of audioSockets.clients) client.terminate();
      audioSockets.close();
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
      await options.memory.close();
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

      const recipients = [...listeners].filter(
        ([, meetingId]) =>
          decision.delivery?.actor_id === options.principalActorId &&
          decision.delivery.surface_id === meetingId,
      );
      const mailbox =
        decision.delivery.actor_id === options.principalActorId
          ? polling.get(decision.delivery.surface_id ?? "")
          : undefined;
      if (recipients.length === 0 && (!mailbox || Date.now() - mailbox.at > 15000)) {
        return makeResult({
          decision,
          status: "failed",
          adapter: "browser",
          error: {
            code: "no_panel_connected",
            message: "no extension is listening on /suggestions",
          },
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
      for (const [res] of recipients) res.write(`data: ${frame}\n\n`);
      if (mailbox) {
        mailbox.frames.push(JSON.parse(frame));
        mailbox.frames = mailbox.frames.slice(-20);
      }

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
