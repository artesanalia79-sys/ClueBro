/**
 * The one mistake in this repo that cannot be undone by a revert.
 *
 *   npm run check:secrets
 *
 * ENTREGA.md tells you to grep for tokens before making the repo public. A
 * checklist item at T+170 is a checklist item nobody runs, so this runs in CI
 * on every push instead, and blocks the commit that would leak rather than
 * finding it after the repo is already public.
 *
 * It scans tracked files only. An untracked .env is exactly where a token is
 * supposed to live.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Shapes, not prefixes. Our own docs say "paste your xoxb- token here", and a
 * looser pattern reports those as leaks and costs somebody ten minutes of
 * panic at the worst possible moment.
 */
const PATTERNS: { name: string; re: RegExp; rotate: string }[] = [
  {
    name: "Slack bot/user token",
    re: /xox[baprs]-\d{6,}-[\w-]{6,}/g,
    rotate: "Slack app settings -> OAuth & Permissions -> Reinstall to workspace",
  },
  {
    name: "Slack app-level token",
    re: /xapp-\d-[A-Z0-9]{6,}-\d{6,}-[\w-]{6,}/g,
    rotate: "Slack app settings -> Basic Information -> App-Level Tokens -> revoke and recreate",
  },
  {
    name: "OpenAI API key",
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    rotate: "platform.openai.com -> API keys -> revoke",
  },
];

/** Its own source obviously contains every pattern it looks for. */
const SELF = "scripts/check-secrets.ts";

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((f) => f !== SELF && !f.startsWith("node_modules/"));

interface Finding {
  file: string;
  line: number;
  name: string;
  rotate: string;
  redacted: string;
}

const findings: Finding[] = [];
let scanned = 0;

for (const file of tracked) {
  const full = join(ROOT, file);
  let content: string;
  try {
    // Skip anything large enough to be a binary or a recording.
    if (statSync(full).size > 2_000_000) continue;
    content = readFileSync(full, "utf8");
  } catch {
    continue;
  }
  if (content.includes("\0")) continue;
  scanned++;

  const lines = content.split("\n");
  for (const { name, re, rotate } of PATTERNS) {
    lines.forEach((line, i) => {
      for (const match of line.matchAll(re)) {
        const hit = match[0];
        findings.push({
          file,
          line: i + 1,
          name,
          rotate,
          // Enough to recognise which token it is, never enough to use it.
          redacted: `${hit.slice(0, 12)}...${hit.slice(-4)}`,
        });
      }
    });
  }
}

// A tracked .env is the same leak arriving by a different route.
if (tracked.includes(".env")) {
  findings.push({
    file: ".env",
    line: 0,
    name: "a tracked .env file",
    rotate: "git rm --cached .env, then rotate every token that was in it",
    redacted: "(whole file)",
  });
}

if (findings.length > 0) {
  console.error(`\nSecret scan FAILED: ${findings.length} credential(s) in tracked files.\n`);
  for (const f of findings) {
    console.error(`  - ${f.file}:${f.line}  ${f.name}  ${f.redacted}`);
    console.error(`      rotate it now: ${f.rotate}\n`);
  }
  console.error(
    "Rotate first, then remove it from the file. Do not try to rewrite history\n" +
      "under time pressure: a rotated token is harmless even if it stays in the log.\n",
  );
  process.exit(1);
}

console.log(`Secret scan OK: ${scanned} tracked files, no credentials.`);
