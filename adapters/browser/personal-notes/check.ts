import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PersonalNotesIndex } from "./index";

const root = realpathSync(mkdtempSync(join(tmpdir(), "cluebro-personal-notes-check-")));
let index: PersonalNotesIndex | undefined;

try {
  writeFileSync(
    join(root, "vacation-policy.md"),
    [
      "---",
      "tags: [hr]",
      "---",
      "Some intro text before any heading.",
      "",
      "## Accrual",
      "Employees accrue 1.5 vacation days per month worked.",
      "",
      "## Carryover",
      "Up to 5 unused days carry over into the next year.",
    ].join("\n"),
  );
  mkdirSync(join(root, "sub"));
  writeFileSync(
    join(root, "sub", "clients.md"),
    [
      "---",
      'id: "client-acme"',
      "---",
      "# Acme Corp",
      "Acme's main contact is Priya, on the platform team. Tracked under #acme-project.",
    ].join("\n"),
  );
  writeFileSync(join(root, ".obsidian-config.md"), "should never be indexed");
  mkdirSync(join(root, ".obsidian"));
  writeFileSync(join(root, ".obsidian", "workspace.md"), "should never be indexed either");

  // Nothing here is a keyword this file knows about in advance: one note's
  // topic lives only in its frontmatter tag, an unrelated note mentions the
  // same word only in passing prose, and search must still tell them apart.
  writeFileSync(
    join(root, "onboarding.md"),
    ["---", "tags: [platform]", "---", "# Onboarding", "Checklist for new hires."].join("\n"),
  );
  writeFileSync(
    join(root, "changelog.md"),
    "# Changelog\nMoved the build off the old platform to the new one, among other small fixes.",
  );

  index = new PersonalNotesIndex(root, join(root, ".index", "personal-notes.sqlite"));
  const chunkCount = index.scan();
  assert.equal(
    chunkCount,
    6,
    "intro-before-heading, two headed sections, the nested file, and the two tag-ranking fixtures",
  );

  assert.equal(index.search("xyz-nothing-matches-this").length, 0);

  const accrual = index.search("how many vacation days accrue per month");
  assert.ok(accrual.length > 0, "a heading-scoped chunk is found by its own content");
  assert.equal(accrual[0]!.title, "Accrual");
  assert.doesNotMatch(accrual[0]!.text, /tags: \[hr\]/, "YAML frontmatter is stripped before indexing");
  assert.deepEqual(accrual[0]!.tags, ["hr"], "frontmatter tags are exposed on every chunk of the file");

  const intro = index.search("intro text before any heading");
  assert.equal(intro[0]!.title, "vacation-policy", "text before the first heading is titled after the file");

  const nested = index.search("Acme main contact platform team");
  assert.equal(nested[0]!.path, join("sub", "clients.md"), "files in subfolders are found, with a relative path");
  assert.deepEqual(
    nested[0]!.tags,
    ["acme-project"],
    "an inline #hashtag is a tag, but a '# Heading' with a space after the hash is not",
  );

  assert.equal(index.search("should never be indexed").length, 0, "dotfiles and .obsidian/ are not indexed");

  // Grouping by topic is not a hardcoded keyword match: it is any word the
  // user already tagged outranking the same word merely mentioned in prose.
  const platform = index.search("platform");
  assert.ok(platform.length >= 2, "both the tagged note and the note that only mentions the word are found");
  assert.equal(platform[0]!.title, "Onboarding", "a note tagged with the query term ranks above one that only mentions it");

  // Once meetings export into the same vault as personal notes, a live
  // meeting must not be able to cite its own just-written markdown. The
  // filename is a readable title now, not an id, so exclusion is matched
  // against the frontmatter `id:` a file declares for itself.
  assert.ok(nested.some((hit) => hit.path === join("sub", "clients.md")), "sanity: the query matches the file first");
  const excluded = index.search("Acme main contact platform team", "client-acme");
  assert.ok(
    excluded.every((hit) => hit.path !== join("sub", "clients.md")),
    "a declared frontmatter id can be excluded from its own search results",
  );

  // Editing a file must replace its chunks, not accumulate duplicates or keep stale content.
  // Deliberately no shared vocabulary between the two versions: reusing a word
  // (as an earlier draft of this test did with "vacation days" in both) makes
  // a legitimate hit on the new text look like stale old text lingering.
  writeFileSync(join(root, "vacation-policy.md"), "## Accrual\nUnrelated replacement paragraph about biscuits.");
  index.indexFile(join(root, "vacation-policy.md"));
  assert.equal(index.search("employees accrue worked").length, 0, "the old text is gone");
  assert.ok(index.search("unrelated replacement biscuits").length > 0, "the new text is found");
  assert.equal(
    index.search("unused carry over next year").length,
    0,
    "a heading removed by the edit does not linger as an orphaned chunk",
  );

  // Deleting a file must remove its chunks, not leave them searchable forever.
  unlinkSync(join(root, "sub", "clients.md"));
  index.removeFile(join("sub", "clients.md"));
  assert.equal(index.search("Acme Priya contact").length, 0);

  await index.close();
  index = undefined;

  // A database left over from before `tags` or `source_id` existed must not
  // crash the bridge on startup: this cache is rebuildable, so the fix is to
  // drop and let scan() repopulate it, not a schema nobody migrated.
  const staleRoot = mkdtempSync(join(tmpdir(), "cluebro-personal-notes-stale-"));
  const staleDbPath = join(staleRoot, "personal-notes.sqlite");
  const staleDb = new DatabaseSync(staleDbPath);
  staleDb.exec(
    "CREATE TABLE chunks (id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, updated_at TEXT NOT NULL); " +
      "CREATE VIRTUAL TABLE chunk_search USING fts5(chunk_id UNINDEXED, text);",
  );
  staleDb.close();
  writeFileSync(join(staleRoot, "note.md"), "# Hello\nWorld content here.");
  const migrated = new PersonalNotesIndex(staleRoot, staleDbPath);
  assert.equal(migrated.scan(), 1, "a pre-tags, pre-source_id database is dropped and rebuilt, not left broken");
  assert.ok(migrated.search("world content here").length > 0, "search works immediately after the migration");
  await migrated.close();
  rmSync(staleRoot, { recursive: true, force: true });

  // A watcher picks up a create, an edit, and a delete on its own, without scan() called again.
  const watchedRoot = join(root, "watched");
  mkdirSync(watchedRoot);
  const watching = new PersonalNotesIndex(watchedRoot, join(root, ".index", "watched.sqlite"));
  const changes: string[] = [];
  watching.watch((path) => changes.push(path));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

  writeFileSync(join(watchedRoot, "live.md"), "# Live note\nThis line did not exist at scan time.");
  await settle();
  assert.ok(watching.search("line did not exist at scan time").length > 0, "a newly created file is indexed on its own");

  writeFileSync(join(watchedRoot, "live.md"), "# Live note\nThis line replaced the first one entirely.");
  await settle();
  assert.equal(watching.search("did not exist at scan time").length, 0, "an edit's old content is gone");
  assert.ok(watching.search("replaced the first one entirely").length > 0, "an edit's new content is found");

  unlinkSync(join(watchedRoot, "live.md"));
  await settle();
  assert.equal(watching.search("replaced the first one entirely").length, 0, "a deleted file's content is gone");
  assert.ok(changes.length >= 3, "each create, edit and delete was reported to the caller");

  await watching.close();

  console.log(
    "Personal notes: heading chunking, frontmatter stripping, subfolders, dotfile exclusion, tag extraction and ranking, path exclusion, re-indexing on edit, deletion, and live watching passed.",
  );
} finally {
  if (index) await index.close();
  const resolved = realpathSync(root);
  assert.ok(
    resolved.startsWith(realpathSync(tmpdir()) + sep) && resolved.includes("cluebro-personal-notes-check-"),
  );
  rmSync(resolved, { recursive: true, force: true });
}
