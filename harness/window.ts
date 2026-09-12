import type { ContextEvent } from "@contracts";

/**
 * Per-surface conversation memory. Bounded by count and by age, because the
 * agent should react to what is happening now and because a prompt has a
 * budget.
 *
 * One buffer per surface_id: two channels never bleed into each other.
 */

export interface WindowStoreConfig {
  maxEvents: number;
  maxAgeSeconds: number;
}

export class WindowStore {
  private readonly bySurface = new Map<string, ContextEvent[]>();

  constructor(private readonly config: WindowStoreConfig) {}

  /** Adds an event and returns the current window for its surface. */
  push(event: ContextEvent): ContextEvent[] {
    const key = event.source.surface_id;
    const existing = this.bySurface.get(key) ?? [];

    // Duplicates happen: Slack retries, a reconnect replays, a caption
    // repeats. Dropping them here keeps every downstream count honest.
    if (existing.some((e) => e.event_id === event.event_id)) {
      return this.prune(key, existing, event.occurred_at);
    }

    existing.push(event);
    return this.prune(key, existing, event.occurred_at);
  }

  get(surfaceId: string): ContextEvent[] {
    return [...(this.bySurface.get(surfaceId) ?? [])];
  }

  private prune(key: string, events: ContextEvent[], nowIso: string): ContextEvent[] {
    const now = new Date(nowIso).getTime();
    const cutoff = now - this.config.maxAgeSeconds * 1000;
    const fresh = events
      .filter((e) => new Date(e.occurred_at).getTime() >= cutoff)
      .slice(-this.config.maxEvents);
    this.bySurface.set(key, fresh);
    return [...fresh];
  }
}
