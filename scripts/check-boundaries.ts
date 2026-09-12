/**
 * The architecture rule, enforced instead of remembered.
 *
 *   npm run check:boundaries
 *
 * Stage 2 only works if the core is genuinely channel-agnostic. "Everybody
 * please remember not to import Slack in core" survives about forty minutes
 * of a hackathon. This does not rely on anyone remembering.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

interface Rule {
  /** Directory the rule applies to, relative to the repo root. */
  dir: string;
  /** Import specifiers that must never appear there. */
  forbidden: { pattern: RegExp; why: string }[];
}

const RULES: Rule[] = [
  {
    dir: "core",
    forbidden: [
      {
        pattern: /@slack\/|['"]bolt|slack_bolt/i,
        why: "the core must not know that Slack exists. Stage 2 replaces Slack with a browser extension and the core must not notice.",
      },
      {
        pattern: /@adapters\/|\.\.\/\.\.\/adapters/,
        why: "the core must not reach into an adapter. It receives ContextEvents and returns Deliveries.",
      },
      {
        pattern: /@harness\/|\.\.\/\.\.\/harness/,
        why: "the core must not depend on orchestration. The harness wires the core, not the other way round.",
      },
      {
        pattern: /['"]openai['"]|@anthropic-ai/,
        why: "the core must not construct a model client. It receives an LlmClient through the CoreDeps port.",
      },
      {
        pattern: /process\.env/,
        why: "only harness/config.ts reads the environment. The core is configured through its arguments.",
      },
    ],
  },
  {
    dir: "adapters",
    forbidden: [
      {
        pattern: /@core\/|\.\.\/\.\.\/core/,
        why: "an adapter must not depend on detection or action. It translates a surface into contracts and back.",
      },
    ],
  },
  {
    dir: "contracts",
    forbidden: [
      {
        pattern: /@core\/|@adapters\/|@harness\/|@slack\/|['"]openai['"]/,
        why: "contracts are the shared vocabulary. They depend on nothing but zod and node builtins.",
      },
    ],
  },
];

const IMPORT_LINE = /^\s*(?:import|export)\b[^;]*?from\s*['"][^'"]+['"]|^\s*(?:const|let)\s+.*=\s*(?:await\s+)?import\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "extension") continue;
      walk(full, out);
    } else if (/\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const violations: string[] = [];
let filesChecked = 0;

for (const rule of RULES) {
  const base = join(ROOT, rule.dir);
  for (const file of walk(base)) {
    filesChecked++;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // Only import statements count. Prose in a comment explaining the rule
      // must not trip the rule.
      if (!IMPORT_LINE.test(line)) return;
      for (const { pattern, why } of rule.forbidden) {
        if (pattern.test(line)) {
          violations.push(
            `${relative(ROOT, file).replace(/\\/g, "/")}:${i + 1}\n      ${line.trim()}\n      why this is forbidden: ${why}`,
          );
        }
      }
    });
  }
}

// process.env is a separate check: it is not an import, so scan whole files.
for (const file of walk(join(ROOT, "core"))) {
  const content = readFileSync(file, "utf8");
  const idx = content.indexOf("process.env");
  if (idx >= 0) {
    const line = content.slice(0, idx).split("\n").length;
    violations.push(
      `${relative(ROOT, file).replace(/\\/g, "/")}:${line}\n      reads process.env directly\n      why this is forbidden: only harness/config.ts reads the environment, so every knob is discoverable in one place.`,
    );
  }
}

if (violations.length > 0) {
  console.error(`\nBoundary check FAILED (${violations.length} violation(s)):\n`);
  for (const v of violations) console.error(`  - ${v}\n`);
  process.exit(1);
}

console.log(`Boundaries OK: ${filesChecked} files, core/ has no idea what Slack is.`);
