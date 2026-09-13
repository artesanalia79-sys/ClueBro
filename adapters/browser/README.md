# Meeting memory

ClueBro saves Google Meet captions locally, organizes them into linked Markdown
notes, and retrieves relevant history during the next meeting in the same project.
The existing detector and action engine still run on the recent conversation;
historical retrieval is a separate, source-backed panel feature.

## Run

Requires Node **22.13 or newer** (built-in SQLite) and Chrome/Edge.

1. Run `npm install`.
2. Set `PRINCIPAL_ACTOR_ID=local-user` in `.env`. Keep this value stable: each
   principal has a separate memory directory. Optionally set `MEETING_MEMORY_DIR`.
3. For AI notes and answers, set `LLM_PROVIDER=openai` and configure the existing
   `OPENAI_API_KEY` / `OPENAI_MODEL`. With `fake`, captions, search, history and
   Markdown exports work without a model. Previously saved transcripts can be
   organized after switching to a real provider.
4. Run `npm run dev:meet`.
5. Load `adapters/browser/extension` as an unpacked extension in
   `chrome://extensions` (or reload it if already installed), then reload Meet.
6. Join the call. Only without `OPENAI_TRANSCRIBE_API_KEY`, enable Meet captions too. Saving starts on its own once the
   call is live and the panel says so.
7. Leaving the call closes the session and starts organizing. Captions are already in SQLite; note extraction
   continues in the bridge process. History shows its progress and offers a
   retry if the model fails.
8. Optional, for better transcripts: set `OPENAI_TRANSCRIBE_API_KEY` and click
   the ClueBro toolbar button during the call. See *Call audio* below.

Every meeting goes to the project **general** unless you name another under
**Project & history**. The name is remembered across Meet links, so meetings on
different links still share context. Earlier-meeting context only comes from the
same project: name a separate project to keep unrelated work apart.
Each new session gets a UUID; reusing a meeting URL does not merge its history.
An unfinished session can be restored from History and then resumed or finished.
Reloading a tab restores its session; capture resumes once the call is live again.

The extension queues captions in `chrome.storage.local` before sending them.
Keep the tab open to let queued uploads retry when the bridge is offline. If you
close it, restore that session from History to retry its queue. A crash before a
changing caption stabilizes can still lose that unsent fragment.

## What is stored

```text
meeting-memory/<principal-hash>/
  memory.sqlite                 # canonical transcript, notes and search index
  memory.sqlite-wal             # may exist while the bridge is running
  memory.sqlite-shm
  vault/
    Meeting-<uuid>.md            # dated transcript with source block IDs
    Project-<hash>.md            # linked meeting history
    Person-<hash>.md             # participant history within one project
    Note-<hash>.md               # decision, commitment, question or fact
```

Open the **vault** folder in Obsidian. It contains ordinary Markdown and
`[[wikilinks]]`, including links to the exact transcript blocks behind each note.
The panel downloads a single meeting Markdown file; the linked notes are in the
vault folder. Copy the whole vault to retain all links when sharing or moving it.

Markdown files are generated views, refreshed on finish, retry and export.
SQLite is authoritative: manual changes to generated notes can be overwritten.
Keep personal annotations in separate notes. Two-way Obsidian editing is not
implemented. Back up the complete principal directory with the bridge stopped.
The default directory is excluded from Git; exclude a custom directory yourself.

## Knowledge and retrieval

- Transcript text, original timestamps and speaker labels are saved before the
  caption is acknowledged, independently of whether the agent speaks.
- AI extracts bounded batches. Every note must cite an existing event with an
  exact excerpt; invalid output leaves the batch unprocessed for retry.
- Project and person pages accumulate links to prior meetings. Decision
  occurrences stay separate across meetings so a changed date does not erase
  the old agreement. Names are matched exactly within a project; aliases and
  automatic identity merging are not implemented.
- Captions and organized notes are both indexed with SQLite FTS5, accent-insensitive. It filters by
  project and principal. Queries can be natural-language questions, but retrieval
  is lexical, not embeddings: using the same topic words improves recall.
- With a real model, search results are synthesized into an answer with validated
  source IDs. The original excerpts remain visible. On failure, only excerpts
  are shown. Citation validation does not prove every interpretation is correct.
