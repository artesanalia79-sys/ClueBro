/**
 * The harness's own assertions.
 *
 *   npm run check:units
 *
 * What is worth asserting here is the behaviour that will look like a bug to
 * somebody reading the code in a hurry, and the behaviour that is dangerous to
 * get wrong in a live workspace. Both are documented in CLAUDE.md; this file
 * is that documentation in a form that fails.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { alwaysActEngine, alwaysSilentEngine } from "@core/action/mock";
import { scriptedDetector, silentDetector } from "@core/detection/mock";
import {
  ContextEventSchema,
  makeResult,
  type ActionDecision,
  type ActionResult,
  type ContextEvent,
  type Detector,
  type InboundAdapter,
  type Logger,
  type OutboundAdapter,
} from "@contracts";
import { check, checkEqual, report } from "../scripts/expect";
import { createReplayClock, systemClock } from "./clock";
import { loadConfig } from "./config";
import { createDecisionLog } from "./observability";
import { runPipeline } from "./pipeline";
import { WindowStore } from "./window";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// --- helpers ---------------------------------------------------------------

let seq = 0;

/** Built through the schema on purpose: a bad fixture fails here, not later. */
function event(overrides: {
  text: string;
  at: string;
  surface?: string;
  actor?: string;
  isAgent?: boolean;
  id?: string;
}): ContextEvent {
  seq++;
  return ContextEventSchema.parse({
    schema_version: "1.0.0",
    event_id: overrides.id ?? `ev_${String(seq).padStart(3, "0")}`,
    source: {
      adapter: "replay",
      surface_id: overrides.surface ?? "S_TEST",
      surface_type: "group",
      surface_label: "#test",
    },
    actor: {
      actor_id: overrides.actor ?? "U_ANA",
      display_name: overrides.actor ?? "Ana",
      is_agent: overrides.isAgent ?? false,
    },
    occurred_at: overrides.at,
    text: overrides.text,
  });
}

function fixedInbound(events: unknown[]): InboundAdapter {
  return {
    name: "test-inbound",
    async *stream() {
      for (const e of events) yield e as ContextEvent;
    },
  };
}

interface SpyOutbound extends OutboundAdapter {
  calls: ActionDecision[];
}

function spyOutbound(): SpyOutbound {
  const calls: ActionDecision[] = [];
  return {
    name: "test-outbound",
    calls,
    async deliver(decision: ActionDecision): Promise<ActionResult> {
      calls.push(decision);
      return makeResult({ decision, status: "delivered", adapter: "test-outbound" });
    },
  };
}

interface SpyLogger extends Logger {
  lines: { level: string; msg: string }[];
}

function spyLogger(): SpyLogger {
  const lines: { level: string; msg: string }[] = [];
  return {
    lines,
    debug: (m) => void lines.push({ level: "debug", msg: m }),
    info: (m) => void lines.push({ level: "info", msg: m }),
    warn: (m) => void lines.push({ level: "warn", msg: m }),
    error: (m) => void lines.push({ level: "error", msg: m }),
  };
}

async function run(opts: {
  events: unknown[];
  detector?: Detector;
  engine?: typeof alwaysActEngine;
  dryRun?: boolean;
  outbound?: OutboundAdapter;
  log?: Logger;
}) {
  const decisionLog = createDecisionLog({ file: null, pretty: false });
  const clock = createReplayClock();
  await runPipeline({
    inbound: fixedInbound(opts.events),
    outbound: opts.outbound ?? spyOutbound(),
    detector: opts.detector ?? silentDetector,
    actionEngine: opts.engine ?? alwaysSilentEngine(),
    decisionLog,
    log: opts.log ?? spyLogger(),
    clock,
    config: { window: { maxEvents: 12, maxAgeSeconds: 900 }, dryRun: opts.dryRun ?? true },
  });
  return decisionLog.summary();
}

// --- window ----------------------------------------------------------------

console.log("\nwindow: bounded conversation memory");
{
  const store = new WindowStore({ maxEvents: 3, maxAgeSeconds: 900 });
  let window: ContextEvent[] = [];
  for (let i = 0; i < 5; i++) {
    window = store.push(event({ text: `m${i}`, at: `2026-01-01T10:0${i}:00.000Z` }));
  }
  checkEqual("the window never grows past maxEvents", window.length, 3);
  checkEqual("and keeps the most recent, not the first", window[2]?.text, "m4");
}
{
  // Age is measured against the event being processed, not against wall time.
  // On a replay of a conversation from last week those are years apart.
  const store = new WindowStore({ maxEvents: 50, maxAgeSeconds: 300 });
  store.push(event({ text: "old", at: "2026-01-01T10:00:00.000Z" }));
  const window = store.push(event({ text: "now", at: "2026-01-01T10:30:00.000Z" }));
  checkEqual("anything older than maxAgeSeconds is dropped", window.length, 1);
  checkEqual("measured against the event clock, not the wall clock", window[0]?.text, "now");
}
{
  const store = new WindowStore({ maxEvents: 50, maxAgeSeconds: 900 });
  store.push(event({ id: "dup", text: "once", at: "2026-01-01T10:00:00.000Z" }));
  const window = store.push(event({ id: "dup", text: "once", at: "2026-01-01T10:00:00.000Z" }));
  checkEqual("a retried event does not enter the window twice", window.length, 1);
}
{
  const store = new WindowStore({ maxEvents: 50, maxAgeSeconds: 900 });
  store.push(event({ text: "in A", at: "2026-01-01T10:00:00.000Z", surface: "S_A" }));
  const b = store.push(event({ text: "in B", at: "2026-01-01T10:00:10.000Z", surface: "S_B" }));
  checkEqual("two surfaces never bleed into each other", b.length, 1);
  checkEqual("and each keeps its own history", store.get("S_A").length, 1);
}

