import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ObservationSchema,
  windowOf,
  type ContextEvent,
  type Detector,
  type Observation,
  type ObservationKind,
} from "@contracts";

/**
 * Stand-ins for core/detection, so nobody waits for it.
 *
 * core/action and harness import from here until detection is real. They must
 * never import anything else out of this folder.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Replays the committed Observation fixtures, in order, cycling forever. */
export function fixtureDetector(
  names: string[] = ["unanswered-question.json", "information-gap.json", "no-signal.json"],
): Detector {
  const loaded: Observation[] = names.map((n) =>
    ObservationSchema.parse(
      JSON.parse(readFileSync(join(ROOT, "contracts", "fixtures", "observation", n), "utf8")),
    ),
  );
  let i = 0;
  return {
    name: "mock-fixture-detector",
    version: "0.0.0",
    async observe(window: readonly ContextEvent[]): Promise<Observation[]> {
      const base = loaded[i % loaded.length];
      i++;
      if (!base) return [];
      // Keep the window honest so downstream ids line up with the real run.
      return [{ ...base, window: windowOf(window) }];
    },
  };
}

/**
 * Deterministic keyword detector. Useful in tests where you need a specific
 * kind for a specific message and do not want to think about fixtures.
 */
export function scriptedDetector(
  rules: { match: RegExp; kind: ObservationKind; confidence: number }[],
): Detector {
  return {
    name: "mock-scripted-detector",
    version: "0.0.0",
    async observe(window: readonly ContextEvent[]): Promise<Observation[]> {
      const last = window[window.length - 1];
      if (!last) return [];
      const rule = rules.find((r) => r.match.test(last.text));
      const kind: ObservationKind = rule?.kind ?? "no_signal";
      return [
        ObservationSchema.parse({
          schema_version: "1.0.0",
          observation_id: `obs_mock_${last.event_id}`,
          window: windowOf(window),
          kind,
          summary: rule ? `scripted match for ${kind}` : "scripted: nothing matched",
          evidence:
            kind === "no_signal"
              ? []
              : [{ event_id: last.event_id, actor_id: last.actor.actor_id, quote: last.text.slice(0, 240) }],
          subject_actor_id: kind === "no_signal" ? null : last.actor.actor_id,
          confidence: rule?.confidence ?? 0.05,
          detector: {
            name: "mock-scripted-detector",
            version: "0.0.0",
            prompt_id: null,
            prompt_version: null,
            model: null,
            latency_ms: 0,
          },
          created_at: last.occurred_at,
        }),
      ];
    },
  };
}

/** Always silent. The baseline every demo should be measured against. */
export const silentDetector: Detector = {
  name: "mock-silent-detector",
  version: "0.0.0",
  async observe(window) {
    return [
      ObservationSchema.parse({
        schema_version: "1.0.0",
        observation_id: `obs_mock_silent_${window[window.length - 1]?.event_id ?? "empty"}`,
        window: windowOf(window),
        kind: "no_signal",
        summary: "mock detector that never sees anything",
        evidence: [],
        subject_actor_id: null,
        confidence: 0,
        detector: {
          name: "mock-silent-detector",
          version: "0.0.0",
          prompt_id: null,
          prompt_version: null,
          model: null,
          latency_ms: 0,
        },
        created_at: window[window.length - 1]?.occurred_at ?? new Date().toISOString(),
      }),
    ];
  },
};
