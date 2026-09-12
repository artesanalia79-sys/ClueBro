import type { Clock } from "@contracts";

/** Wall clock. What Slack and the browser bridge run on. */
export const systemClock: Clock = { now: () => new Date() };

/**
 * Conversation clock. Reports the timestamp of the event being processed
 * rather than the real time.
 *
 * Without this, a replay of a twelve minute conversation finishes in twenty
 * seconds and a two minute cooldown swallows every decision after the first.
 * With it, a recorded run behaves exactly like the live one, which is what
 * makes a prompt change measurable.
 */
export function createReplayClock(): Clock {
  let current = new Date();
  return {
    now: () => current,
    advanceTo: (at: Date) => {
      if (!Number.isNaN(at.getTime())) current = at;
    },
  };
}
