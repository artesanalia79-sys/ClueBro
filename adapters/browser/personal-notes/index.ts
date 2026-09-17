import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { searchTerms } from "../memory";

/**
 * A folder of Markdown files -- the same folder Obsidian can open as a vault,
 * with no plugin and no API -- indexed for full-text search. This is the
 * user's own durable knowledge: unlike meeting memory, it is not scoped to
 * any project, and it is never excluded because it "belongs" to the current
 * meeting, because it never does.
 */

export interface PersonalNoteHit {
  path: string;
  title: string;
  text: string;
  updatedAt: string;
  /** Frontmatter `tags:` plus inline `#hashtags`, lowercased. Free-form: the
   *  user names their own topics, nothing here hardcodes what one looks like. */
  tags: string[];
}

const hashId = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 24);

function* walk(dir: string): Generator<string> {
  let entries: import("node:fs").Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Dotfiles skip .obsidian/, .git/, .trash/ -- vault machinery, not notes.
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (extname(entry.name).toLowerCase() === ".md") yield full;
  }
}

const MAX_CHUNK_CHARS = 4000;

/**
 * Topics come from whatever the user already writes, not a list this file
 * hardcodes: a note's own frontmatter `tags:` (list or flow-array form) plus
 * any inline `#hashtag`, the same syntax Obsidian itself renders as a tag.
 * A heading ("# Title") is not a tag -- it always has a space after the
 * `#`, and a hashtag never does.
 */
