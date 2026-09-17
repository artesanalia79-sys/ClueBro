import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer } from "node:net";
import WebSocket from "ws";
import { ActionDecisionSchema, ContextEventSchema, type ContextEvent } from "@contracts";
import { MeetingMemory, type ExtractNotes } from "./memory";
import { PersonalNotesIndex } from "./personal-notes/index";
import { createBrowserBridge } from "./index";

const root = mkdtempSync(join(tmpdir(), "cluebro-memory-check-"));
const personalRoot = mkdtempSync(join(tmpdir(), "cluebro-personal-notes-check-"));
// Deliberately no word shared with any other fixture caption in this file --
// "through" once collided with an unrelated "durable caption through HTTP"
// line elsewhere here and fired an extra, uncounted answer() call.
writeFileSync(
  join(personalRoot, "expenses.md"),
  "## Reimbursement policy\nFile expense reports inside Concur within thirty calendar days of a purchase.",
);
const personalNotes = new PersonalNotesIndex(personalRoot, join(personalRoot, ".index", "personal-notes.sqlite"));
personalNotes.scan();
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
  // "for" is common enough in English notes ("scheduled for Thursday") that
  // treating it as a search term matched almost any note against almost any
  // sentence containing it — a filler line like "thanks for hopping on" once
  // pulled up an unrelated meeting purely on that word.
  memory.append(event(second.id, "for-check", "The launch date is set for the 19th."));
  assert.equal(
    memory.search("launch", "Thanks for hopping on today", first.id).length,
    0,
    "common English function words like \"for\" are not search terms",
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
  const noteHits = memory.searchNotes("launch", "delivery date");
  assert.ok(noteHits.length > 0, "organized notes are searchable, not only raw captions");
  assert.ok(
    memory.searchNotes("launch", "delivery date", first.id).every((hit) => hit.meeting_id !== first.id),
    "the current meeting is left out of note search",
  );
  // Meetings, notes, tasks, people and projects each land in their own
  // topic folder -- meets/, notes/, tasks/, notes/people/, notes/projects/
  // -- instead of a flat dump, so the vault reads the same whether a file
  // came from a meeting export or was written by hand.
  const walkVault = (dir: string, prefix = ""): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walkVault(join(dir, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    );
  // Files are named by title and date now ("Delivery date 2026-09-16.md"),
  // not by a hash or a UUID -- illegible in the file explorer is exactly
  // what this replaces. Classification uses the folder, not a filename
  // prefix, since a title carries no prefix of its own.
  const files = walkVault(memory.vault);
  const inFolder = (prefix: string) => files.filter((f) => f.startsWith(prefix));
  const noteFiles = inFolder("notes/").filter(
    (f) => !f.startsWith("notes/people/") && !f.startsWith("notes/projects/"),
  );
  assert.equal(noteFiles.length, 2, "changed decisions retain both occurrences, filed under notes/");
  assert.ok(
    noteFiles.every((f) => /Delivery date 20\d{2}-\d{2}-\d{2}/.test(f)),
    "a note's filename is its title and the meeting's date, not an id",
  );
  assert.notEqual(
    noteFiles[0],
    noteFiles[1],
    "two decisions with the same title on the same day are disambiguated, not overwritten",
  );
  assert.equal(inFolder("notes/projects/").length, 1, "project entities live under notes/projects/, reused");
  assert.equal(inFolder("notes/people/").length, 1, "people live under notes/people/, linked across meetings");
  assert.ok(inFolder("meets/").length >= 2, "meetings are exported under meets/");
  const markdown = memory.export(first.id);
  assert.match(markdown, /viernes/);
  assert.match(markdown, /\[\[Delivery date/);
  const byName = new Map(files.map((f) => [f.split("/").pop()!, f]));
  for (const file of files.filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(memory.vault, file), "utf8");
    for (const match of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
      // Obsidian resolves a wikilink by filename anywhere in the vault, not
      // by the path it was written from -- so a link is broken only if no
      // file with that name exists at all, regardless of which folder.
      assert.ok(byName.has(`${match[1]}.md`), `broken vault link: ${match[1]}`);
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
  let answered = 0;
  let lastExcerpts: { text: string }[] = [];
  bridge = createBrowserBridge({
    port,
    principalActorId: "owner-a",
    memory,
    personalNotes,
    // Stands in for the vendor: every chunk of audio becomes one finished line.
    transcribe: ({ onLine }) => ({
      append: (chunk) => onLine(`Heard ${chunk.length} bytes of audio.`),
      close: () => {},
    }),
    answer: async (lines, hits) => {
      answered++;
      lastExcerpts = hits;
      const now = lines.at(-1) ?? "";
      if (/reimburse|expense/i.test(now))
        return { answer: "Submit expenses through Concur within 30 days", sources: [hits[0]!.event_id] };
      return {
        answer: /delivery/i.test(now) ? "Delivery is on Friday" : "Earlier: Friday launch",
        sources: [hits[0]!.event_id],
      };
    },
  });
  await bridge.inbound.start!();
  const base = `http://127.0.0.1:${port}`;
  assert.equal(
    ((await (await fetch(`${base}/health`)).json()) as { audio?: boolean }).audio,
    true,
    "the panel is told a transcriber is configured, so it does not read Meet captions",
  );
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
  // The panel polls this while people talk, so it must answer on its own and
  // must not spend a model call per poll on excerpts it already answered.
  assert.equal(
    (
      await post("/captions", {
        meeting_id: session.id,
        caption_id: "context-trigger",
        text: "Volvamos al lanzamiento del viernes.",
      })
    ).status,
    202,
  );
  const contextUrl = `${base}/meetings/${session.id}/context`;
  const context = (await (await fetch(contextUrl)).json()) as {
    hits: unknown[];
    synthesis: { answer: string } | null;
  };
  assert.ok(context.hits.length > 0, "earlier meetings in the project must be found");
  assert.equal(
    context.synthesis?.answer,
    "Earlier: Friday launch",
    "automatic context answers without anyone typing a question",
  );
  assert.equal(answered, 1);
  const repeat = (await (await fetch(contextUrl)).json()) as { synthesis: { answer: string } | null };
  assert.equal(repeat.synthesis?.answer, "Earlier: Friday launch");
  assert.equal(answered, 1, "unchanged excerpts reuse the answer instead of asking again");

  // The answer is pushed the moment a line is stored: a long poll already
  // waiting on the bridge returns with it, instead of the panel asking later.
  await fetch(`${base}/suggestions?meeting_id=${session.id}&poll=1`);
  const waiting = fetch(`${base}/suggestions?meeting_id=${session.id}&poll=1&wait=1`).then(
    (r) => r.json() as Promise<{ frames: { kind?: string; body?: string }[] }>,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const askedAt = Date.now();
  assert.equal(
    (
      await post("/captions", {
        meeting_id: session.id,
        caption_id: "note-trigger",
        text: "What was the delivery date again?",
      })
    ).status,
    202,
  );
  const pushedFrames = await waiting;
  assert.ok(Date.now() - askedAt < 2000, "the answer arrives with the line, not on a later poll");
  assert.equal(
    pushedFrames.frames.find((frame) => frame.kind === "context")?.body,
    "Delivery is on Friday",
    "the pushed answer is about the latest line",
  );
  assert.ok(
    lastExcerpts[0]?.text.startsWith("decision: Delivery date"),
    "organized notes lead the excerpts the answer is drawn from",
  );

  // The latest line is searched first. The line before it shares three words
  // with the Friday note and the question shares one with the Tuesday note, so
  // searched as one blob, Friday would take the first slot.
  for (const [caption_id, text] of [
    ["old-topic", "Entregar el lanzamiento el viernes, entregar el viernes."],
    ["new-topic", "¿Martes?"],
  ])
    assert.equal((await post("/captions", { meeting_id: session.id, caption_id, text })).status, 202);
  const ordered = (await (await fetch(contextUrl)).json()) as { hits: { text: string }[] };
  assert.match(
    ordered.hits[0]?.text ?? "",
    /martes/i,
    "what is asked now leads the excerpts, not the topic of the line before it",
  );

  // Personal notes are never scoped to a project, unlike meeting notes and
  // captions: a session in a project that has never seen this topic before
  // must still find a personal note about it.
  const unrelatedProject = await post("/meetings", {
    room: "other-room",
    label: "Unrelated",
    project: "totally-unrelated",
  });
  const otherSession = (await unrelatedProject.json()) as { id: string };
  assert.equal(
    (
      await post("/captions", {
        meeting_id: otherSession.id,
        caption_id: "expense-question",
        // Plain FTS5 has no stemming, so "expense reports" is chosen to match
        // the note's wording exactly -- "reimbursed" would not match "Reimbursement".
        text: "How do I file expense reports for a client dinner?",
      })
    ).status,
    202,
  );
  const personalContext = (await (
    await fetch(`${base}/meetings/${otherSession.id}/context`)
  ).json()) as { hits: { label: string; text: string }[]; synthesis: { answer: string } | null };
  assert.ok(
    personalContext.hits.some((hit) => hit.label === "Personal notes"),
    "a personal note answers a project that never had a related meeting",
  );
  assert.equal(personalContext.synthesis?.answer, "Submit expenses through Concur within 30 days");

  // Audio from the microphone becomes a caption attributed to the principal,
  // through the same path a typed caption takes.
  const extension = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const before = memory.get(session.id).event_count;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/audio?meeting_id=${session.id}&speaker=self`,
      { origin: extension },
    );
    socket.on("open", () => {
      socket.send(Buffer.alloc(480), { binary: true });
      setTimeout(() => {
        socket.close();
        resolve();
      }, 100);
    });
    socket.on("error", reject);
  });
  assert.equal(memory.get(session.id).event_count, before + 1, "transcribed audio is stored as a caption");
  const heard = memory.events(session.id).at(-1)!;
  assert.equal(heard.text, "Heard 480 bytes of audio.");
  assert.equal(heard.actor.display_name, "You", "the microphone stream is the principal speaking");

  const refused = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/audio?meeting_id=${session.id}`, {
      origin: "https://evil.example",
    });
    socket.on("open", () => resolve(false));
    socket.on("error", () => resolve(true));
  });
  assert.equal(refused, true, "a page that is not the extension cannot stream audio in");

  // With a shared vault, a meeting's own decisions become part of the same
  // "personal notes" search a live meeting reads from -- and the meeting
  // being answered must not be able to cite itself.
  const sharedRoot = mkdtempSync(join(tmpdir(), "cluebro-shared-vault-check-"));
  let sharedMemory: MeetingMemory | undefined;
  let sharedNotes: PersonalNotesIndex | undefined;
  try {
    sharedMemory = new MeetingMemory(root, "owner-shared", extract, sharedRoot);
    sharedNotes = new PersonalNotesIndex(sharedRoot, join(sharedRoot, ".index", "personal-notes.sqlite"));
    const shared = sharedMemory.start("shared-room", "Kickoff", "Merged vault");
    sharedMemory.append(event(shared.id, "one", "We decided to ship on the 30th."));
    await sharedMemory.finish(shared.id);
    sharedNotes.scan();
    const fromOtherMeeting = sharedNotes.search("decided to ship on the 30th");
    assert.ok(
      fromOtherMeeting.some((hit) => hit.path.startsWith(`notes${sep}`)),
      "a meeting's exported decision is searchable as a personal note once the vaults are shared",
    );
    // Excluding by the meeting id keeps its own transcript export out of its
    // own results -- a synthesized decision note derived from it can still
    // surface, since recalling an earlier decision from this same meeting is
    // a legitimate answer, but echoing back the raw line just said is not.
    const selfExcluded = sharedNotes.search("decided to ship on the 30th", shared.id);
    assert.ok(
      selfExcluded.every((hit) => !hit.path.startsWith(`meets${sep}`)),
      "a meeting must not cite its own just-exported transcript",
    );
  } finally {
    await sharedMemory?.close();
    await sharedNotes?.close();
    rmSync(sharedRoot, { recursive: true, force: true });
  }

  assert.equal((await post(`/meetings/${session.id}/finish`, {})).status, 202);
  console.log(
    "Meeting memory: persistence, citations, retries, isolation, vault links, note search, pushed context, personal notes and bridge checks passed.",
  );
} finally {
  // bridge.inbound.stop() already closes personalNotes when a bridge exists;
  // this only covers the case where something threw before it was created.
  if (bridge) await bridge.inbound.stop!();
  else {
    await memory.close();
    await personalNotes.close();
  }
  await other?.close();
  const resolved = realpathSync(root);
  assert.ok(
    resolved.startsWith(realpathSync(tmpdir()) + sep) && resolved.includes("cluebro-memory-check-"),
  );
  rmSync(resolved, { recursive: true, force: true });
  const resolvedPersonal = realpathSync(personalRoot);
  assert.ok(
    resolvedPersonal.startsWith(realpathSync(tmpdir()) + sep) &&
      resolvedPersonal.includes("cluebro-personal-notes-check-"),
  );
  rmSync(resolvedPersonal, { recursive: true, force: true });
}
