/**
 * Finds every `check.ts` in the repo and runs it.
 *
 *   npm run check:units
 *
 * Each owner adds `check.ts` to their own folder. Nobody edits a shared file
 * to register a test, so nobody conflicts with anybody over it.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SEARCH = ["contracts", "core", "adapters", "harness", "prompts"];

function findChecks(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "extension") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findChecks(full, out);
    else if (entry === "check.ts") out.push(full);
  }
  return out;
}

const checks = SEARCH.flatMap((dir) => {
  try {
    return findChecks(join(ROOT, dir));
  } catch {
    return [];
  }
});

if (checks.length === 0) {
  console.log("no check.ts files yet. Add one in your own folder.");
  process.exit(0);
}

let failed = 0;

for (const file of checks) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  console.log(`\n=== ${rel} ===`);
  const result = spawnSync(process.execPath, ["--import", "tsx", file], {
    stdio: "inherit",
    cwd: ROOT,
  });
  if (result.status !== 0) failed++;
}

if (failed > 0) {
  console.error(`\n${failed} of ${checks.length} check file(s) FAILED\n`);
  process.exit(1);
}
console.log(`\nall ${checks.length} check file(s) passed\n`);
