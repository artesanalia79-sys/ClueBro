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
  /** The last lines said, oldest first; the final one is what gets answered. */
  answer?: (
    lines: string[],
    hits: MemoryHit[],
  ) => Promise<{ answer: string; sources: string[] } | null>;
  /** Turns meeting audio into lines. Absent means captions come from Meet. */
  transcribe?: OpenTranscription;
}

/** One audio stream in, finished lines out. The vendor lives in the harness. */
export type OpenTranscription = (handlers: {
  onLine(text: string): void;
  onError(error: Error): void;
  /** Why an utterance was cut into a line, for diagnosing broken sentences. */
  onCommit?(info: {
    reason: "pause" | "long-pause" | "max-length" | "hang-up";
    utteranceMs: number;
    speechMs: number;
    silenceMs: number;
    medianLevel: number;
    quietLevel: number;
    threshold: number;
  }): void;
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
  type ContextAnswer = {
    synthesis: { answer: string; sources: string[] } | null;
    quote: string | null;
    source: string | null;
  };
  // Held as a promise so a pushed lookup and a request for the same lines
  // share one model call instead of racing to make two.
  const contextAnswers = new Map<string, { key: string; answer: Promise<ContextAnswer> }>();
  const waiters = new Map<string, Set<() => void>>();
  const pushed = new Map<string, string>();
  const runs = new Map<string, { running: boolean; again: boolean }>();
  const LONG_POLL_MS = 20_000;
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
    if (options.memory.append(event)) {
      queue.push(event);
      scheduleContext(meetingId);
    }
  };

  // Earlier-meeting context for what is being said now. Organized notes come
  // first among the excerpts: they carry the decision, owner and date cleanly.
  const contextFor = async (meetingId: string) => {
    const meeting = options.memory.get(meetingId);
    const lines = options.memory
      .events(meetingId)
      .slice(-3)
      .map((e) => e.text);
    const recent = lines.join(" ");
    const latest = lines.at(-1) ?? "";
    // The latest line is searched first, and the lines before it only fill
    // the rest. Searched as one blob, an earlier topic filled every slot: a
    // question about the AI provider came back with nothing but spike notes.
    const asExcerpt = (note: ReturnType<typeof options.memory.searchNotes>[number]): MemoryHit => ({
      event_id: note.evidence[0]!.event_id,
      meeting_id: note.meeting_id,
      label: note.label,
      occurred_at: note.started_at,
      speaker: note.owner ?? note.kind,
      text: `${note.kind}: ${note.title}. ${note.body}`,
    });
    const candidates = [
      ...options.memory.searchNotes(meeting.project, latest, meetingId).map(asExcerpt),
      ...options.memory.search(meeting.project, latest, meetingId),
      ...options.memory.searchNotes(meeting.project, recent, meetingId).map(asExcerpt),
      ...options.memory.search(meeting.project, recent, meetingId),
    ];
    // A note's evidence is often one of the caption hits too. The first entry
    // for an id wins, so the note stays and the raw caption behind it does not
    // replace it: a Map keyed by id kept the note's place but the caption's text.
    const seen = new Set<string>();
    const hits = candidates
      .filter((hit) => !seen.has(hit.event_id) && Boolean(seen.add(hit.event_id)))
      .slice(0, 8);
    if (hits.length === 0) return { hits, context: null };
    const key = `${latest}|${hits.map((hit) => hit.event_id).join(",")}`;
    const cached = contextAnswers.get(meetingId);
    if (cached?.key === key) return { hits, context: await cached.answer };
    const answer = (async (): Promise<ContextAnswer> => {
      // Replayed on real meetings, a note title shown as-is fired once in
      // twelve lines and named a topic instead of the fact, while the model
      // answered in under a second. The model reads the notes first instead.
      const synthesis = (await options.answer?.(lines, hits)) ?? null;
      const cited = synthesis ? hits.find((hit) => synthesis.sources.includes(hit.event_id)) : undefined;
      return {
        synthesis,
        quote: cited?.text ?? null,
        source: cited
          ? `${cited.speaker} · ${cited.label} · ${new Date(cited.occurred_at).toLocaleDateString()}`
          : null,
      };
    })();
    contextAnswers.set(meetingId, { key, answer });
    try {
      return { hits, context: await answer };
    } catch (error) {
      if (contextAnswers.get(meetingId)?.answer === answer) contextAnswers.delete(meetingId);
      throw error;
    }
  };

  const pushFrame = (meetingId: string, frame: Record<string, unknown>) => {
    const mailbox = polling.get(meetingId) ?? { at: 0, frames: [] };
    mailbox.frames.push(frame);
    mailbox.frames = mailbox.frames.slice(-20);
    polling.set(meetingId, mailbox);
    for (const wake of waiters.get(meetingId) ?? []) wake();
  };

  // Runs for every stored line. One lookup per meeting at a time, and lines
  // that arrive meanwhile trigger exactly one more, so a burst of speech never
  // queues a model call per sentence.
  const scheduleContext = (meetingId: string) => {
    const run = runs.get(meetingId) ?? { running: false, again: false };
    runs.set(meetingId, run);
    if (run.running) {
      run.again = true;
      return;
    }
    run.running = true;
    void (async () => {
      try {
        do {
          run.again = false;
          try {
            const { hits, context } = await contextFor(meetingId);
            const text = context?.synthesis?.answer;
            if (text && pushed.get(meetingId) !== text) {
              pushed.set(meetingId, text);
              pushFrame(meetingId, { kind: "context", body: text, quote: context.quote, source: context.source });
              console.log(`  context: pushed to panel (meeting ${meetingId.slice(0, 8)}): "${text}"`);
            } else if (hits.length > 0) {
              // The lookup ran and found candidates, but nothing was shown --
              // either the model returned no answer, or it repeated the last
              // one and got deduplicated. Without this, "nothing appeared" and
              // "nothing was even tried" look identical from the terminal.
              console.log(
                `  context: ${hits.length} candidate(s) found (meeting ${meetingId.slice(0, 8)}), nothing new to show`,
              );
            }
          } catch (error) {
            // The panel stays as it was and the next line retries, but the
            // failure is said out loud: swallowed, it looked exactly like
            // "nothing relevant" and hid a bug that dropped every answer.
            console.log(
              `  context: lookup failed (meeting ${meetingId.slice(0, 8)}): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } while (run.again && !stopped);
      } finally {
        run.running = false;
      }
    })();
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
      // Broken sentences have several possible causes that look identical in
      // the transcript: a real pause, a quiet microphone, or noise the
      // threshold takes for speech. This line tells them apart.
      onCommit(info) {
        console.log(
          `  audio: ${source} cut (${info.reason}) after ${(info.utteranceMs / 1000).toFixed(1)}s, ` +
            `${(info.speechMs / 1000).toFixed(1)}s above threshold, level ${info.medianLevel} ` +
            `(quiet ${info.quietLevel}, threshold ${info.threshold})`,
        );
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
      // The panel reads this to decide where text comes from: with a
      // transcriber configured, Meet's captions are never used.
      res.end(
        JSON.stringify({
          ok: true,
          principal: options.principalActorId,
          audio: Boolean(options.transcribe),
        }),
      );
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
        json(res, { hits, synthesis: (await options.answer?.([query], hits)) ?? null });
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
        try {
          const { hits, context } = await contextFor(id);
          json(res, { hits, synthesis: context?.synthesis ?? null });
        } catch {
          json(res, { hits: [], synthesis: null, warning: "Answer unavailable." });
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
        for (const [key, value] of polling)
          if (Date.now() - value.at > 60000 && !waiters.get(key)?.size) polling.delete(key);
        const current = polling.get(meetingId);
        // The panel can only reach the bridge through its service worker, so it
        // cannot hold a stream open. A long poll does the same job: the request
        // waits here until something arrives, and the answer reaches the panel
        // the moment it exists instead of on its next poll.
        if (url.searchParams.get("wait") === "1" && !current?.frames.length) {
          polling.set(meetingId, { at: Date.now(), frames: current?.frames ?? [] });
          await new Promise<void>((resolve) => {
            const set = waiters.get(meetingId) ?? new Set<() => void>();
            waiters.set(meetingId, set);
            const done = () => {
              clearTimeout(timer);
              set.delete(done);
              resolve();
            };
            const timer = setTimeout(done, LONG_POLL_MS);
            set.add(done);
            res.on("close", done);
          });
          if (res.destroyed || res.writableEnded) return;
        }
        const mailbox = polling.get(meetingId) ?? { at: Date.now(), frames: [] };
        polling.set(meetingId, { at: Date.now(), frames: [] });
        json(res, { frames: mailbox.frames });
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
      for (const set of waiters.values()) for (const wake of set) wake();
      waiters.clear();
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
      const surfaceId = decision.delivery.surface_id ?? "";
      if (
        recipients.length === 0 &&
        (!mailbox || (Date.now() - mailbox.at > LONG_POLL_MS + 5000 && !waiters.get(surfaceId)?.size))
      ) {
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
        for (const wake of waiters.get(surfaceId) ?? []) wake();
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
