import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ContextEvent, LlmClient } from "@contracts";
import { NoteSchema, type ExtractNotes, type MemoryHit } from "@adapters/browser/memory";

// The LLM client reports a failed call as {"error": ...} so callers can fall
// back instead of crashing. Parsing that as notes turned a provider limit into
// "notes: Required", which named nothing anyone could act on.
const parseModelJson = (text: string): Record<string, unknown> => {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (typeof parsed.error === "string") throw new Error(`Model provider: ${parsed.error}`);
  return parsed;
};

export function createMeetingAnswerer(llm: LlmClient, options: { language: string } = { language: "es" }) {
  if (llm.name === "fake") return undefined;
  // v3. Excerpts go out under short ids: given the raw event ids, the model
  // shortened them into ids that do not exist, and every such answer was
  // refused. The meeting language is passed explicitly: "the user's language"
  // followed the English of notes and loanwords instead of the meeting.
  const system = readFileSync(new URL("../prompts/memory/answer.v3.md", import.meta.url), "utf8");
  return async (lines: string[], hits: MemoryHit[]) => {
    if (!hits.length) return null;
    const excerpts = hits.map((hit, i) => ({
      id: `E${i + 1}`,
      meeting: hit.label,
      when: hit.occurred_at,
      speaker: hit.speaker,
      text: hit.text,
    }));
    const response = await llm.complete({
      system,
      // Only the latest line is answered. The ones before it say what it refers
      // to; sent as one blob, an earlier topic took over the answer.
      user: JSON.stringify({
        language: options.language,
        now: lines.at(-1) ?? "",
        before: lines.slice(0, -1),
        excerpts,
      }),
      json: true,
      promptId: "memory.answer",
      maxTokens: 200,
      temperature: 0,
    });
    const raw = parseModelJson(response.text) as { answer?: unknown };
    if (raw.answer === null || raw.answer === "") return null;
    const parsed = z
      .object({ answer: z.string().min(1).max(300), sources: z.array(z.string()).max(8) })
      .parse(raw);
    const sources = parsed.sources
      .map((id) => hits[Number(/^E(\d+)$/.exec(id.trim())?.[1]) - 1]?.event_id)
      .filter((id): id is string => Boolean(id));
    // An answer that cites nothing it was given is unsupported. Showing nothing
    // is the honest outcome, and it is no longer an exception the bridge
    // would swallow while the panel stayed empty.
    if (sources.length === 0) return null;
    return { answer: parsed.answer, sources: [...new Set(sources)] };
  };
}

/**
 * A short, specific title for the vault filename -- "Meet 2026-09-17.md" is
 * what every untitled Google Meet call is named by default, and it tells a
 * person scanning their vault nothing about which one it was. Independent of
 * note extraction: even in transcript-only mode, a meeting is still worth
 * naming for what it was about.
 */
export function createMeetingTitler(llm: LlmClient): ((events: ContextEvent[]) => Promise<string>) | undefined {
  if (llm.name === "fake") return undefined;
  const system = readFileSync(new URL("../prompts/memory/title.v1.md", import.meta.url), "utf8");
  return async (events) => {
    // The gist is in how a meeting opens and where it lands, not in every
    // line between -- capped so a long meeting still costs one small call.
    const excerpt = events
      .slice(0, 40)
      .map((e) => ({ speaker: e.actor.display_name, text: e.text.slice(0, 400) }));
    const response = await llm.complete({
      system,
      user: JSON.stringify(excerpt),
      json: true,
      promptId: "memory.title",
      temperature: 0,
      maxTokens: 60,
    });
    return z.object({ title: z.string().trim().min(1).max(80) }).parse(parseModelJson(response.text)).title;
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
    return z.object({ notes: z.array(NoteSchema).max(16) }).parse(parseModelJson(result.text)).notes;
  };
}
