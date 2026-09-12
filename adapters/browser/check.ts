import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer } from "node:net";
import { ActionDecisionSchema, ContextEventSchema, type ContextEvent } from "@contracts";
import { MeetingMemory, type ExtractNotes } from "./memory";
import { createBrowserBridge } from "./index";

const root = mkdtempSync(join(tmpdir(), "cluebro-memory-check-"));
const fixture = ContextEventSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../../contracts/fixtures/context-event/meeting-caption.json", import.meta.url),
      "utf8",
    ),
  ),
);
const event = (meeting: string, id: string, text: string): ContextEvent => ({
  ...fixture,
  event_id: `browser:${meeting}:${id}`,
  source: { ...fixture.source, surface_id: meeting },
  text,
});
let calls = 0;
const extract: ExtractNotes = async (events) => {
  calls++;
  return events.map((e) => ({
    kind: "decision",
    title: "Delivery date",
    body: e.text,
    owner: null,
    due: null,
    evidence: [{ event_id: e.event_id, quote: e.text }],
  }));
};
let memory = new MeetingMemory(root, "owner-a", extract);
let other: MeetingMemory | undefined;
let bridge: ReturnType<typeof createBrowserBridge> | undefined;
try {
  const first = memory.start("same-room", "Planning", "Launch");
  const second = memory.start("same-room", "Follow-up", "Launch");
  assert.notEqual(first.id, second.id, "a reused Meet link must not reuse a session");
  const original = event(first.id, "one", "Acordamos entregar el lanzamiento el viernes.");
  assert.equal(memory.append(original), true);
  assert.equal(memory.append(original), false, "retries must not duplicate captions");
  assert.equal(memory.get(first.id).event_count, 1);
  assert.throws(() => memory.append({ ...original, text: "Conflicting retry" }), /conflicts/);
  assert.equal(memory.search("launch", "Candidate").length, 1, "speaker names are searchable");
  assert.equal(memory.search("launch", "lanzamiento").length, 1);
  assert.equal(memory.search("another-project", "lanzamiento").length, 0);
  assert.equal(memory.search("launch", "lanzamiento", first.id).length, 0);
  assert.equal(
    memory.search("launch", '" OR * NOT (').length,
    0,
    "FTS operators are not interpreted as user syntax",
  );
  await memory.close();
  memory = new MeetingMemory(root, "owner-a", extract);
  assert.equal(
    memory.get(first.id).event_count,
    1,
    "captions survive process restart before finishing",
  );
  await Promise.all([memory.finish(first.id), memory.finish(first.id)]);
  const once = calls;
  await memory.finish(first.id);
  assert.equal(calls, once, "organizing again must not reprocess completed chunks");
  assert.throws(() => memory.append(event(first.id, "late", "late caption")), /closed/);
  assert.equal(memory.append(original), false, "already committed retries are safe after close");
  memory.append(event(second.id, "two", "Cambiamos el lanzamiento al martes."));
  await memory.finish(second.id);
  const files = readdirSync(memory.vault);
  assert.equal(
    files.filter((f) => f.startsWith("Note-")).length,
    2,
    "changed decisions retain both occurrences",
  );
  assert.equal(
    files.filter((f) => f.startsWith("Project-")).length,
    1,
    "project entities are reused",
  );
  assert.equal(
    files.filter((f) => f.startsWith("Person-")).length,
    1,
    "people are linked across meetings",
  );
  const markdown = memory.export(first.id);
  assert.match(markdown, /viernes/);
  assert.match(markdown, /\[\[Note-/);
  for (const file of files.filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(memory.vault, file), "utf8");
    for (const match of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
      assert.ok(files.includes(`${match[1]}.md`), `broken vault link: ${match[1]}`);
    }
  }
  other = new MeetingMemory(root, "owner-b");
  assert.equal(
    other.search("launch", "lanzamiento").length,
    0,
    "different principals use isolated databases",
  );
  assert.throws(() => other!.get(first.id), /not found/);
  const plain = other.start("room", "Transcript only", "launch");
  other.append(event(plain.id, "a", "A transcript saved without AI."));
  await other.finish(plain.id);
  assert.equal(
    other.get(plain.id).processed_count,
    0,
    "enabling AI later must still process prior transcripts",
  );
  await other.close();
  other = undefined;

  let bad = true;
  other = new MeetingMemory(root, "invalid-extraction", async (events) => [
    {
      kind: "fact",
      title: "Unverified",
      body: "Something",
      owner: null,
      due: null,
      evidence: [
        { event_id: events[0]!.event_id, quote: bad ? "Invented quote" : events[0]!.text },
      ],
    },
  ]);
  const retry = other.start("room", "Retry", "launch");
  other.append(event(retry.id, "a", "A real quote."));
  await assert.rejects(other.finish(retry.id), /unsupported citation/);
  assert.equal(other.get(retry.id).processed_count, 0);
  assert.match(other.get(retry.id).processing_error!, /unsupported citation/);
  bad = false;
  await other.finish(retry.id);
  assert.equal(other.get(retry.id).processed_count, 1);
  assert.equal(other.get(retry.id).processing_error, null);
  await other.close();
  other = undefined;

  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
  bridge = createBrowserBridge({ port, principalActorId: "owner-a", memory });
  await bridge.inbound.start!();
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, origin?: string) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post("/meetings", { room: "x", label: "x", project: "x" }, "https://evil.example"))
      .status,
    403,
  );
  assert.equal((await post("/meetings", { room: "x" })).status, 400);
  const response = await post("/meetings", {
    room: "room",
    label: "HTTP session",
    project: "launch",
  });
  assert.equal(response.status, 201);
  const session = (await response.json()) as { id: string };
  const caption = {
    meeting_id: session.id,
    caption_id: "same-retry",
    text: "A durable caption through HTTP.",
  };
  assert.equal((await post("/captions", caption)).status, 202);
  assert.equal((await post("/captions", caption)).status, 202);
  assert.equal(memory.get(session.id).event_count, 1);
  assert.equal((await post("/captions", { ...caption, text: 42 })).status, 400);
  const delivery = ActionDecisionSchema.parse(
    JSON.parse(
      readFileSync(
        new URL("../../contracts/fixtures/action-decision/act-dm-actor.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  delivery.delivery!.surface_id = session.id;
  delivery.delivery!.actor_id = "owner-a";
  await fetch(`${base}/suggestions?meeting_id=${session.id}&poll=1`);
  await fetch(`${base}/suggestions?meeting_id=${first.id}&poll=1`);
  assert.equal((await bridge.outbound.deliver(delivery)).status, "delivered");
  const own = (await (
    await fetch(`${base}/suggestions?meeting_id=${session.id}&poll=1`)
  ).json()) as { frames: unknown[] };
  const wrong = (await (
    await fetch(`${base}/suggestions?meeting_id=${first.id}&poll=1`)
  ).json()) as { frames: unknown[] };
  assert.equal(own.frames.length, 1);
  assert.equal(wrong.frames.length, 0, "suggestions must not leak into another meeting");
  delivery.delivery!.visibility = "public";
  assert.equal((await bridge.outbound.deliver(delivery)).status, "failed");
  assert.match(
    await (await fetch(`${base}/meetings/${session.id}/export`)).text(),
    /durable caption/,
  );
  assert.equal((await post(`/meetings/${session.id}/finish`, {})).status, 202);
  console.log(
    "Meeting memory: persistence, citations, retries, isolation, vault links and bridge checks passed.",
  );
} finally {
  if (bridge) await bridge.inbound.stop!();
  else await memory.close();
  await other?.close();
  const resolved = realpathSync(root);
  assert.ok(
    resolved.startsWith(realpathSync(tmpdir()) + sep) && resolved.includes("cluebro-memory-check-"),
  );
  rmSync(resolved, { recursive: true, force: true });
}
