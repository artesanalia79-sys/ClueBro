import { join } from "node:path";
import { createActionEngine } from "@core/action/index";
import { createDetector } from "@core/detection/index";
import { createConsoleOutbound, createReplayInbound } from "@adapters/replay/index";
import { createPromptRegistry } from "@prompts/loader";
import type {
  ActionEngine,
  Clock,
  CoreDeps,
  Detector,
  InboundAdapter,
  LlmClient,
  Logger,
  OutboundAdapter,
} from "@contracts";
import { createReplayClock, systemClock } from "./clock";
import type { AppConfig } from "./config";
import { createFakeLlm } from "./llm/fake";
import { createDecisionLog, createLogger, type DecisionLog } from "./observability";

/**
 * Composition root. The only file that decides which implementation sits
 * behind each port.
 *
 * This is also where the Slack SDK is loaded, and only when the Slack adapter
 * is actually selected: a broken install must not stop a replay run.
 */

export interface Runtime {
  inbound: InboundAdapter;
  outbound: OutboundAdapter;
  detector: Detector;
  actionEngine: ActionEngine;
  decisionLog: DecisionLog;
  log: Logger;
  clock: Clock;
}

async function buildLlm(config: AppConfig, log: Logger): Promise<LlmClient> {
  if (config.llmProvider === "fake") {
    log.info("llm provider: fake (deterministic, no network)");
    return createFakeLlm();
  }
  // Loaded lazily so the fake path never pays for the vendor SDK.
  const { createOpenAiLlm } = await import("./llm/openai");
  log.info(`llm provider: openai (${config.openaiModel})`, {
    ...(config.openaiBaseUrl ? { base_url: config.openaiBaseUrl } : {}),
  });
  return createOpenAiLlm({
    apiKey: config.openaiApiKey,
    model: config.openaiModel,
    ...(config.openaiBaseUrl ? { baseUrl: config.openaiBaseUrl } : {}),
    log,
  });
}

async function buildAdapters(
  config: AppConfig,
  log: Logger,
  llm: LlmClient,
): Promise<{ inbound: InboundAdapter; outbound: OutboundAdapter }> {
  switch (config.adapter) {
    case "slack": {
      const { createSlackAdapter } = await import("@adapters/slack/index");
      const slack = createSlackAdapter({
        botToken: config.slack.botToken,
        appToken: config.slack.appToken,
        allowedChannels: config.slack.allowedChannels,
        debug: config.logLevel === "debug",
      });
      log.info("adapter: slack (socket mode, passive)", {
        allowed_channels: config.slack.allowedChannels.length || "all invited",
      });
      // In a dry run the console outbound keeps a mistake out of a real
      // channel even if something downstream ignores the flag.
      return {
        inbound: slack.inbound,
        outbound: config.dryRun ? createConsoleOutbound("slack-dry-run") : slack.outbound,
      };
    }

    case "browser": {
      const { createBrowserBridge } = await import("@adapters/browser/index");
      const { MeetingMemory, principalHash } = await import("@adapters/browser/memory");
      const { createMeetingExtractor, createMeetingAnswerer } = await import("./meeting-memory");
      const principalId = config.browser.principalActorId ?? "principal";

      let personalNotes: import("@adapters/browser/personal-notes/index").PersonalNotesIndex | undefined;
      if (config.browser.personalNotesDir) {
        const { PersonalNotesIndex } = await import("@adapters/browser/personal-notes/index");
        personalNotes = new PersonalNotesIndex(
          config.browser.personalNotesDir,
          join(config.browser.memoryDir, principalHash(principalId), "personal-notes.sqlite"),
        );
        const chunks = personalNotes.scan();
        log.info(`personal notes: indexed ${chunks} chunk(s)`, { dir: config.browser.personalNotesDir });
        try {
          personalNotes.watch((path) => log.info(`personal notes: reindexed ${path}`));
        } catch (error) {
          log.warn((error as Error).message);
        }
      }

      const bridge = createBrowserBridge({
        port: config.browser.port,
        principalActorId: principalId,
        // With a personal notes folder configured, meetings, decisions and
        // tasks export straight into it -- as meets/, notes/ and tasks/ --
        // instead of a private vault nothing else ever searches. Without
        // one, the layout is exactly what it was before this existed.
        memory: new MeetingMemory(
          config.browser.memoryDir,
          principalId,
          createMeetingExtractor(llm),
          config.browser.personalNotesDir || undefined,
        ),
        ...(personalNotes ? { personalNotes } : {}),
        // The meeting language, not the language of whichever note or loanword
        // the model happens to read first.
        answer: createMeetingAnswerer(llm, {
          language: config.browser.transcription.languages[0] ?? "es",
        }),
        ...(config.browser.transcription.apiKey
          ? {
              transcribe: (await import("./stt/openai-realtime")).createOpenAiTranscription(
                config.browser.transcription,
              ),
            }
          : {}),
      });
      log.info("adapter: browser bridge (stage 2)", {
        port: config.browser.port,
        audio: config.browser.transcription.apiKey
          ? `${config.browser.transcription.model} (${config.browser.transcription.languages.join(",")})`
          : "off, using Meet captions",
        personal_notes: config.browser.personalNotesDir || "off",
      });
      return {
        inbound: bridge.inbound,
        outbound: config.dryRun ? createConsoleOutbound("browser-dry-run") : bridge.outbound,
      };
    }

    case "replay":
    default: {
      log.info("adapter: replay", {
        transcript: config.replay.transcriptPath,
        speed: config.replay.speed,
      });
      return {
        inbound: createReplayInbound({
          path: config.replay.transcriptPath,
          speed: config.replay.speed,
        }),
        outbound: createConsoleOutbound("replay"),
      };
    }
  }
}

export async function buildRuntime(config: AppConfig): Promise<Runtime> {
  const log = createLogger(config.logLevel);
  const llm = await buildLlm(config, log);
  const prompts = createPromptRegistry();

  // A replay runs on the conversation's own clock so that time-based policy
  // is reproducible. Everything else runs on the wall clock.
  const clock: Clock = config.adapter === "replay" ? createReplayClock() : systemClock;

  const coreDeps: CoreDeps = { llm, prompts, clock, log };

  const detector = createDetector(coreDeps, {
    minWindowEvents: config.window.minEvents,
    skipModelWhenNoHeuristicHit: true,
    maxEventsInPrompt: config.window.maxEvents,
  });

  const actionEngine = createActionEngine(coreDeps, {
    secondOpinion: config.policy.secondOpinion,
    policy: {
      minConfidence: config.policy.minConfidence,
      minConfidencePublic: config.policy.minConfidencePublic,
      cooldownSeconds: config.policy.cooldownSeconds,
      dedupeSeconds: config.policy.dedupeSeconds,
      allowedSurfaceIds: config.adapter === "slack" ? config.slack.allowedChannels : [],
      principalActorId: config.browser.principalActorId,
      principalRoles: ["principal", "host", "interviewer", "operator"],
    },
  });

  const { inbound, outbound } = await buildAdapters(config, log, llm);

  return {
    inbound,
    outbound,
    detector,
    actionEngine,
    decisionLog: createDecisionLog({
      file: config.logFile || null,
      pretty: true,
      verbose: config.logLevel === "debug",
    }),
    log,
    clock,
  };
}