// --- clock -----------------------------------------------------------------

console.log("\nclock: a replay runs on the conversation's own time");
{
  const clock = createReplayClock();
  clock.advanceTo?.(new Date("2026-01-01T10:00:00.000Z"));
  const first = clock.now().getTime();
  clock.advanceTo?.(new Date("2026-01-01T10:12:00.000Z"));
  const second = clock.now().getTime();
  checkEqual("twelve transcript minutes are twelve minutes to the policy", second - first, 720_000);

  clock.advanceTo?.(new Date("not a date"));
  checkEqual("an unparseable timestamp leaves the clock alone", clock.now().getTime(), second);

  check("the wall clock cannot be moved", systemClock.advanceTo === undefined);
}

// --- config ----------------------------------------------------------------

console.log("\nconfig: one place reads the environment");
{
  const before = { ...process.env };
  process.env["DRY_RUN"] = "false";
  process.env["REPLAY_SPEED"] = "3";
  process.env["POLICY_MIN_CONFIDENCE"] = "0.9";
  process.env["LLM_PROVIDER"] = "anthropic";

  const fromEnv = loadConfig();
  checkEqual("an environment variable beats the default", fromEnv.policy.minConfidence, 0.9);
  checkEqual("and an unknown provider falls back to the fake one", fromEnv.llmProvider, "fake");

  const fromFlags = loadConfig({ dryRun: true, speed: 99 });
  checkEqual("a flag beats the environment variable", fromFlags.replay.speed, 99);
  checkEqual("including the one that keeps a live workspace safe", fromFlags.dryRun, true);

  process.env["POLICY_MIN_CONFIDENCE"] = "not a number";
  checkEqual(
    "a garbled number falls back instead of poisoning the policy with NaN",
    loadConfig().policy.minConfidence,
    0.62,
  );

  delete process.env["DRY_RUN"];
  checkEqual("with nothing set at all, dry run is the default", loadConfig().dryRun, true);

  process.env = before;
}
{
  // CLAUDE.md: every knob goes into config.ts AND .env.example in the same
  // commit, so the other three people can discover it without reading code.
  // Drift here is silent and costs somebody twenty minutes.
  const source = readFileSync(new URL("./config.ts", import.meta.url), "utf8");
  const read = new Set(
    [...source.matchAll(/\b(?:str|num|bool|list)\("([A-Z][A-Z0-9_]*)"/g)].map(
      (m) => m[1] as string,
    ),
  );
  const documentedKeys = readFileSync(`${ROOT}.env.example`, "utf8")
    .split("\n")
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1])
    .filter((k): k is string => Boolean(k));
  const documented = new Set(documentedKeys);
  check(
    "each setting is documented once, so merged defaults cannot override one another",
    documentedKeys.length === documented.size,
  );

  const undocumented = [...read].filter((k) => !documented.has(k)).sort();
  const orphaned = [...documented].filter((k) => !read.has(k)).sort();

  check(
    "every setting config.ts reads is in .env.example",
    undocumented.length === 0,
    `missing from .env.example: ${undocumented.join(", ")}`,
  );
  check(
    "and .env.example promises nothing config.ts ignores",
    orphaned.length === 0,
    `in .env.example but never read: ${orphaned.join(", ")}`,
  );
}

// --- pipeline --------------------------------------------------------------

