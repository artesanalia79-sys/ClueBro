/**
 * Hackathon clock. Turns the three integration checkpoints into real times so
 * nobody has to do arithmetic under pressure.
 *
 *   npm run clock:start     stamp the start of the three hours
 *   npm run clock           what time is each checkpoint, and how long is left
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FILE = join(ROOT, ".clock");
const TOTAL_MINUTES = 180;

const CHECKPOINTS = [
  { at: 45, name: "CP1 skeleton", goal: "every folder merged, replay runs end to end, nobody is on a mock for their own work" },
  { at: 90, name: "CP2 real Slack", goal: "the agent reads a live channel and posts once, on purpose" },
  { at: 135, name: "CP3 freeze", goal: "demo script locked, video recorded or recording, no new features" },
];

const hhmm = (d: Date): string =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

const command = process.argv[2] ?? "show";

if (command === "start") {
  const now = new Date();
  writeFileSync(FILE, now.toISOString(), "utf8");
  console.log(`\nclock started at ${hhmm(now)}\n`);
}

if (!existsSync(FILE)) {
  console.log("\nno clock yet. run: npm run clock:start\n");
  process.exit(0);
}

const start = new Date(readFileSync(FILE, "utf8").trim());
const elapsed = Math.round((Date.now() - start.getTime()) / 60000);
const remaining = TOTAL_MINUTES - elapsed;

console.log(`\nstarted ${hhmm(start)}   elapsed ${elapsed}m   remaining ${remaining}m\n`);

for (const cp of CHECKPOINTS) {
  const at = new Date(start.getTime() + cp.at * 60000);
  const state = elapsed >= cp.at ? "passed " : `in ${String(cp.at - elapsed).padStart(3)}m`;
  console.log(`  ${hhmm(at)}  ${state}  ${cp.name.padEnd(14)} ${cp.goal}`);
}

const deliverable = new Date(start.getTime() + 150 * 60000);
console.log(`\n  ${hhmm(deliverable)}  the last 30 minutes are for submitting, not for building.`);
console.log(`            title, description, public repo, 2 minute video, social post.\n`);