function extractTags(rawContent: string): string[] {
  const tags = new Set<string>();
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(rawContent)?.[1] ?? "";
  const flow = /^tags:\s*\[(.*)\]\s*$/m.exec(frontmatter);
  if (flow) {
    for (const raw of flow[1]!.split(","))
      for (const t of raw.trim().replace(/^["']|["']$/g, "").toLocaleLowerCase().split(/\s+/))
        if (t) tags.add(t);
  } else {
    const block = /^tags:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(frontmatter);
    if (block) for (const m of block[1]!.matchAll(/-\s*["']?([^"'\n]+?)["']?\s*$/gm)) tags.add(m[1]!.trim().toLocaleLowerCase());
    else {
      const bare = /^tags:\s*(.+)$/m.exec(frontmatter);
      if (bare) for (const t of bare[1]!.split(",")) if (t.trim()) tags.add(t.trim().toLocaleLowerCase());
    }
  }
  for (const m of rawContent.matchAll(/(?<![\w#])#([\p{L}\p{N}_/-]{2,})/gu)) tags.add(m[1]!.toLocaleLowerCase());
  return [...tags];
}

/**
 * A note's own identity, if it declares one (`id: "..."` in frontmatter, the
 * way exported meetings, decisions and tasks do). Filenames are readable
 * titles now, not ids, so self-exclusion can no longer rely on a path
 * containing a UUID -- it has to compare the identity a file claims for
 * itself, wherever it happens to be named or filed.
 */
function extractId(rawContent: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(rawContent)?.[1] ?? "";
  const match = /^id:\s*(".*")\s*$/m.exec(frontmatter);
  if (!match) return "";
  try {
    return JSON.parse(match[1]!) as string;
  } catch {
    return "";
  }
}

/**
 * Splits a note at its headings, so a search on one topic in a long personal
 * note returns that section, not the whole file. A note with no headings, or
 * text before the first one, becomes one chunk titled after the file.
 */
function chunk(content: string, fileTitle: string): { title: string; text: string }[] {
  // Strips a leading YAML frontmatter block, which is metadata, not content.
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const pieces: { title: string; text: string }[] = [];
  let title = fileTitle;
  let lines: string[] = [];
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) pieces.push({ title, text: text.slice(0, MAX_CHUNK_CHARS) });
    lines = [];
  };
  for (const line of body.split("\n")) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      title = heading[1]!.trim();
    } else {
      lines.push(line);
    }
  }
  flush();
  return pieces;
}

export class PersonalNotesIndex {
  private db: DatabaseSync;
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private root: string,
    dbPath: string,
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    // This index is a rebuildable cache of the Markdown on disk, never the
    // source of truth -- so when an earlier version of this file left behind
    // a `chunks` table missing a column a newer version expects (`tags`,
    // `source_id`), the fix is to drop and let scan() repopulate it, not a
    // hand-written column migration nobody will remember to run twice.
    const existingColumns = new Set(
      (this.db.prepare("PRAGMA table_info(chunks)").all() as { name: string }[]).map((c) => c.name),
    );
    if (existingColumns.size > 0 && (!existingColumns.has("tags") || !existingColumns.has("source_id"))) {
      this.db.exec("DROP TABLE IF EXISTS chunk_search; DROP TABLE IF EXISTS chunks;");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]', source_id TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS chunks_source_id ON chunks(source_id);
      -- Weighted so a query word that is also this note's topic (a tag, or
      -- its own heading) wins over the same word merely appearing in the
      -- body -- the versatile replacement for matching on hardcoded
      -- keywords: any tag the user ever writes gets this boost for free.
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search USING fts5(chunk_id UNINDEXED, title, tags, text, tokenize='unicode61 remove_diacritics 2');
    `);
  }

  /** Reads every Markdown file under the root and (re)indexes it. Returns how many chunks resulted. */
  scan(): number {
    let total = 0;
    for (const file of walk(this.root)) total += this.indexFile(file);
    return total;
  }

  /** Re-derives every chunk for one file from its current contents on disk. */
  indexFile(absolutePath: string): number {
    const rel = relative(this.root, absolutePath);
    this.removeFile(rel);
    let content: string;
    let updatedAt: string;
    try {
      content = readFileSync(absolutePath, "utf8");
      updatedAt = new Date(statSync(absolutePath).mtimeMs).toISOString();
    } catch {
      // Deleted between the watch event firing and this running.
      return 0;
    }
    const pieces = chunk(content, basename(absolutePath, extname(absolutePath)));
    const tags = extractTags(content);
    const tagsJson = JSON.stringify(tags);
    const tagsText = tags.join(" ");
    const sourceId = extractId(content);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      pieces.forEach((piece, i) => {
        const id = hashId(`${rel}#${i}`);
        this.db
          .prepare("INSERT OR REPLACE INTO chunks VALUES(?,?,?,?,?,?,?)")
          .run(id, rel, piece.title, piece.text, tagsJson, sourceId, updatedAt);
        this.db
          .prepare("INSERT INTO chunk_search(chunk_id,title,tags,text) VALUES(?,?,?,?)")
          .run(id, piece.title, tagsText, piece.text);
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return pieces.length;
  }

  /** Drops every chunk for a file, so a delete or a move does not linger in search. */
  removeFile(relativePath: string): void {
    const ids = (this.db.prepare("SELECT id FROM chunks WHERE path=?").all(relativePath) as { id: string }[]).map(
      (r) => r.id,
    );
    if (!ids.length) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) {
        this.db.prepare("DELETE FROM chunk_search WHERE chunk_id=?").run(id);
        this.db.prepare("DELETE FROM chunks WHERE id=?").run(id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * `excludeSourceId` keeps a live meeting from citing its own just-exported
   * markdown: once meetings and personal notes share a vault, a note about
   * the meeting being answered is otherwise a perfect, self-referential
   * match for whatever was just said in it. Matched against the frontmatter
   * `id:` a file declares for itself, not its path or filename -- a
   * readable title like "Kickoff 2026-09-16.md" carries no id of its own.
   */
  search(query: string, excludeSourceId?: string): PersonalNoteHit[] {
    const tokens = searchTerms(query);
    if (!tokens.length) return [];
    const rows = this.db
      .prepare(
        `SELECT c.path, c.title, c.text, c.tags, c.updated_at AS updatedAt
       FROM chunk_search s JOIN chunks c ON c.id = s.chunk_id
       WHERE chunk_search MATCH ? AND (? = '' OR c.source_id <> ?)
       ORDER BY bm25(chunk_search, 5.0, 8.0, 1.0) LIMIT 8`,
      )
      .all(
        tokens.map((w) => `"${w}"`).join(" OR "),
        excludeSourceId ?? "",
        excludeSourceId ?? "",
      ) as { path: string; title: string; text: string; tags: string; updatedAt: string }[];
    return rows.map((row) => ({ ...row, tags: JSON.parse(row.tags) as string[] }));
  }

  /**
   * Watches the vault for edits, new files and deletions, reindexing each.
   * Editors often write a file in more than one step (a temp file, then a
   * rename); a short debounce per path absorbs that instead of indexing a
   * half-written file. Recursive watching is only reliable on macOS and
   * Windows -- if the platform refuses it, live sync is skipped and a manual
   * restart is what picks up new notes, which is worth knowing rather than
   * silently not working.
   */
  watch(onChange?: (relativePath: string) => void): void {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename || extname(filename).toLowerCase() !== ".md") return;
        const key = filename;
        clearTimeout(this.timers.get(key));
        this.timers.set(
          key,
          setTimeout(() => {
            this.timers.delete(key);
            const absolute = join(this.root, filename);
            if (existsSync(absolute)) this.indexFile(absolute);
            else this.removeFile(filename);
            onChange?.(filename);
          }, 400),
        );
      });
    } catch (error) {
      throw new Error(
        `Could not watch ${this.root} for changes (${(error as Error).message}). ` +
          "Edits will not be picked up until the bridge restarts.",
      );
    }
  }

  close(): void {
    this.watcher?.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.db.close();
  }
}
