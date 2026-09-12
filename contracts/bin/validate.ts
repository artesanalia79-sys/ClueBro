/**
 * Contract validation. This is the CI gate and it is deliberately the only
 * test that must never be allowed to go red.
 *
 *   npm run validate:contracts
 *
 * It checks three things:
 *   1. every fixture under contracts/fixtures/<contract>/ parses
 *   2. every fixture under contracts/fixtures/invalid/ FAILS to parse
 *      (a schema that accepts everything protects nothing)
 *   3. every replay transcript is a list of valid ContextEvents
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodTypeAny } from "zod";
import {
  ActionDecisionSchema,
  ActionResultSchema,
  ContextEventSchema,
  DecisionLogRecordSchema,
  ObservationSchema,
} from "../src/index";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = join(ROOT, "contracts", "fixtures");
const TRANSCRIPTS = join(ROOT, "fixtures", "transcripts");

const SCHEMAS: Record<string, ZodTypeAny> = {
  "context-event": ContextEventSchema,
  observation: ObservationSchema,
  "action-decision": ActionDecisionSchema,
  "action-result": ActionResultSchema,
  "decision-log-record": DecisionLogRecordSchema,
};

let checked = 0;
const failures: string[] = [];

const jsonFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];

const read = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));

// 1. Valid fixtures, grouped by the contract they exercise.
for (const [name, schema] of Object.entries(SCHEMAS)) {
  const dir = join(FIXTURES, name);
  const files = jsonFiles(dir);
  if (files.length === 0) {
    failures.push(`${name}: no fixtures. Every contract needs at least one worked example.`);
    continue;
  }
  for (const file of files) {
    checked++;
    const parsed = schema.safeParse(read(join(dir, file)));
    if (!parsed.success) {
      failures.push(
        `${name}/${file} should be valid but is not:\n    ` +
          parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("\n    "),
      );
    }
  }
}

// 2. Fixtures that must be rejected. Filename prefix picks the schema.
for (const file of jsonFiles(join(FIXTURES, "invalid"))) {
  checked++;
  const key = Object.keys(SCHEMAS)
    .sort((a, b) => b.length - a.length)
    .find((k) => basename(file).startsWith(k));
  if (!key) {
    failures.push(
      `invalid/${file}: name must start with a contract slug, e.g. action-decision-*.json`,
    );
    continue;
  }
  const schema = SCHEMAS[key];
  if (!schema) continue;
  if (schema.safeParse(read(join(FIXTURES, "invalid", file))).success) {
    failures.push(`invalid/${file} was ACCEPTED by ${key}. The schema is too loose.`);
  }
}

// 3. Replay transcripts, which are the demo inputs.
for (const file of jsonFiles(TRANSCRIPTS)) {
  const data = read(join(TRANSCRIPTS, file));
  if (!Array.isArray(data)) {
    failures.push(`transcripts/${file}: expected a JSON array of ContextEvent`);
    continue;
  }
  data.forEach((ev, i) => {
    checked++;
    const parsed = ContextEventSchema.safeParse(ev);
    if (!parsed.success) {
      failures.push(
        `transcripts/${file}[${i}] invalid ContextEvent:\n    ` +
          parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("\n    "),
      );
    }
  });
}

if (failures.length > 0) {
  console.error(`\nContract validation FAILED (${failures.length} problem(s)):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error("");
  process.exit(1);
}

console.log(`Contracts OK: ${checked} payloads validated across ${Object.keys(SCHEMAS).length} contracts.`);
