/**
 * The OpenAI transcription client against a local socket that speaks the same
 * events, so the wire protocol is checked with no key and no network.
 */
import { WebSocketServer } from "ws";
import { createOpenAiTranscription } from "./openai-realtime";
import { check, checkEqual, report } from "../../scripts/expect";

const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;

let authorization = "";
const received: { type: string; audio?: string; session?: Record<string, unknown> }[] = [];
server.on("connection", (socket, req) => {
  authorization = req.headers.authorization ?? "";
  socket.on("message", (data) => {
    const event = JSON.parse(String(data));
    received.push(event);
    if (event.type === "input_audio_buffer.append" && received.filter((e) => e.type === event.type).length === 2) {
      socket.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "Nos" }));
      socket.send(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: " Nos vemos el jueves. ",
        }),
      );
      socket.send(JSON.stringify({ type: "error", error: { message: "rate limited" } }));
    }
  });
});

const lines: string[] = [];
const errors: string[] = [];
const open = createOpenAiTranscription({
  apiKey: "sk-test",
  model: "gpt-live-transcribe",
  languages: ["es"],
  delay: "low",
  url: `ws://127.0.0.1:${port}`,
});
const stream = open({ onLine: (text) => lines.push(text), onError: (error) => errors.push(error.message) });

// Sent before the socket opens: must be held, not dropped.
stream.append(Buffer.from([1, 2, 3, 4]));
await new Promise((resolve) => setTimeout(resolve, 150));
stream.append(Buffer.from([5, 6]));
await new Promise((resolve) => setTimeout(resolve, 150));

checkEqual("the key travels as a bearer token", authorization, "Bearer sk-test");
const session = received[0];
checkEqual("the session is configured before any audio", session?.type, "session.update");
const input = (session?.session as { audio?: { input?: Record<string, unknown> } })?.audio?.input;
checkEqual(
  "the session asks for the configured model and language",
  JSON.stringify((input?.transcription as Record<string, unknown>) ?? {}),
  JSON.stringify({ model: "gpt-live-transcribe", languages: ["es"], delay: "low" }),
);
const appended = received.filter((e) => e.type === "input_audio_buffer.append");
checkEqual("audio sent before the socket opened is not lost", appended.length, 2);
checkEqual("audio travels base64-encoded", appended[0]?.audio, Buffer.from([1, 2, 3, 4]).toString("base64"));
checkEqual("only finished lines become captions, trimmed", JSON.stringify(lines), JSON.stringify(["Nos vemos el jueves."]));
check("a vendor error reaches the caller", errors.some((message) => message.includes("rate limited")));

stream.close();
server.close();
report("harness/stt openai realtime");
