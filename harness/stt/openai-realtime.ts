import WebSocket from "ws";
import type { OpenTranscription } from "@adapters/browser/index";

/**
 * Streaming speech-to-text against OpenAI's realtime transcription session.
 *
 * Lives in harness/ for the same reason harness/llm/ does: the browser
 * adapter receives audio and emits captions, and must not know which vendor
 * turns one into the other.
 */

export interface OpenAiTranscriptionOptions {
  apiKey: string;
  model: string;
  /** ISO 639-1 codes the speakers are expected to use. */
  languages: string[];
  /** Latency against accuracy: minimal, low, medium, high or xhigh. */
  delay: string;
  url?: string;
}

// Audio that arrives before the socket opens is held, but only this much: a
// connection that never opens must not turn a meeting into unbounded memory.
const MAX_BACKLOG_CHUNKS = 200;

export function createOpenAiTranscription(options: OpenAiTranscriptionOptions): OpenTranscription {
  return ({ onLine, onError }) => {
    const socket = new WebSocket(options.url ?? "wss://api.openai.com/v1/realtime?intent=transcription", {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    });
    const backlog: Buffer[] = [];
    let open = false;

    const send = (chunk: Buffer) =>
      socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: chunk.toString("base64") }));

    socket.on("open", () => {
      open = true;
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: {
                  model: options.model,
                  languages: options.languages,
                  delay: options.delay,
                },
                // Server-side turn detection closes each utterance on a pause,
                // which is what makes a completed line a sentence rather than
                // an arbitrary slice of audio.
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                },
              },
            },
          },
        }),
      );
      for (const chunk of backlog.splice(0)) send(chunk);
    });

    socket.on("message", (data) => {
      let event: { type?: string; transcript?: unknown; error?: { message?: string } };
      try {
        event = JSON.parse(String(data));
      } catch {
        return;
      }
      // Deltas are ignored on purpose: a caption is stored once, and storing
      // every partial would feed detection half-sentences it cannot judge.
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        const text = String(event.transcript ?? "").trim();
        if (text) onLine(text);
      } else if (event.type === "error") {
        onError(new Error(`transcription: ${event.error?.message ?? "unknown error"}`));
      }
    });

    socket.on("error", (error) => onError(error));

    return {
      append(chunk) {
        if (open) send(chunk);
        else if (backlog.length < MAX_BACKLOG_CHUNKS) backlog.push(chunk);
      },
      close() {
        socket.close();
      },
    };
  };
}
