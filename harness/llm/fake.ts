import type { LlmClient, LlmRequest, LlmResponse } from "@contracts";

/**
 * A deterministic provider with no network and no key.
 *
 * It exists so that:
 *   - the whole pipeline runs end to end from the first commit
 *   - CI never touches a paid API
 *   - a replay of the demo transcript is byte-identical every time
 *   - nobody is blocked when the key is rate limited at minute 100
 *
 * It reads the rendered transcript back out of the prompt and applies crude
 * rules. It is intentionally not clever, and it never vetoes: judgement is
 * what the real model is for. Run with LLM_PROVIDER=openai to get judgement.
 */

const LINE = /^\[(.+?)\]\s+(.+?)\s+\((.+?)\)(?:\s+\[(.+?)\])?:\s*(.*)$/;

interface ParsedLine {
  eventId: string;
  name: string;
  actorId: string;
  text: string;
}

function parseTranscript(system: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  for (const raw of system.split("\n")) {
    const m = LINE.exec(raw.trim());
    if (m && m[1] && m[3]) {
      lines.push({ eventId: m[1], name: m[2] ?? "", actorId: m[3], text: m[5] ?? "" });
    }
  }
  return lines;
}

const SEEKING = /\b(can'?t find|cannot find|couldn'?t find|where is|where'?s|anyone have|looking for|link to|no idea where)\b/i;
const LOOSE_PLAN = /\b(let'?s|we should|we could|we need to|someone should|next week|next sprint|at some point|sometime)\b/i;
const SMALLTALK = /^(ha(ha)+|lol+|jaja+|thanks?|thank you|ty|nice|cool|great|same|\+1|ok(ay)?|yep|yes|no|sure|done)\b/i;

const substantive = (t: string): boolean =>
  t.trim().length >= 20 && !t.includes("?") && !SMALLTALK.test(t.trim());

function detectorVerdict(system: string): string {
  const lines = parseTranscript(system);

  const verdict = (
    line: ParsedLine,
    kind: string,
    summary: string,
    confidence: number,
  ): string =>
    JSON.stringify({
      kind,
      summary,
      confidence,
      subject_actor_id: line.actorId,
      evidence: [{ event_id: line.eventId, quote: line.text }],
    });

  // Newest first, exactly like the real prefilter. Reacting to the freshest
  // signal is the whole difference between a useful agent and one that keeps
  // answering something from ten messages ago.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || SMALLTALK.test(line.text.trim()) || line.text.trim().length < 12) continue;
    const later = lines.slice(i + 1);

    if (SEEKING.test(line.text)) {
      return verdict(
        line,
        "information_gap",
        `${line.name} is looking for something specific and has not found it.`,
        0.74,
      );
    }

    if (line.text.includes("?") && later.length >= 1) {
      const answered = later.some((l) => l.actorId !== line.actorId && substantive(l.text));
      if (!answered) {
        return verdict(
          line,
          "unanswered_question",
          `${line.name} asked a question and ${later.length} later message(s) went past without answering it.`,
          // One message past a question is weak evidence, two is real. Keeping
          // this graded is what makes the confidence threshold visible.
          later.length >= 2 ? 0.78 : 0.58,
        );
      }
      continue;
    }

    if (LOOSE_PLAN.test(line.text) && !line.text.includes("@") && !/\bI'?ll\b/i.test(line.text)) {
      return verdict(
        line,
        "plan_without_owner",
        `${line.name} proposed something with no owner and no date attached.`,
        0.66,
      );
    }
  }

  return JSON.stringify({
    kind: "no_signal",
    summary: "Nothing in this window that anyone is waiting on.",
    confidence: 0.09,
    subject_actor_id: null,
    evidence: [],
  });
}

function composeReply(system: string): string {
  const summary = /What you noticed:\s*(.+)/.exec(system)?.[1]?.trim() ?? "";
  const evidenceLine = /^\[(.+?)\]\s*(.+)$/m.exec(
    system.split("The lines you are responding to:")[1] ?? "",
  );
  const quote = evidenceLine?.[2]?.trim() ?? "";
  const ref = evidenceLine?.[1] ?? "";
  return JSON.stringify({
    body: quote ? `On "${quote}" — ${summary}` : summary,
    sources: ref ? [{ label: "the message this refers to", ref }] : [],
  });
}

export function createFakeLlm(): LlmClient {
  return {
    name: "fake",
    model: "fake",
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const body = (() => {
        switch (req.promptId) {
          case "detector.conversation_scan":
            return detectorVerdict(req.system);
          case "policy.should_intervene":
            return JSON.stringify({
              intervene: true,
              reason_code: null,
              rationale:
                "The fake provider never vetoes. Silence here comes from the prefilter and the thresholds. Use LLM_PROVIDER=openai to exercise real judgement.",
            });
          case "compose.channel_reply":
          case "compose.direct_message":
            return composeReply(req.system);
          default:
            return JSON.stringify({});
        }
      })();

      return { text: body, model: "fake", latencyMs: 0 };
    },
  };
}
