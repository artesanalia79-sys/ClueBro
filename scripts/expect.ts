/**
 * A 30 line assertion helper, so nobody spends hackathon minutes configuring
 * a test runner.
 *
 * Write `check.ts` in your own folder, import this, and `npm run check:units`
 * picks it up automatically. You never have to touch package.json, which is
 * the file that causes the most merge conflicts on a day like this.
 *
 *   import { check, report } from "../../scripts/expect";
 *
 *   check("silence when nothing is happening", outcome.act === false);
 *   report("core/action policy");
 */

interface Failure {
  label: string;
  detail: string;
}

const failures: Failure[] = [];
let total = 0;

export function check(label: string, condition: boolean, detail = ""): void {
  total++;
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
    failures.push({ label, detail });
  }
}

export function checkEqual<T>(label: string, actual: T, expected: T): void {
  check(label, actual === expected, `expected ${String(expected)}, got ${String(actual)}`);
}

/** Call once at the end. Exits non-zero if anything failed. */
export function report(name: string): void {
  if (failures.length > 0) {
    console.error(`\n${name}: ${failures.length} of ${total} checks FAILED\n`);
    process.exit(1);
  }
  console.log(`\n${name}: ${total} checks passed\n`);
}
