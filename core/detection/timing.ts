import type { ContextEvent, ObservationKind } from "@contracts";

/**
 * Timing, decided by code instead of by the model.
 *
 * The model judges meaning well and counts badly: told to stay quiet once three
 * replies had gone past a question, it listed five and spoke anyway. So the
 * prompt names the need and the line that states it, and this file decides
 * whether the newest line is the moment to report it. Deterministic, so a replay
 * says the same thing twice and a check can pin it down.
 *
 * Whether an idea counts as a plan is still judgement, and stays in the prompt.
 */

/** One reply going past a question is weak evidence that it was ignored. */
export const ONE_REPLY_MAX_CONFIDENCE = 0.5;

/**
 * By this many replies the question was already reported, at the second one.
 * Repeating it on every later line is noise.
 */
export const QUESTION_ALREADY_REPORTED_AFTER = 3;

export interface TimedVerdict {
  kind: ObservationKind;
  confidence: number;
  /** Why timing overruled the model, readable out loud. Null when it did not. */
  note: string | null;
}

const silence = (note: string): TimedVerdict => ({ kind: "no_signal", confidence: 0.1, note });

export function applyTiming(
  kind: ObservationKind,
  confidence: number,
  needEventId: string | null,
  window: readonly ContextEvent[],
): TimedVerdict {
  if (kind === "no_signal") return { kind, confidence, note: null };

  const humans = window.filter((e) => !e.actor.is_agent);
  const index = humans.findIndex((e) => e.event_id === needEventId);
  const need = humans[index];
  if (!need) {
    return silence("The model pointed at a line that is not in this window, so there is nothing to cite.");
  }

  const later = humans.slice(index + 1);
  const who = need.actor.display_name;

  if (kind === "unanswered_question") {
    // The asker adding "anyone?" is not somebody else letting the question pass.
    const replies = later.filter((e) => e.actor.actor_id !== need.actor.actor_id).length;
    if (replies === 0) {
      return silence(`${who} just asked. Nobody has had a chance to answer yet.`);
    }
    if (replies >= QUESTION_ALREADY_REPORTED_AFTER) {
      return silence(
        `${who}'s question is ${replies} replies old. It was reported when the second reply went past it.`,
      );
    }
    return {
      kind,
      confidence: replies === 1 ? Math.min(confidence, ONE_REPLY_MAX_CONFIDENCE) : confidence,
      note: null,
    };
  }

  // A search or a plan is reported once, on the line that states it.
  if (later.length > 0) {
    const what = kind === "information_gap" ? "search" : "plan";
    return silence(`${who}'s ${what} was already open before the newest line. Not repeating it.`);
  }
  return { kind, confidence, note: null };
}
