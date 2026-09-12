import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DecisionLogRecordSchema,
  type ActionDecision,
  type ActionResult,
  type ContextEvent,
  type DecisionLogRecord,
  type Logger,
  type Observation,
} from "@contracts";

/**
 * The demo surface.
 *
 * The interesting output of this agent is not the messages it sends, it is the
 * running account of what it saw and what it decided not to do about it. That
 * is what this file prints, one block per incoming event, with the reason
 * always visible.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const C = {
  reset: "[0m",
  dim: "[2m",
  bold: "[1m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  blue: "[34m",
  magenta: "[35m",
  cyan: "[36m",
  grey: "[90m",
};

const paint = (color: string, text: string): string =>
  process.stdout.isTTY ? `${color}${text}${C.reset}` : text;

const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toISOString().slice(11, 19);
};

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`;

export function createLogger(level: LogLevel = "info"): Logger {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl: LogLevel, color: string, msg: string, data?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const suffix = data && Object.keys(data).length > 0 ? ` ${paint(C.grey, JSON.stringify(data))}` : "";
    console.log(`${paint(color, lvl.padEnd(5))} ${msg}${suffix}`);
  };
  return {
    debug: (m, d) => emit("debug", C.grey, m, d),
    info: (m, d) => emit("info", C.blue, m, d),
    warn: (m, d) => emit("warn", C.yellow, m, d),
    error: (m, d) => emit("error", C.red, m, d),
  };
}

export interface DecisionLog {
  write(input: {
    traceId: string;
    event: ContextEvent;
    observation: Observation;
    decision: ActionDecision;
    result: ActionResult | null;
    timings: DecisionLogRecord["timings_ms"];
  }): void;
  /** Printed once at the end of a replay. The scoreboard for the demo. */
  summary(): {
    events: number;
    spoke: number;
    stayedQuiet: number;
    /** Decisions where a model call failed and the heuristics stood in. */
    degraded: number;
    byReason: Record<string, number>;
    /**
     * Silence reasons only. Kept apart from byReason because "how many
     * different ways did it decide not to speak" is the number the product is
     * judged on, and mixing the speak reasons in hides it.
     */
    bySilenceReason: Record<string, number>;
  };
}

export interface DecisionLogOptions {
  file: string | null;
  pretty: boolean;
  /**
   * Prompt provenance and the dry-run delivery line. Real, queryable, and of
   * no use to somebody reading the screen: they go behind --debug so the
   * default block stays readable in two seconds. Everything they carry is in
   * the JSONL record either way.
   */
  verbose?: boolean;
}

/**
 * The rationale usually opens by restating the observation, which puts the
 * same sentence on screen twice. Print only what the rationale adds.
 */
/**
 * A model call that failed leaves "(failed)" in the model name. The pipeline
 * carries on with the heuristic prefilter, which is the right behaviour and
 * the wrong thing to hide: a block built from regex must not look like a block
 * built from judgement.
 */
const ranWithoutModel = (model: string | null | undefined): boolean =>
  typeof model === "string" && model.endsWith("(failed)");

function reasonBeyond(summary: string, rationale: string): string | null {
  const extra = rationale.startsWith(summary) ? rationale.slice(summary.length) : rationale;
  const trimmed = extra.replace(/^[\s.;:,-]+/, "").trim();
  return trimmed.length > 20 ? trimmed : null;
}