console.log("\npipeline: a decision for every event, and no accidental sends");
{
  const log = spyLogger();
  const summary = await run({
    events: [
      event({ text: "real", at: "2026-01-01T10:00:00.000Z" }),
      { event_id: "broken", text: "no source, no actor" },
      event({ text: "also real", at: "2026-01-01T10:00:30.000Z" }),
    ],
    log,
  });
  checkEqual("a malformed event is refused and the run carries on", summary.events, 2);
  check(
    "and the error names the adapter that produced it",
    log.lines.some((l) => l.level === "error" && l.msg.includes("test-inbound")),
  );
}
{
  const summary = await run({
    events: [
      event({ text: "a person", at: "2026-01-01T10:00:00.000Z" }),
      event({ text: "the agent itself", at: "2026-01-01T10:00:10.000Z", isAgent: true }),
    ],
  });
  checkEqual("the agent never reacts to itself, which is what stops a loop", summary.events, 1);
}
{
  const log = spyLogger();
  const emptyDetector: Detector = {
    name: "returns-nothing",
    version: "0.0.0",
    async observe() {
      return [];
    },
  };
  const summary = await run({
    events: [event({ text: "anything", at: "2026-01-01T10:00:00.000Z" })],
    detector: emptyDetector,
    log,
  });
  checkEqual("an empty observation array produces no decision", summary.events, 0);
  check(
    "so it is reported as the hidden decision it is",
    log.lines.some((l) => l.level === "warn" && l.msg.includes("hides a decision")),
    "a detector returning [] must be loud: silence has to be a conclusion, not an absence",
  );
}
{
  const summary = await run({
    events: [
      event({ text: "nothing here", at: "2026-01-01T10:00:00.000Z" }),
      event({ text: "nor here", at: "2026-01-01T10:00:20.000Z" }),
    ],
  });
  checkEqual("every silent turn is still a logged decision", summary.events, 2);
  checkEqual("counted as silence", summary.stayedQuiet, 2);
  checkEqual(
    "with a typed reason attached to each",
    Object.values(summary.bySilenceReason).reduce((n, c) => n + c, 0),
    2,
  );
}
{
  // DRY_RUN is enforced twice on purpose. This is the pipeline half; the other
  // half is registry.ts swapping the outbound for a console printer, so a bug
  // in one of them still cannot post to a real channel.
  const detector = scriptedDetector([
    { match: /deploy/, kind: "unanswered_question", confidence: 0.9 },
  ]);
  const events = [event({ text: "did the deploy go out", at: "2026-01-01T10:00:00.000Z" })];

  const dry = spyOutbound();
  const drySummary = await run({
    events,
    detector,
    engine: alwaysActEngine,
    outbound: dry,
    dryRun: true,
  });
  checkEqual("a dry run decides to speak", drySummary.spoke, 1);
  checkEqual("and never touches the outbound adapter", dry.calls.length, 0);

  const live = spyOutbound();
  await run({ events, detector, engine: alwaysActEngine, outbound: live, dryRun: false });
  checkEqual("a live run does deliver", live.calls.length, 1);
}

{
  // A live channel does not stop producing messages because the model returned
  // something the parser hated. Before this guard, one throw anywhere in
  // detect or decide ended the whole session, and it ended it silently.
  const log = spyLogger();
  const decisionLog = createDecisionLog({ file: null, pretty: false });
  const clock = createReplayClock();
  const throwingDetector: Detector = {
    name: "throws-on-the-second",
    version: "0.0.0",
    async observe(w) {
      if (w[w.length - 1]?.text === "poison") throw new Error("the model returned garbage");
      return silentDetector.observe(w, {
        surfaceId: "S_TEST",
        surfaceType: "group",
        triggerEventId: "x",
      });
    },
  };

  await runPipeline({
    inbound: fixedInbound([
      event({ text: "fine", at: "2026-01-01T10:00:00.000Z" }),
      event({ text: "poison", at: "2026-01-01T10:00:10.000Z" }),
      event({ text: "fine again", at: "2026-01-01T10:00:20.000Z" }),
    ]),
    outbound: spyOutbound(),
    detector: throwingDetector,
    actionEngine: alwaysSilentEngine(),
    decisionLog,
    log,
    clock,
    config: { window: { maxEvents: 12, maxAgeSeconds: 900 }, dryRun: true },
  });

  const summary = decisionLog.summary();
  checkEqual("a detector that throws does not end the session", summary.events, 2);
  checkEqual("and the failure is counted, not swallowed", summary.failed, 1);
  check(
    "and the error names the stage and the event",
    log.lines.some((l) => l.level === "error" && l.msg.includes("threw")),
  );
}
{
  // Same for the decide half: an engine that throws, or a delivery that throws
  // instead of returning a failed ActionResult.
  const log = spyLogger();
  const decisionLog = createDecisionLog({ file: null, pretty: false });
  const throwingEngine = {
    name: "throws",
    version: "0.0.0",
    async decide(): Promise<never> {
      throw new Error("policy blew up");
    },
  };

  await runPipeline({
    inbound: fixedInbound([event({ text: "anything", at: "2026-01-01T10:00:00.000Z" })]),
    outbound: spyOutbound(),
    detector: silentDetector,
    actionEngine: throwingEngine,
    decisionLog,
    log,
    clock: createReplayClock(),
    config: { window: { maxEvents: 12, maxAgeSeconds: 900 }, dryRun: true },
  });

  checkEqual("an engine that throws does not end the session", decisionLog.summary().failed, 1);
}

// --- observability ---------------------------------------------------------

console.log("\nobservability: the silences are counted separately");
{
  const detector = scriptedDetector([
    { match: /deploy/, kind: "unanswered_question", confidence: 0.9 },
  ]);
  const summary = await run({
    events: [
      event({ text: "did the deploy go out", at: "2026-01-01T10:00:00.000Z" }),
      event({ text: "small talk", at: "2026-01-01T10:00:20.000Z" }),
    ],
    detector,
    engine: alwaysActEngine,
  });
  checkEqual(
    "speaking is not counted as a silence reason",
    Object.keys(summary.bySilenceReason).length,
    1,
  );
  check(
    "and the speak reason is still in the full breakdown",
    summary.byReason["unanswered_question_timeout"] === 1,
  );
}

report("harness");