- Every stored line triggers a lookup in the other meetings of the same project,
  and the answer is pushed to the panel as soon as it exists, through a long
  poll, rather than on a timer. Organized notes are searched first; one whose
  heading covers the latest line is shown directly, without a model call. The
  panel shows at most one short answer at a time. A new answer waits until the current one has been on screen
  for 12 seconds; the same answer is never shown twice, and the source is folded
  under it. When the model finds nothing relevant, nothing is shown.
- Closing commits immediately and starts background organization. Extraction
  checkpoints make retries idempotent and survive restarts. A stopped process
  does not auto-run AI jobs on startup; use **Retry organizing** / **Organize**.

The memory is local to one operator, not a multi-user authorization system. The
bridge binds only to `127.0.0.1`, rejects unrelated web origins, and routes
suggestions by session and principal. Any local process with access to the bridge
or files has that operator's access. The service worker limits requests to the
bridge and accepts messages only from this extension's Meet content scripts.
When AI is enabled, relevant transcript batches and retrieved excerpts are sent
to the configured model provider. Nothing is posted into the meeting. Audio is
recorded only after the toolbar button is clicked, while the badge reads
**REC**, and it is streamed to OpenAI for transcription.

## Call audio

Meet's captions are weak in Spanish and rarely name the speaker. With
`OPENAI_TRANSCRIBE_API_KEY` set (a direct OpenAI key, not the chat provider's),
the bridge accepts audio and transcribes it with `gpt-live-transcribe`.

1. Click the ClueBro toolbar button in the Meet tab. Chrome allows recording a
   tab only from the extension's own button, not from the panel. Click it again
   to stop.
2. The first time, a tab opens to allow the microphone. Until it is allowed,
   only the other participants are transcribed.
3. The tab stays audible. The recorder plays the call back, because Chrome
   silences a tab while it is being recorded.

Two streams are recorded: the tab (other participants, stored as **Others**)
and the microphone (you, stored as **You**). The transcriber returns no speaker
labels, so this is the only attribution available. Use headphones: without
them the microphone also picks up the other participants.

With the key set, Meet captions are never read: the panel asks for the
toolbar button instead, and until it is clicked nothing is transcribed. Meet
captions remain only the fallback for a bridge started without the key. A sentence ends after 700 ms of silence, or after fifteen seconds of
continuous speech, and is stored about a second later.

## Caption limitations

Capture depends on Meet's DOM selectors, which can change. The extension reads
leaf text, waits 1.2 seconds for stability and sends only the new suffix of a
growing caption. It does not capture both a parent and its nested text.
Speech-recognition corrections and remounted DOM nodes may still produce
overlapping fragments. Speaker names require `data-sender-name`; missing labels
are stored as **Unknown speaker**, not guessed. Verify selectors on a real call.

## Local HTTP API

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/meetings` | Start `{room,label,project}`; returns session UUID |
| POST | `/captions` | Persist `{meeting_id,caption_id,text,speaker_name?,occurred_at?}` |
| GET | `/meetings?project=…` | List up to 100 recent sessions and processing status |
| GET | `/meetings/:id` | Session state and caption count |
| POST | `/meetings/:id/finish` | Close and start/retry organization; returns 202 |
| GET | `/meetings/:id/export` | Generate and download the Markdown transcript |
| GET | `/meetings/:id/context` | Matching sources from earlier sessions |
| GET | `/memory/search?project=…&q=…` | Search excerpts and optional AI answer |
| GET | `/suggestions?meeting_id=…&poll=1&wait=1` | Private suggestions and pushed context; with `wait=1` the request is held until one arrives (20 s max) |
| GET | `/suggestions?meeting_id=…` | SSE alternative for local clients |
| WS | `/audio?meeting_id=…&speaker=self\|room` | 24 kHz PCM16 in; finished lines stored as captions |

The bridge's request routing uses the service-worker pattern described in
[Chrome's cross-origin request documentation](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).

## Verify

`npm run ci` includes memory persistence/restart, idempotency, citation rejection,
project/principal isolation, vault link checks, HTTP validation and private routing.
DOM tests cover automatic capture, audio handover, nested captions, incremental subtitles, offline
queues, source rendering, finish controls and worker request restrictions. Tests
use synthetic transcripts and no paid API calls. `npm run replay:meet` still
demonstrates the original core; it does not populate the persistent meeting vault.
