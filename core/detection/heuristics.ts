import type { ContextEvent, ObservationKind } from "@contracts";

/**
 * The cheap pass. No model, no network, no cost.
 *
 * Two jobs:
 *   1. throw away chit-chat before it reaches a paid model
 *   2. keep the whole pipeline working when the model is unavailable
 *
 * These rules are intentionally crude. The model refines them. Do not try to
 * make this file clever: if a rule needs judgement, it belongs in a prompt.
 */

export interface HeuristicHit {
  kind: Exclude<ObservationKind, "no_signal">;
  event: ContextEvent;
  quote: string;
  /** 0..1, a rough prior the model is free to overrule. */
  strength: number;
  note: string;
}

const SMALLTALK =
  /^(ha(ha)+|lol+|jaja+|thanks?|thank you|ty|np|nice|cool|great|awesome|same|\+1|ok(ay)?|yep|yes|no|sure|done|gm|morning|brb)\b/i;

const QUESTION_OPENERS =
  /^(who|what|when|where|why|which|how|is|are|was|were|do|does|did|can|could|should|would|has|have|any(one|body)|somebody)\b/i;

const SEEKING =
  /\b(can'?t find|cannot find|couldn'?t find|where is|where'?s|anyone have|does anyone have|any(one|body) got|looking for|lost the|no idea where|link to)\b/i;

const LOOSE_PLAN =
  /\b(let'?s|we should|we could|we need to|someone should|why don'?t we|next week|next sprint|at some point|sometime|later today|tomorrow)\b/i;

const HAS_OWNER = /(@|\bI'?ll\b|\bi will\b|\bi'?ve got\b|\bmine\b|\btaking it\b|\bon it\b)/i;

const HAS_DATE =
  /\b(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|\d{1,2}[:h]\d{2}|\d{1,2}\s?(am|pm)|\d{1,2}\/\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;

export const isSmalltalk = (text: string): boolean =>
  text.trim().length < 12 || SMALLTALK.test(text.trim());

export const isQuestion = (text: string): boolean => {
  const t = text.trim();
  return t.includes("?") || QUESTION_OPENERS.test(t);
};

/** Human messages only. Detection never reacts to bots, including itself. */
export const humansOnly = (events: readonly ContextEvent[]): ContextEvent[] =>
  events.filter((e) => !e.actor.is_agent);

const quote = (text: string): string => text.trim().slice(0, 240);

/**
 * A later message counts as an answer when a different person said something
 * substantive that is not itself a question and not banter.
 */
function looksAnswered(question: ContextEvent, later: readonly ContextEvent[]): boolean {
  return later.some(
    (e) =>
      e.actor.actor_id !== question.actor.actor_id &&
      !e.actor.is_agent &&
      !isSmalltalk(e.text) &&
      !isQuestion(e.text) &&
      e.text.trim().length >= 20,
  );
}

export function prefilter(window: readonly ContextEvent[]): HeuristicHit[] {
  const events = humansOnly(window);
  const hits: HeuristicHit[] = [];

  events.forEach((event, i) => {
    const later = events.slice(i + 1);
    const text = event.text;

    if (isSmalltalk(text)) return;

    // Someone is explicitly hunting for a fact. Strongest signal we have.
    if (SEEKING.test(text)) {
      hits.push({
        kind: "information_gap",
        event,
        quote: quote(text),
        strength: 0.7,
        note: "explicit search for a fact",
      });
      return;
    }

    // A question that the conversation moved past.
    if (isQuestion(text) && later.length >= 1 && !looksAnswered(event, later)) {
      hits.push({
        kind: "unanswered_question",
        event,
        quote: quote(text),
        strength: later.length >= 2 ? 0.72 : 0.55,
        note: `question followed by ${later.length} message(s), none of them an answer`,
      });
      return;
    }

    // A plan closing with no owner and no date.
    if (LOOSE_PLAN.test(text) && !HAS_OWNER.test(text) && !HAS_DATE.test(text)) {
      hits.push({
        kind: "plan_without_owner",
        event,
        quote: quote(text),
        strength: 0.58,
        note: "intent to act with no owner and no date",
      });
    }
  });

  // Recency first, strength as the tie-break. The agent should react to what
  // is happening now: a stale signal from ten messages ago would otherwise
  // keep winning and the agent would always be answering the wrong thing.
  return hits.sort(
    (a, b) => b.event.occurred_at.localeCompare(a.event.occurred_at) || b.strength - a.strength,
  );
}
