/**
 * Compare two eval runs, event by event.
 *
 *   npm run prompt:diff -- prompts/runs/<a>.json prompts/runs/<b>.json
 *
 * Use it before merging a prompt change: if a new wording makes the agent
 * louder, this is where you see it, with the exact messages that flipped.
 */
import { readFileSync } from "node:fs";
import type { EvalRun } from "./eval";

const read = (path: string): EvalRun => JSON.parse(readFileSync(path, "utf8")) as EvalRun;

const [pathA, pathB] = process.argv.slice(2);

if (!pathA || !pathB) {
  console.error(
    "\nusage: npm run prompt:diff -- <run-a.json> <run-b.json>\n" +
      "       produce runs with: npm run prompt:eval -- --version v1\n",
  );
  process.exit(1);
}

const a = read(pathA);
const b = read(pathB);

console.log(`\nA  ${a.prompt_id} @ ${a.prompt_version}  (${a.model})`);
console.log(`B  ${b.prompt_id} @ ${b.prompt_version}  (${b.model})`);
console.log(`   transcript: ${a.transcript}${a.transcript === b.transcript ? "" : ` vs ${b.transcript}`}\n`);

const byId = new Map(b.rows.map((r) => [r.event_id, r]));
let changed = 0;

for (const rowA of a.rows) {
  const rowB = byId.get(rowA.event_id);
  if (!rowB) {
    console.log(`  missing in B  ${rowA.trigger}`);
    changed++;
    continue;
  }
  const kindChanged = rowA.kind !== rowB.kind;
  const confDelta = rowB.confidence - rowA.confidence;
  if (!kindChanged && Math.abs(confDelta) < 0.05) continue;

  changed++;
  console.log(`  ${rowA.trigger}`);
  if (kindChanged) console.log(`      kind        ${rowA.kind}  ->  ${rowB.kind}`);
  console.log(
    `      confidence  ${rowA.confidence.toFixed(2)}  ->  ${rowB.confidence.toFixed(2)}` +
      `  (${confDelta >= 0 ? "+" : ""}${confDelta.toFixed(2)})`,
  );
}

const actionableA = a.rows.filter((r) => r.kind !== "no_signal").length;
const actionableB = b.rows.filter((r) => r.kind !== "no_signal").length;

console.log(`\n  rows compared     ${a.rows.length}`);
console.log(`  rows changed      ${changed}`);
console.log(`  would speak on    A: ${actionableA}   B: ${actionableB}`);
if (actionableB > actionableA) {
  console.log(`  B is LOUDER than A. Make sure that is what you want.`);
} else if (actionableB < actionableA) {
  console.log(`  B is quieter than A.`);
} else {
  console.log(`  same volume.`);
}
console.log("");