export function createDecisionLog(options: DecisionLogOptions): DecisionLog {
  const verbose = options.verbose ?? false;
  const counts = { events: 0, spoke: 0, stayedQuiet: 0, degraded: 0 };
  const byReason: Record<string, number> = {};
  const bySilenceReason: Record<string, number> = {};
  let sequence = 0;

  if (options.file) mkdirSync(dirname(options.file), { recursive: true });

  const printBlock = (record: DecisionLogRecord) => {
    const { trigger_event: ev, observation: obs, decision: dec, result } = record;
    const surface = ev.source.surface_label ?? ev.source.surface_id;

    console.log(
      `\n${paint(C.bold, clock(ev.occurred_at))} ${paint(C.cyan, surface)} ` +
        `${paint(C.bold, ev.actor.display_name)}: ${truncate(ev.text, 88)}`,
    );

    const kindColor = obs.kind === "no_signal" ? C.grey : C.magenta;
    const sawMark = ranWithoutModel(obs.detector.model)
      ? ` ${paint(C.yellow, "[heuristics only]")}`
      : "";
    console.log(
      `  ${paint(C.grey, "saw")}      ${paint(kindColor, obs.kind)} ` +
        `${paint(C.grey, `(${obs.confidence.toFixed(2)})`)} ${truncate(obs.summary, 96)}${sawMark}`,
    );

    if (dec.act && dec.delivery && dec.draft) {
      const route =
        dec.delivery.target === "actor"
          ? `direct message to ${dec.delivery.actor_id}`
          : `post in ${dec.delivery.surface_id}`;
      console.log(
        `  ${paint(C.grey, "decided")}  ${paint(C.green, "SPEAK")} ${paint(C.grey, "->")} ${route} ` +
          `${paint(C.bold + C.green, `[${dec.reason_code}]`)}`,
      );
      const speakBecause = reasonBeyond(obs.summary, dec.rationale);
      if (speakBecause) {
        console.log(`  ${paint(C.grey, "because")}  ${paint(C.dim, truncate(speakBecause, 150))}`);
      }
      console.log(`  ${paint(C.grey, "says")}     ${truncate(dec.draft.body, 150)}`);
      if (dec.draft.sources.length > 0) {
        console.log(
          `  ${paint(C.grey, "sources")}  ${dec.draft.sources.map((s) => `${s.label} <${s.ref}>`).join(", ")}`,
        );
      }
    } else {
      // The line this whole project is about, so the reason code is the
      // brightest thing in the block rather than grey punctuation after it.
      console.log(
        `  ${paint(C.grey, "decided")}  ${paint(C.yellow, "STAY QUIET")} ` +
          `${paint(C.bold + C.yellow, `[${dec.reason_code}]`)}`,
      );
      const quietBecause = reasonBeyond(obs.summary, dec.rationale);
      if (quietBecause) {
        console.log(`  ${paint(C.grey, "because")}  ${paint(C.dim, truncate(quietBecause, 150))}`);
      }
    }

    const worthShowing =
      result && (verbose ? result.status !== "skipped_no_action" : result.status === "delivered" || result.status === "failed");
    if (result && worthShowing) {
      const statusColor =
        result.status === "delivered" ? C.green : result.status === "failed" ? C.red : C.grey;
      const detail = result.error ? ` ${result.error.code}: ${result.error.message}` : "";
      console.log(
        `  ${paint(C.grey, "sent")}     ${paint(statusColor, result.status)}${detail} ` +
          `${paint(C.grey, `${record.timings_ms.total}ms total`)}`,
      );
    }

    const promptTrail = [
      obs.detector.prompt_id ? `${obs.detector.prompt_id}@${obs.detector.prompt_version}` : null,
      dec.decided_by.prompt_id ? `${dec.decided_by.prompt_id}@${dec.decided_by.prompt_version}` : null,
    ]
      .filter(Boolean)
      .join(" + ");
    if (promptTrail && verbose) {
      console.log(`  ${paint(C.grey, "prompts")}  ${paint(C.grey, promptTrail)}`);
    }
  };

  return {
    write(input) {
      sequence++;
      const record = DecisionLogRecordSchema.parse({
        schema_version: "1.0.0",
        record_id: `rec_${String(sequence).padStart(5, "0")}`,
        trace_id: input.traceId,
        logged_at: new Date().toISOString(),
        trigger_event: input.event,
        observation: input.observation,
        decision: input.decision,
        result: input.result,
        timings_ms: input.timings,
      } satisfies Record<string, unknown>);

      counts.events++;
      if (record.decision.act) counts.spoke++;
      else counts.stayedQuiet++;
      if (
        ranWithoutModel(record.observation.detector.model) ||
        ranWithoutModel(record.decision.decided_by.model)
      ) {
        counts.degraded++;
      }
      byReason[record.decision.reason_code] = (byReason[record.decision.reason_code] ?? 0) + 1;
      if (!record.decision.act) {
        bySilenceReason[record.decision.reason_code] =
          (bySilenceReason[record.decision.reason_code] ?? 0) + 1;
      }

      if (options.file) appendFileSync(options.file, `${JSON.stringify(record)}\n`, "utf8");
      if (options.pretty) printBlock(record);
    },

    summary() {
      return {
        ...counts,
        byReason: { ...byReason },
        bySilenceReason: { ...bySilenceReason },
      };
    },
  };
}

export function printSummary(log: DecisionLog): void {
  const s = log.summary();
  console.log(`\n${paint(C.bold, "Run summary")}`);
  console.log(`  events seen     ${s.events}`);
  console.log(`  spoke           ${paint(C.green, String(s.spoke))}`);
  console.log(`  stayed quiet    ${paint(C.yellow, String(s.stayedQuiet))}`);

  const reasons = Object.entries(s.bySilenceReason).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    console.log(`\n  ${paint(C.yellow, "why it stayed quiet")}`);
    for (const [reason, count] of reasons) {
      console.log(`    ${String(count).padStart(3)}  ${reason}`);
    }
  }

  // Never let a run that fell back to regex be mistaken for a run that used
  // judgement. The confidences above are crude priors when this fires.
  if (s.degraded > 0) {
    console.log(
      `\n  ${paint(C.red, "!")} ${paint(C.bold, `${s.degraded} of ${s.events}`)} ` +
        `decision(s) ran without the model. Those confidences and summaries come
` +
        `    from the heuristic prefilter, not from judgement. See the warning above
` +
        `    for why the call failed.`,
    );
  }
  console.log("");
}
