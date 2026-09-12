/**
 * One command to run the agent.
 *
 *   npm run dev                      live Slack, will actually post
 *   npm run dev:dry                  live Slack, decides but never posts
 *   npm run replay:demo              the demo conversation, no Slack at all
 *   npm run replay -- --transcript fixtures/transcripts/silence-only.json
 *
 * Flags beat environment variables, environment variables beat defaults.
 */
import { assertUsable, loadConfig, type AdapterChoice, type AppConfig } from "../config";
import { printSummary } from "../observability";
import { runPipeline } from "../pipeline";
import { buildRuntime } from "../registry";

interface Args {
  adapter: AdapterChoice;
  transcript?: string;
  speed?: number;
  dryRun?: boolean;
  logLevel?: AppConfig["logLevel"];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { adapter: "replay" };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--adapter":
        if (value === "slack" || value === "replay" || value === "browser") args.adapter = value;
        i++;
        break;
      case "--transcript":
        if (value) args.transcript = value;
        i++;
        break;
      case "--speed":
        if (value) args.speed = Number(value);
        i++;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--live":
        args.dryRun = false;
        break;
      case "--debug":
        args.logLevel = "debug";
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "",
            "  --adapter slack|replay|browser   where events come from (default: replay)",
            "  --transcript <path>              replay only, which conversation to play",
            "  --speed <n>                      replay only, 1 = real time, 0 = instant",
            "  --dry-run | --live               decide without sending, or actually send",
            "  --debug                          verbose logs",
            "",
          ].join("\n"),
        );
        process.exit(0);
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const config = loadConfig({
    adapter: args.adapter,
    ...(args.transcript === undefined ? {} : { transcriptPath: args.transcript }),
    ...(args.speed === undefined ? {} : { speed: args.speed }),
    ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
    ...(args.logLevel === undefined ? {} : { logLevel: args.logLevel }),
  });

  assertUsable(config);

  const runtime = await buildRuntime(config);

  if (config.dryRun) {
    runtime.log.warn("DRY RUN: decisions are made and logged, nothing is sent");
  }

  const shutdown = async (): Promise<void> => {
    printSummary(runtime.decisionLog);
    await runtime.inbound.stop?.();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await runPipeline({
    inbound: runtime.inbound,
    outbound: runtime.outbound,
    detector: runtime.detector,
    actionEngine: runtime.actionEngine,
    decisionLog: runtime.decisionLog,
    log: runtime.log,
    clock: runtime.clock,
    config: {
      window: { maxEvents: config.window.maxEvents, maxAgeSeconds: config.window.maxAgeSeconds },
      dryRun: config.dryRun,
    },
  });

  // Only a finite source (replay) reaches this. Slack and the browser bridge
  // run until interrupted.
  printSummary(runtime.decisionLog);
  if (config.logFile) console.log(`  structured log: ${config.logFile}\n`);
}

main().catch((err: unknown) => {
  console.error("\nfatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
