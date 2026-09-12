/**
 * Every knob in one place, read from the environment once.
 *
 * Nobody else reads process.env. If you need a new setting, add it here and
 * to .env.example in the same commit, so the other three people get it.
 */

export type AdapterChoice = "slack" | "replay" | "browser";
export type LlmChoice = "fake" | "openai";

export interface AppConfig {
  adapter: AdapterChoice;
  llmProvider: LlmChoice;
  openaiApiKey: string;
  openaiModel: string;
  /** Any OpenAI-compatible endpoint. Empty means OpenAI itself. */
  openaiBaseUrl: string;

  slack: {
    botToken: string;
    appToken: string;
    allowedChannels: string[];
  };

  replay: {
    transcriptPath: string;
    /** 1 = original pacing, 6 = six times faster, 0 = no waiting at all. */
    speed: number;
  };

  browser: {
    port: number;
    memoryDir: string;
    /** Who the agent supports in a live meeting. Never broadcast. */
    principalActorId: string | null;
  };

  policy: {
    minConfidence: number;
    minConfidencePublic: number;
    cooldownSeconds: number;
    dedupeSeconds: number;
    secondOpinion: boolean;
  };

  window: {
    maxEvents: number;
    maxAgeSeconds: number;
    minEvents: number;
  };

  dryRun: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  logFile: string;
}

const str = (key: string, fallback = ""): string => process.env[key]?.trim() || fallback;

const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
};

const list = (key: string): string[] =>
  str(key)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export interface ConfigOverrides {
  adapter?: AdapterChoice;
  transcriptPath?: string;
  speed?: number;
  dryRun?: boolean;
  logLevel?: AppConfig["logLevel"];
}

export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const provider = str("LLM_PROVIDER", "fake") === "openai" ? "openai" : "fake";

  return {
    adapter: overrides.adapter ?? "replay",
    llmProvider: provider,
    openaiApiKey: str("OPENAI_API_KEY"),
    openaiModel: str("OPENAI_MODEL", "gpt-4.1-mini"),
    openaiBaseUrl: str("OPENAI_BASE_URL"),

    slack: {
      botToken: str("SLACK_BOT_TOKEN"),
      appToken: str("SLACK_APP_TOKEN"),
      allowedChannels: list("SLACK_ALLOWED_CHANNELS"),
    },

    replay: {
      transcriptPath:
        overrides.transcriptPath ?? str("REPLAY_TRANSCRIPT", "fixtures/transcripts/demo-main.json"),
      speed: overrides.speed ?? num("REPLAY_SPEED", 4),
    },

    browser: {
      port: num("BROWSER_BRIDGE_PORT", 8787),
      memoryDir: str("MEETING_MEMORY_DIR", "meeting-memory"),
      principalActorId: str("PRINCIPAL_ACTOR_ID") || null,
    },

    policy: {
      minConfidence: num("POLICY_MIN_CONFIDENCE", 0.62),
      minConfidencePublic: num("POLICY_MIN_CONFIDENCE_PUBLIC", 0.72),
      cooldownSeconds: num("POLICY_COOLDOWN_SECONDS", 120),
      dedupeSeconds: num("POLICY_DEDUPE_SECONDS", 600),
      secondOpinion: bool("POLICY_SECOND_OPINION", true),
    },

    window: {
      maxEvents: num("WINDOW_MAX_EVENTS", 12),
      maxAgeSeconds: num("WINDOW_MAX_AGE_SECONDS", 900),
      minEvents: num("WINDOW_MIN_EVENTS", 2),
    },

    dryRun: overrides.dryRun ?? bool("DRY_RUN", true),
    logLevel: overrides.logLevel ?? (str("LOG_LEVEL", "info") as AppConfig["logLevel"]),
    logFile: str("LOG_FILE", "logs/decisions.jsonl"),
  };
}

/** Fails fast with a message that says what to do, not what went wrong. */
export function assertUsable(config: AppConfig): void {
  const problems: string[] = [];

  if (config.llmProvider === "openai" && !config.openaiApiKey) {
    problems.push(
      "LLM_PROVIDER=openai but OPENAI_API_KEY is empty. Set it, or use LLM_PROVIDER=fake.",
    );
  }
  if (config.adapter === "slack") {
    if (!config.slack.botToken)
      problems.push("SLACK_BOT_TOKEN is empty. Copy it from the app Install page (xoxb-...).");
    if (!config.slack.appToken)
      problems.push(
        "SLACK_APP_TOKEN is empty. Create an app-level token with connections:write (xapp-...).",
      );
  }
  if (config.adapter === "browser" && !config.browser.principalActorId) {
    problems.push(
      "PRINCIPAL_ACTOR_ID is empty. A live meeting needs to know who the agent is helping.",
    );
  }

  if (problems.length > 0) {
    console.error("\nCannot start:\n");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nSee .env.example for every setting.\n");
    process.exit(1);
  }
}
