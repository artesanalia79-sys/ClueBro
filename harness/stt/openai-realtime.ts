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
// People pause mid-sentence for longer than 700 ms; ending a line there cut
// every thought into loose words. A pause this long ends a sentence...
const SILENCE_TO_COMMIT_MS = 1_200;
// ...but only once there has been this much speech, so "the meeting is on...
// Thursday" stays one line instead of two.
const MIN_SPEECH_MS = 1_500;
// A short answer on its own ("yes", "Luis") still ends after a long silence.
const LONG_SILENCE_MS = 2_500;
// Someone talking without pause still gets a line this often, instead of the
// transcript waiting for them to breathe.
const MAX_UTTERANCE_MS = 15_000;
// How long to wait for the last sentence after the stream is closed.
const CLOSE_GRACE_MS = 3_000;
// Messages queued before the socket opens, but only this many: a connection
// that never opens must not turn a meeting into unbounded memory.
const MAX_BACKLOG = 400;

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor((sorted.length - 1) * p)]!);
};

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
  return ({ onLine, onError, onCommit }) => {
    const socket = new WebSocket(options.url ?? "wss://api.openai.com/v1/realtime?intent=transcription", {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    });
    const backlog: string[] = [];
    let open = false;
    let closing = false;
    let awaiting = 0;
    let heardSpeech = false;
    let speechMs = 0;
    let silenceMs = 0;
    let utteranceMs = 0;
    // Levels of the current utterance, kept so each cut can report whether it
    // was a real pause or a microphone too quiet or too noisy for the threshold.
    let levels: number[] = [];

    const send = (message: object) => {
      const serialized = JSON.stringify(message);
      if (open) socket.send(serialized);
      else if (backlog.length < MAX_BACKLOG) backlog.push(serialized);
    };

    // This model rejects server-side turn detection, so the sentence
    // boundaries are ours to draw: without a commit it streams partial text
    // forever and never finishes a line.
    const commit = (reason: "pause" | "long-pause" | "max-length" | "hang-up") => {
      if (!heardSpeech) return;
      onCommit?.({
        reason,
        utteranceMs: Math.round(utteranceMs),
        speechMs: Math.round(speechMs),
        silenceMs: Math.round(silenceMs),
        medianLevel: percentile(levels, 0.5),
        quietLevel: percentile(levels, 0.2),
        threshold: SPEECH_RMS,
      });
      levels = [];
      send({ type: "input_audio_buffer.commit" });
      awaiting++;
      heardSpeech = false;
      speechMs = 0;
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
        const level = rms(chunk);
        if (level >= SPEECH_RMS) {
          heardSpeech = true;
          speechMs += ms;
          silenceMs = 0;
        } else if (heardSpeech) {
          silenceMs += ms;
        }
        if (!heardSpeech) return;
        utteranceMs += ms;
        if (levels.length < 400) levels.push(level);
        if (silenceMs >= LONG_SILENCE_MS) commit("long-pause");
        else if (silenceMs >= SILENCE_TO_COMMIT_MS && speechMs >= MIN_SPEECH_MS) commit("pause");
        else if (utteranceMs >= MAX_UTTERANCE_MS) commit("max-length");
      },
      close() {
        if (closing) return;
        closing = true;
        // The call ending mid-sentence is the normal case, not an edge case:
        // the last thing said before hanging up is often the decision.
        commit("hang-up");
        if (awaiting === 0) socket.close();
        else setTimeout(() => socket.close(), CLOSE_GRACE_MS).unref();
      },
    };
  };
}
