import { readFileSync } from "node:fs";
import { z } from "zod";
import type { LlmClient } from "@contracts";
import { NoteSchema, type ExtractNotes, type MemoryHit } from "@adapters/browser/memory";

export function createMeetingAnswerer(llm: LlmClient) {
  if (llm.name === "fake") return undefined;
  const system = readFileSync(new URL("../prompts/memory/answer.v1.md", import.meta.url), "utf8");
  return async (question: string, hits: MemoryHit[]) => {
    if (!hits.length) return null;
    const response = await llm.complete({
      system,
      user: JSON.stringify({ question, excerpts: hits }),
      json: true,
      promptId: "memory.answer",
      maxTokens: 1000,
      temperature: 0,
    });
    const answer = z
      .object({ answer: z.string().min(1).max(1800), sources: z.array(z.string()).min(1).max(8) })
      .parse(JSON.parse(response.text));
    if (answer.sources.some((id) => !hits.some((hit) => hit.event_id === id)))
      throw new Error("Answer returned an unknown source");
    return answer;
  };
}

export function createMeetingExtractor(llm: LlmClient): ExtractNotes | undefined {
  // The demo provider must not pretend it has extracted semantic knowledge.
  if (llm.name === "fake") return undefined;
  const system = readFileSync(new URL("../prompts/memory/extract.v1.md", import.meta.url), "utf8");
  return async (events) => {
    const result = await llm.complete({
      system,
      user: JSON.stringify(
        events.map((e) => ({
          event_id: e.event_id,
          at: e.occurred_at,
          speaker: e.actor.display_name,
          text: e.text,
        })),
      ),
      json: true,
      promptId: "memory.extract",
      temperature: 0,
      // Kept low so a small credit balance can still complete a run. Raise it
      // for longer meetings once the account has room.
      maxTokens: 1800,
    });
    return z.object({ notes: z.array(NoteSchema).max(16) }).parse(JSON.parse(result.text)).notes;
  };
}
