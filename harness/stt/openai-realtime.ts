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

// 24 kHz, 16-bit, mono.
const BYTES_PER_MS = 48;
// Above background hiss, well below conversational speech.
const SPEECH_RMS = 600;
// A pause this long after speech ends the sentence.
const SILENCE_TO_COMMIT_MS = 700;
// Someone talking without pause still gets a line this often, instead of the
// transcript waiting for them to breathe.
const MAX_UTTERANCE_MS = 15_000;
// How long to wait for the last sentence after the stream is closed.
const CLOSE_GRACE_MS = 3_000;
// Messages queued before the socket opens, but only this many: a connection
// that never opens must not turn a meeting into unbounded memory.
const MAX_BACKLOG = 400;

const rms = (chunk: Buffer): number => {
  const samples = Math.floor(chunk.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const sample = chunk.readInt16LE(i * 2);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
};

export function createOpenAiTranscription(options: OpenAiTranscriptionOptions): OpenTranscription {
  return ({ onLine, onError }) => {
    const socket = new WebSocket(options.url ?? "wss://api.openai.com/v1/realtime?intent=transcription", {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    });
    const backlog: string[] = [];
    let open = false;
    let closing = false;
    let awaiting = 0;
    let heardSpeech = false;
    let silenceMs = 0;
    let utteranceMs = 0;

    const send = (message: object) => {
      const serialized = JSON.stringify(message);
      if (open) socket.send(serialized);
      else if (backlog.length < MAX_BACKLOG) backlog.push(serialized);
    };

    // This model rejects server-side turn detection, so the sentence
    // boundaries are ours to draw: without a commit it streams partial text
    // forever and never finishes a line.
    const commit = () => {
      if (!heardSpeech) return;
      send({ type: "input_audio_buffer.commit" });
      awaiting++;
      heardSpeech = false;
      silenceMs = 0;
      utteranceMs = 0;
    };

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
                turn_detection: null,
              },
            },
          },
        }),
      );
      for (const message of backlog.splice(0)) socket.send(message);
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
        awaiting = Math.max(0, awaiting - 1);
        const text = String(event.transcript ?? "").trim();
        if (text) onLine(text);
        if (closing && awaiting === 0) socket.close();
      } else if (event.type === "error") {
        onError(new Error(`transcription: ${event.error?.message ?? "unknown error"}`));
      }
    });

    socket.on("error", (error) => onError(error));

    return {
      append(chunk) {
        if (closing) return;
        send({ type: "input_audio_buffer.append", audio: chunk.toString("base64") });
        const ms = chunk.length / BYTES_PER_MS;
        if (rms(chunk) >= SPEECH_RMS) {
          heardSpeech = true;
          silenceMs = 0;
        } else if (heardSpeech) {
          silenceMs += ms;
        }
        if (heardSpeech) utteranceMs += ms;
        if (heardSpeech && (silenceMs >= SILENCE_TO_COMMIT_MS || utteranceMs >= MAX_UTTERANCE_MS)) commit();
      },
      close() {
        if (closing) return;
        closing = true;
        // The call ending mid-sentence is the normal case, not an edge case:
        // the last thing said before hanging up is often the decision.
        commit();
        if (awaiting === 0) socket.close();
        else setTimeout(() => socket.close(), CLOSE_GRACE_MS).unref();
      },
    };
  };
}
