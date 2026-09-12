import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedPrompt, PromptRegistry } from "@contracts";

/**
 * Prompts are versioned files, not string literals in code.
 *
 * Why it matters here: every Observation and every ActionDecision records the
 * prompt id and version that produced it, so when the agent says something
 * embarrassing at minute 90 you can tell which wording did it, and roll back
 * one file instead of arguing about it.
 *
 * Layout:  prompts/<dir>/<slug>.<version>.md
 * Registry: prompts/registry.json picks the active version per id.
 * Override: PROMPT_VERSIONS="detector.conversation_scan=v2,compose.channel_reply=v1"
 *
 * THIS FILE IS SHARED. Treat it as frozen: both cores depend on it.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROMPTS_DIR = join(ROOT, "prompts");

interface RegistryEntry {
  active: string;
  dir: string;
  slug: string;
  description?: string;
}

interface RegistryFile {
  prompts: Record<string, RegistryEntry>;
}

const readRegistry = (): RegistryFile =>
  JSON.parse(readFileSync(join(PROMPTS_DIR, "registry.json"), "utf8")) as RegistryFile;

function parseOverrides(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  return Object.fromEntries(
    raw
      .split(",")
      .map((pair) => pair.split("="))
      .filter((parts): parts is [string, string] => parts.length === 2)
      .map(([id, version]) => [id.trim(), version.trim()]),
  );
}

const fill = (body: string, vars: Record<string, string>): string =>
  body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, key: string) => vars[key] ?? "(not provided)");

export interface PromptRegistryOptions {
  /** Per-id version pins, highest precedence. Used by the eval script. */
  overrides?: Record<string, string>;
}

export function createPromptRegistry(options: PromptRegistryOptions = {}): PromptRegistry {
  const registry = readRegistry();
  const envOverrides = parseOverrides(process.env["PROMPT_VERSIONS"]);
  const overrides = { ...envOverrides, ...options.overrides };
  const cache = new Map<string, LoadedPrompt>();

  const entryOf = (id: string): RegistryEntry => {
    const entry = registry.prompts[id];
    if (!entry) {
      throw new Error(
        `Unknown prompt id "${id}". Add it to prompts/registry.json. Known ids: ${Object.keys(
          registry.prompts,
        ).join(", ")}`,
      );
    }
    return entry;
  };

  const pathFor = (entry: RegistryEntry, version: string): string =>
    join(PROMPTS_DIR, entry.dir, `${entry.slug}.${version}.md`);

  return {
    activeVersion(id) {
      return overrides[id] ?? entryOf(id).active;
    },

    versions(id) {
      const entry = entryOf(id);
      const dir = join(PROMPTS_DIR, entry.dir);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.startsWith(`${entry.slug}.`) && f.endsWith(".md"))
        .map((f) => f.slice(entry.slug.length + 1, -3))
        .sort();
    },

    get(id, version) {
      const entry = entryOf(id);
      const resolved = version ?? overrides[id] ?? entry.active;
      const key = `${id}@${resolved}`;
      const hit = cache.get(key);
      if (hit) return hit;

      const file = pathFor(entry, resolved);
      if (!existsSync(file)) {
        throw new Error(
          `Prompt file missing: ${file}. Available versions for ${id}: ${this.versions(id).join(", ") || "none"}`,
        );
      }
      const body = readFileSync(file, "utf8");
      const prompt: LoadedPrompt = {
        id,
        version: resolved,
        body,
        render: (vars) => fill(body, vars),
      };
      cache.set(key, prompt);
      return prompt;
    },
  };
}

/** Every id the registry knows about. Used by the eval and diff scripts. */
export const allPromptIds = (): string[] => Object.keys(readRegistry().prompts);
