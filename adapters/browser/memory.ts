import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ContextEventSchema, type ContextEvent } from "@contracts";

export const NoteSchema = z.object({
  kind: z.enum(["decision", "commitment", "question", "fact"]),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(2000),
  owner: z.string().max(160).nullable(),
  due: z.string().max(160).nullable(),
  evidence: z
    .array(z.object({ event_id: z.string(), quote: z.string().min(1).max(4000) }))
    .min(1)
    .max(12),
});
export type MemoryNote = z.infer<typeof NoteSchema>;
export type ExtractNotes = (events: ContextEvent[]) => Promise<MemoryNote[]>;
export interface Meeting {
  id: string;
  room: string;
  label: string;
  project: string;
  started_at: string;
  ended_at: string | null;
  processed_count: number;
  event_count: number;
  extraction_enabled: boolean;
  processing: boolean;
  processing_error: string | null;
}
export interface MemoryHit {
  event_id: string;
  meeting_id: string;
  label: string;
  occurred_at: string;
  speaker: string;
  text: string;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const clean = (s: string) => s.replace(/([\\`*_{}\[\]<>#|])/g, "\\$1").replace(/[\r\n]+/g, " ");
const words = (s: string) => [...new Set(s.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
const STOP = new Set(
  "the and that this what when where with from have was were about does did how para que qué como cómo cuándo donde dónde una los las del con por sobre hemos acordamos dijo reunión meeting".split(
    " ",
  ),
);

/** SQLite is the durable source; Markdown is a portable, regenerable projection. */
export class MeetingMemory {
  private db: DatabaseSync;
  private jobs = new Map<string, Promise<Meeting>>();
  private errors = new Map<string, string>();
  readonly vault: string;

  constructor(
    root: string,
    private owner: string,
    private extract?: ExtractNotes,
  ) {
    const folder = join(root, hash(owner));
    this.vault = join(folder, "vault");
    mkdirSync(this.vault, { recursive: true });
    this.db = new DatabaseSync(join(folder, "memory.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY, room TEXT NOT NULL, label TEXT NOT NULL, project TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT, processed_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id),
        occurred_at TEXT NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_meeting ON events(meeting_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS event_search USING fts5(event_id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id), payload TEXT NOT NULL
      );
    `);
  }

  start(room: string, label: string, project: string): Meeting {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO meetings(id,room,label,project,started_at) VALUES(?,?,?,?,?)")
      .run(id, room, label, project.trim().toLocaleLowerCase(), new Date().toISOString());
    this.export(id);
    return this.get(id);
  }

  get(id: string): Meeting {
    const row = this.db
      .prepare(
        `SELECT m.*, (SELECT count(*) FROM events e WHERE e.meeting_id=m.id) AS event_count FROM meetings m WHERE id=?`,
      )
      .get(id);
    if (!row) throw new Error("Meeting not found");
    return {
      ...row,
      extraction_enabled: Boolean(this.extract),
      processing: this.jobs.has(id),
      processing_error: this.errors.get(id) ?? null,
    } as unknown as Meeting;
  }

  list(project: string): Meeting[] {
    return this.db
      .prepare(
        `SELECT m.*, (SELECT count(*) FROM events e WHERE e.meeting_id=m.id) AS event_count FROM meetings m WHERE project=? ORDER BY started_at DESC LIMIT 100`,
      )
      .all(project.trim().toLocaleLowerCase())
      .map((row) => ({
        ...row,
        extraction_enabled: Boolean(this.extract),
        processing: this.jobs.has(String(row.id)),
        processing_error: this.errors.get(String(row.id)) ?? null,
      })) as unknown as Meeting[];
  }

  events(id: string): ContextEvent[] {
    this.get(id);
    return this.db
      .prepare("SELECT payload FROM events WHERE meeting_id=? ORDER BY occurred_at,rowid")
      .all(id)
      .map((row) => ContextEventSchema.parse(JSON.parse(String(row.payload))));
  }

  append(event: ContextEvent): boolean {
    const meeting = this.get(event.source.surface_id);
    // A retry after closing is successful only if it was already committed.
    const existing = this.db
      .prepare("SELECT text,speaker FROM events WHERE id=?")
      .get(event.event_id);
    if (existing) {
      if (existing.text !== event.text || existing.speaker !== event.actor.display_name)
        throw new Error("Caption ID conflicts with a previously saved caption");
      return false;
    }
    if (meeting.ended_at)
      throw new Error("Meeting is closed. Start a new meeting to capture more captions.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO events VALUES(?,?,?,?,?,?)")
        .run(
          event.event_id,
          meeting.id,
          event.occurred_at,
          event.actor.display_name,
          event.text,
          JSON.stringify(event),
        );
      this.db
        .prepare("INSERT INTO event_search(event_id,text) VALUES(?,?)")
        .run(event.event_id, `${event.actor.display_name}\n${event.text}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  search(project: string, query: string, excludeMeeting = ""): MemoryHit[] {
    const tokens = words(query)
      .filter((w) => !STOP.has(w))
      .slice(0, 16);
    if (!tokens.length) return [];
    const expression = tokens.map((w) => `"${w}"`).join(" OR ");
    return this.db
      .prepare(
        `SELECT e.id AS event_id,e.meeting_id,m.label,e.occurred_at,e.speaker,e.text
      FROM event_search s JOIN events e ON e.id=s.event_id JOIN meetings m ON m.id=e.meeting_id
      WHERE event_search MATCH ? AND m.project=? AND m.id<>?
      ORDER BY bm25(event_search),e.occurred_at DESC LIMIT 8`,
      )
      .all(
        expression,
        project.trim().toLocaleLowerCase(),
        excludeMeeting,
      ) as unknown as MemoryHit[];
  }

  /** Closing is durable before extraction; a failed model call can be retried. */
  finish(id: string): Promise<Meeting> {
    const running = this.jobs.get(id);
    if (running) return running;
    this.get(id);
    this.db
      .prepare("UPDATE meetings SET ended_at=COALESCE(ended_at,?) WHERE id=?")
      .run(new Date().toISOString(), id);
    this.export(id);
    this.errors.delete(id);
    const job = this.process(id)
      .catch((error) => {
        this.errors.set(id, error instanceof Error ? error.message : "Could not organize captions");
        throw error;
      })
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return job;
  }

  private async process(id: string): Promise<Meeting> {
    if (!this.extract) return this.get(id);
    const events = this.events(id);
    let offset = this.get(id).processed_count;
    // Bound model requests by text size, not by the duration of the meeting.
    while (offset < events.length) {
      const batch: ContextEvent[] = [];
      let size = 0;
      for (const event of events.slice(offset)) {
        if (batch.length && size + event.text.length > 14000) break;
        batch.push(event);
        size += event.text.length;
        if (batch.length === 40) break;
      }
      const notes = this.extract ? await this.extract(batch) : [];
      const validated = notes.map((note) => NoteSchema.parse(note));
      for (const note of validated) {
        for (const evidence of note.evidence) {
          const event = batch.find((e) => e.event_id === evidence.event_id);
          if (!event || !event.text.includes(evidence.quote))
            throw new Error(
              "Memory extraction returned an unsupported citation; transcript is safe. Retry processing.",
            );
        }
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const note of validated) {
          // An occurrence stays distinct across meetings. Entity pages connect its history.
          const key = hash(`${id}:${note.kind}:${note.title.toLocaleLowerCase()}`);
          const prior = this.db.prepare("SELECT payload FROM notes WHERE id=?").get(key);
          if (prior) {
            const old = JSON.parse(String(prior.payload)) as MemoryNote;
            note.evidence = [
              ...new Map(
                [...old.evidence, ...note.evidence].map((e) => [`${e.event_id}:${e.quote}`, e]),
              ).values(),
            ];
            note.body = `${old.body}\n\n${note.body}`;
          }
          this.db
            .prepare("INSERT OR REPLACE INTO notes VALUES(?,?,?)")
            .run(key, id, JSON.stringify(note));
        }
        offset += batch.length;
        this.db.prepare("UPDATE meetings SET processed_count=? WHERE id=?").run(offset, id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    this.export(id);
    return this.get(id);
  }

  private write(name: string, content: string) {
    const target = join(this.vault, `${name}.md`);
    writeFileSync(`${target}.tmp`, content, "utf8");
    renameSync(`${target}.tmp`, target);
  }

  export(id: string): string {
    const meeting = this.get(id);
    const events = this.events(id);
    const projectName = `Project-${hash(meeting.project)}`;
    const notes = this.db
      .prepare("SELECT id,payload FROM notes WHERE meeting_id=? ORDER BY id")
      .all(id);
    const people = [...new Set(events.map((e) => e.actor.display_name))];
    const personName = (person: string) => `Person-${hash(`${meeting.project}:${person}`)}`;
    const lines = [
      "---",
      "type: meeting",
      `id: ${JSON.stringify(id)}`,
      `project: ${JSON.stringify(meeting.project)}`,
      `started: ${JSON.stringify(meeting.started_at)}`,
      `ended: ${JSON.stringify(meeting.ended_at)}`,
      "---",
      "",
      `# ${clean(meeting.label)}`,
      "",
      `Project: [[${projectName}|${clean(meeting.project)}]]`,
      "",
      `Participants: ${people.map((p) => `[[${personName(p)}|${clean(p)}]]`).join(", ") || "No captions captured."}`,
      "",
      "## Notes",
      "",
    ];
    for (const row of notes) {
      const note = JSON.parse(String(row.payload)) as MemoryNote;
      const name = `Note-${row.id}`;
      lines.push(`- [[${name}|${clean(note.title)}]]`);
      this.write(
        name,
        [
          "---",
          `type: ${note.kind}`,
          `owner: ${JSON.stringify(note.owner)}`,
          `due: ${JSON.stringify(note.due)}`,
          "---",
          "",
          `# ${clean(note.title)}`,
          "",
          clean(note.body),
          "",
          `Project: [[${projectName}|${clean(meeting.project)}]]`,
          `Meeting: [[Meeting-${id}|${clean(meeting.label)}]]`,
          "",
          "## Evidence",
          "",
          ...note.evidence.map(
            (e) => `- [[Meeting-${id}#^${hash(e.event_id)}|Source]]: ${clean(e.quote)}`,
          ),
          "",
        ].join("\n"),
      );
    }
    if (!notes.length)
      lines.push(
        this.extract
          ? "No extracted notes yet. Finish or retry processing this meeting."
          : "Transcript mode. AI extraction is disabled; original captions remain searchable.",
      );
    lines.push("", "## Transcript", "");
    for (const event of events)
      lines.push(
        `**${event.occurred_at} · ${clean(event.actor.display_name)}**`,
        "",
        `${clean(event.text)} ^${hash(event.event_id)}`,
        "",
      );
    const markdown = lines.join("\n");
    this.write(`Meeting-${id}`, markdown);
    const related = this.list(meeting.project);
    this.write(
      projectName,
      `# ${clean(meeting.project)}\n\n` +
        related.map((m) => `- [[Meeting-${m.id}|${clean(m.label)}]] · ${m.started_at}`).join("\n") +
        "\n",
    );
    for (const person of people) {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT m.id,m.label,m.started_at FROM meetings m JOIN events e ON e.meeting_id=m.id WHERE m.project=? AND e.speaker=? ORDER BY m.started_at DESC`,
        )
        .all(meeting.project, person);
      this.write(
        personName(person),
        `# ${clean(person)}\n\nProject: [[${projectName}|${clean(meeting.project)}]]\n\n` +
          rows
            .map((m) => `- [[Meeting-${m.id}|${clean(String(m.label))}]] · ${m.started_at}`)
            .join("\n") +
          "\n",
      );
    }
    return markdown;
  }

  async close() {
    await Promise.allSettled(this.jobs.values());
    this.db.close();
  }
}
