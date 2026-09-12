/**
 * End to end smoke test. Runs in CI, needs no network and no keys.
 *
 *   npm run smoke
 *
 * It is not a unit test suite. It answers one question: does a conversation
 * go in one end, come out as decisions at the other, and does the agent still
 * know how to stay quiet? If this is green the skeleton is alive.
 */
import { createActionEngine } from "@core/action/index";
import { alwaysActEngine } from "@core/action/mock";
import { createDetector } from "@core/detection/index";
import { fixtureDetector } from "@core/detection/mock";
import { createConsoleOutbound, createReplayInbound } from "@adapters/replay/index";
import { createPromptRegistry } from "@prompts/loader";
import type { CoreDeps } from "@contracts";
import { createReplayClock } from "../clock";
import { createFakeLlm } from "../llm/fake";
import { createDecisionLog, createLogger } from "../observability";
import { runPipeline } from "../pipeline";

const failures: string[] = [];

const check = (label: string, condition: boolean, detail = ""): void => {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
    failures.push(label);
  }
};

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function replay(transcript: string, useMocks = false) {
  const clock = createReplayClock();
  const deps: CoreDeps = {
    llm: createFakeLlm(),
    prompts: createPromptRegistry(),
    clock,
    log: silentLogger,
  };
  const decisionLog = createDecisionLog({ file: null, pretty: false });

  await runPipeline({
    inbound: createReplayInbound({ path: transcript, speed: 0 }),
    outbound: createConsoleOutbound("smoke"),
    detector: useMocks ? fixtureDetector() : createDetector(deps),
    actionEngine: useMocks ? alwaysActEngine : createActionEngine(deps),
    decisionLog,
    log: silentLogger,
    clock,
    config: { window: { maxEvents: 12, maxAgeSeconds: 900 }, dryRun: true },
  });

  return decisionLog.summary();
}

async function main(): Promise<void> {
  console.log("\nsmoke: the demo conversation");
  const demo = await replay("fixtures/transcripts/demo-main.json");
  console.log(`        ${JSON.stringify(demo)}`);

  check("every event produced a decision", demo.events === 11, `got ${demo.events}`);
  check("the agent spoke at least once", demo.spoke >= 1, `spoke ${demo.spoke}`);
  check("the agent stayed quiet more often than it spoke", demo.stayedQuiet > demo.spoke);
  check(
    "silence is explained by a reason, never by absence",
    demo.stayedQuiet ===
      Object.entries(demo.byReason)
        .filter(([r]) => !r.endsWith("_timeout") && !r.endsWith("_resolvable") && !r.endsWith("_or_date"))
        .reduce((n, [, count]) => n + count, 0),
  );
  check(
    "a low confidence signal is refused",
    demo.byReason["below_confidence_threshold"] !== undefined,
    `reasons: ${Object.keys(demo.byReason).join(", ")}`,
  );
  check(
    "the cooldown keeps the agent from dominating the channel",
    demo.byReason["cooldown_active"] !== undefined,
  );

  // The demo transcript is locked: docs/DEMO.md is a second by second script
  // written against these exact numbers, and the video is cut against them.
  // A change to the transcript should break CI here rather than break a take
  // that nobody discovers is wrong until the edit.
  check(
    "the demo still has the shape docs/DEMO.md was written against",
    demo.spoke === 3,
    `docs/DEMO.md says 3 interventions, got ${demo.spoke}. Re-record or revert the transcript.`,
  );
  check(
    "at least four distinct silence reasons, which is the CP2 bar",
    Object.keys(demo.bySilenceReason).length >= 4,
    `got ${Object.keys(demo.bySilenceReason).join(", ")}`,
  );

  console.log("\nsmoke: a conversation with nothing in it");
  const quiet = await replay("fixtures/transcripts/silence-only.json");
  console.log(`        ${JSON.stringify(quiet)}`);
  check("the agent says nothing at all", quiet.spoke === 0, `spoke ${quiet.spoke}`);
  check("and still explains itself every time", quiet.stayedQuiet === quiet.events);

  console.log("\nsmoke: the same core on a live meeting (stage 2)");
  const meet = await replay("fixtures/transcripts/meet-interview.json");
  console.log(`        ${JSON.stringify(meet)}`);
  check("the core handles a non-Slack surface unchanged", meet.events === 7);
  check("and surfaces something to the person it supports", meet.spoke >= 1, `spoke ${meet.spoke}`);
  check(
    "a meeting is never broadcast, so silence there is still explained",
    meet.stayedQuiet === Object.values(meet.bySilenceReason).reduce((n, c) => n + c, 0),
  );

  console.log("\nsmoke: mocks stand in for the real components");
  const mocked = await replay("fixtures/transcripts/demo-main.json", true);
  console.log(`        ${JSON.stringify(mocked)}`);
  check("a mock detector plus a mock engine still runs end to end", mocked.events === 11);

  if (failures.length > 0) {
    console.error(`\nsmoke FAILED: ${failures.length} check(s)\n`);
    process.exit(1);
  }
  console.log("\nsmoke passed: the skeleton is alive end to end.\n");
}

main().catch((err: unknown) => {
  console.error("\nsmoke crashed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
