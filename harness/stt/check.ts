/**
 * The OpenAI transcription client against a local socket that speaks the same
 * events, so the wire protocol and the sentence boundaries are checked with
 * no key and no network.
 */
import { WebSocketServer, type WebSocket } from "ws";
import { createOpenAiTranscription } from "./openai-realtime";
import { check, checkEqual, report } from "../../scripts/expect";

const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;

let authorization = "";
let peer: WebSocket | undefined;
const received: { type: string; audio?: string; session?: Record<string, unknown> }[] = [];
let commits = 0;
server.on("connection", (socket, req) => {
  peer = socket;
  authorization = req.headers.authorization ?? "";
  socket.on("message", (data) => {
    const event = JSON.parse(String(data));
    received.push(event);
    if (event.type === "input_audio_buffer.commit") {
      commits++;
      socket.send(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: ` Line ${commits}. `,
        }),
      );
    }
  });
});

// 100 ms of 24 kHz PCM16: a loud tone for speech, zeros for silence.
const speech = () => {
  const chunk = Buffer.alloc(4800);
  for (let i = 0; i < 2400; i++) chunk.writeInt16LE(Math.round(8000 * Math.sin(i / 5)), i * 2);
  return chunk;
};
const silence = () => Buffer.alloc(4800);
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const lines: string[] = [];
const errors: string[] = [];
const open = createOpenAiTranscription({
  apiKey: "sk-test",
  model: "gpt-live-transcribe",
  languages: ["es"],
  delay: "low",
  url: `ws://127.0.0.1:${port}`,
});
const reasons: string[] = [];
const stream = open({
  onLine: (text) => lines.push(text),
  onError: (error) => errors.push(error.message),
  onCommit: (info) => reasons.push(info.reason),
});

// Sent before the socket opens: held, not dropped. Two seconds of speech and
// a sentence-ending pause.
for (let i = 0; i < 20; i++) stream.append(speech());
for (let i = 0; i < 13; i++) stream.append(silence());
await settle();

checkEqual("the key travels as a bearer token", authorization, "Bearer sk-test");
const session = received[0];
checkEqual("the session is configured before any audio", session?.type, "session.update");
const input = (session?.session as { audio?: { input?: Record<string, unknown> } })?.audio?.input;
checkEqual(
  "the session asks for the configured model and language",
  JSON.stringify((input?.transcription as Record<string, unknown>) ?? {}),
  JSON.stringify({ model: "gpt-live-transcribe", languages: ["es"], delay: "low" }),
);
checkEqual("server-side turn detection is off, because this model rejects it", input?.turn_detection, null);
checkEqual(
  "audio sent before the socket opened is not lost",
  received.filter((e) => e.type === "input_audio_buffer.append").length,
  33,
);
checkEqual("a sentence followed by a pause ends exactly one line", commits, 1);
checkEqual("the finished line reaches the caller, trimmed", JSON.stringify(lines), JSON.stringify(["Line 1."]));

// Half a second of speech, a normal mid-sentence pause, then the rest of the
// sentence: one line, not two loose fragments.
for (let i = 0; i < 5; i++) stream.append(speech());
for (let i = 0; i < 13; i++) stream.append(silence());
await settle();
checkEqual("a pause after a few words does not cut the sentence", commits, 1);
for (let i = 0; i < 10; i++) stream.append(speech());
for (let i = 0; i < 13; i++) stream.append(silence());
await settle();
checkEqual("the sentence ends once enough of it has been said", commits, 2);

for (let i = 0; i < 5; i++) stream.append(speech());
for (let i = 0; i < 26; i++) stream.append(silence());
await settle();
checkEqual("a short answer on its own still ends after a long silence", commits, 3);

for (let i = 0; i < 30; i++) stream.append(silence());
await settle();
checkEqual("silence alone commits nothing", commits, 3);

for (let i = 0; i < 160; i++) stream.append(speech());
await settle();
checkEqual("sixteen seconds without a pause still produce a line", commits, 4);

peer?.send(JSON.stringify({ type: "error", error: { message: "rate limited" } }));
await settle();
check("a vendor error reaches the caller", errors.some((message) => message.includes("rate limited")));

for (let i = 0; i < 5; i++) stream.append(speech());
stream.close();
await settle();
checkEqual("hanging up mid-sentence keeps the last sentence", commits, 5);
checkEqual("and it is delivered before the socket closes", lines.at(-1), "Line 5.");

checkEqual(
  "every cut says why it happened",
  JSON.stringify(reasons),
  JSON.stringify(["pause", "pause", "long-pause", "max-length", "hang-up"]),
);

server.close();
report("harness/stt openai realtime");
