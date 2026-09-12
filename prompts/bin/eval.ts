/**
 * Run one prompt version against a saved conversation and record what it
 * decided, so the team iterates on the agent's judgement with evidence
 * instead of opinions.
 *
 *   npm run prompt:eval -- --version v1
 *   npm run prompt:eval -- --version v2 --transcript fixtures/transcripts/silence-only.json
 *   npm run prompt:diff -- prompts/runs/<a>.json prompts/runs/<b>.json
 *
 * Writes prompts/runs/<prompt>__<version>__<transcript>.json. Runs are
 * gitignored: they are evidence for a decision, not part of the product.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createDetector } from "@core/detection/index";
import { loadTranscript } from "@adapters/replay/index";
import type { ContextEvent, CoreDeps } from "@contracts";
import { createReplayClock } from "../../harness/clock";
import { createFakeLlm } from "../../harness/llm/fake";
import { createPromptRegistry } from "../loader";

interface Row {
  event_id: string;
  trigger: string;
  kind: string;
  confidence: number;
  summary: string;
  subject_actor_id: string | null;
  evidence_count: number;
}

export interface EvalRun {
  prompt_id: string;
  prompt_version: string;
  transcript: string;
  provider: string;
  model: string;
  ran_at: string;
  rows: Row[];
  totals: Record<string, number>;
}

function parseArgs(argv: string[]): { promptId: string; version?: string; transcript: string } {
  let promptId = "detector.conversation_scan";
  let version: string | undefined;
  let transcript = "fixtures/transcripts/demo-main.json";

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--prompt" && value) promptId = value;
    if (argv[i] === "--version" && value) version = value;
    if (argv[i] === "--transcript" && value) transcript = value;
  }
  return { promptId, ...(version ? { version } : {}), transcript };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const useOpenAi = process.env["LLM_PROVIDER"] === "openai";
  const llm = useOpenAi
    ? (await import("../../harness/llm/openai")).createOpenAiLlm({
        apiKey: process.env["OPENAI_API_KEY"] ?? "",
        model: process.env["OPENAI_MODEL"] ?? "gpt-4.1-mini",
      })
    : createFakeLlm();

  if (!useOpenAi) {
    console.log(
      "\nnote: LLM_PROVIDER is not openai, so this measures the fake provider.\n" +
        "      Set LLM_PROVIDER=openai to evaluate the prompt itself.\n",
    );
  }

  const clock = createReplayClock();
  const prompts = createPromptRegistry(
    args.version ? { overrides: { [args.promptId]: args.version } } : {},
  );
  const resolvedVersion = prompts.activeVersion(args.promptId);

  const deps: CoreDeps = {
    llm,
    prompts,
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
  const detector = createDetector(deps);

  const events = loadTranscript(args.transcript);
  const rows: Row[] = [];
  const window: ContextEvent[] = [];

  for (const event of events) {
    window.push(event);
    clock.advanceTo?.(new Date(event.occurred_at));
    const observations = await detector.observe(window.slice(-12), {
      surfaceId: event.source.surface_id,
      surfaceType: event.source.surface_type,
      triggerEventId: event.event_id,
    });
    for (const obs of observations) {
      rows.push({
        event_id: event.event_id,
        trigger: `${event.actor.display_name}: ${event.text}`.slice(0, 80),
        kind: obs.kind,
        confidence: Number(obs.confidence.toFixed(3)),
        summary: obs.summary,
        subject_actor_id: obs.subject_actor_id,
        evidence_count: obs.evidence.length,
      });
    }
  }

  const totals = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.kind] = (acc[r.kind] ?? 0) + 1;
    return acc;
  }, {});

  const run: EvalRun = {
    prompt_id: args.promptId,
    prompt_version: resolvedVersion,
    transcript: args.transcript,
    provider: llm.name,
    model: llm.model,
    ran_at: new Date().toISOString(),
    rows,
    totals,
  };

  const outDir = join(process.cwd(), "prompts", "runs");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(
    outDir,
    `${args.promptId}__${resolvedVersion}__${basename(args.transcript, ".json")}.json`,
  );
  writeFileSync(outFile, `${JSON.stringify(run, null, 2)}\n`, "utf8");

  console.log(`${args.promptId} @ ${resolvedVersion}  on  ${args.transcript}  via ${llm.model}\n`);
  for (const row of rows) {
    console.log(
      `  ${row.kind.padEnd(20)} ${row.confidence.toFixed(2)}  ${row.trigger}`,
    );
  }
  console.log(`\n  totals: ${JSON.stringify(totals)}`);
  console.log(`  saved:  ${outFile}\n`);
}

main().catch((err: unknown) => {
  console.error("eval failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
