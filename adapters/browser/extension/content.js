/* Captions follow the call: the session opens when you join and closes when
   you leave. Saved locally before upload, announced in a visible panel, and
   stoppable at any time -- known support, not a hidden recorder. */
(() => {
  if (document.getElementById("cluebro-panel")) return;
  const ROOM = location.pathname.replace(/^\//, "") || "unknown-meeting";
  const SESSION_KEY = `cluebro-session:${ROOM}`;
  const SELECTORS = [
    '[jsname="dsyhDe"]',
    '[jsname="tgaKEf"]',
    '[role="region"][aria-label*="caption" i]',
    '[role="region"][aria-label*="subtítulo" i]',
  ];
  // Meet renders icon ligatures, scroll buttons and the speaker's own label
  // inside the caption region. They reach the transcript as if they were
  // speech, and then the extractor treats them as things people said.
  const NOISE =
    /^(arrow_downward|expand_more|keyboard_arrow\w*|more_vert|Ir al final|Jump to bottom|Tú|You)$/i;
  // These exist once you are actually in the call, not in the lobby and not
  // after you leave, which is what makes them the signal for when a meeting
  // starts and ends. The data attributes come first because they do not
  // change with the interface language; the hang-up labels are the fallback
  // for a layout where the tiles are not rendered.
  const IN_CALL = [
    "[data-participant-id]",
    "[data-self-name]",
    "[data-meeting-code]",
    '[aria-label*="Leave call" i]',
    '[aria-label*="Salir de la llamada" i]',
    '[aria-label*="Abandonar la llamada" i]',
    '[aria-label*="Finalizar llamada" i]',
    '[aria-label*="End call" i]',
  ];
  const captionsVisible = () => {
    const container = SELECTORS.map((s) => document.querySelector(s)).find(Boolean);
    return Boolean(container && (container.textContent ?? "").trim().length > 2);
  };
  // Captions only ever render during a call, so text in that region is proof
  // of one no matter what the interface language calls the hang-up button.
  const inCall = () => IN_CALL.some((s) => document.querySelector(s)) || captionsVisible();
  let meeting = null,
    recording = false,
    pending = [],
    stream,
    draining = false,
    working = false;
  let saving = Promise.resolve(),
    drainTask = Promise.resolve(),
    candidates = new Map(),
    lastContext = "",
    lastContextAt = 0,
    wasInCall = false,
    audioActive = false,
    audioAvailable = false,
    lastInsightAt = 0,
    queuedInsight = null,
    shownAnswers = [];
  const panel = document.createElement("aside");
  panel.id = "cluebro-panel";
  panel.setAttribute("aria-label", "ClueBro meeting memory");
  panel.innerHTML = `
    <header><span class="brand"><span class="dot" aria-hidden="true"></span>ClueBro</span><p class="state" role="status" aria-live="polite">Ready</p><button class="collapse" type="button" aria-label="Minimize panel" aria-expanded="true">−</button></header>
    <div class="panel-content">
      <section class="insights" aria-live="polite"><p class="empty">Listening. Context from earlier meetings shows up here.</p></section>
      <details class="more"><summary>Project &amp; history</summary>
        <label class="project-label">Project<input class="project" maxlength="120" placeholder="e.g. Product launch" /></label>
        <p class="hint">Saving follows the call. Use the same project name to connect meetings.</p>
        <button class="refresh" type="button">Refresh meetings</button>
        <div class="meetings"></div>
      </details>
    </div>`;
  document.body.appendChild(panel);
  const el = (selector) => panel.querySelector(selector);
  const status = (text) => {
    el(".state").textContent = text;
  };
  const project = () => el(".project").value.trim();
  try {
    el(".project").value = sessionStorage.getItem(`cluebro-project:${ROOM}`) || ROOM;
  } catch {
    el(".project").value = ROOM;
  }

  // Reloading the extension leaves this page running the previous content
  // script, whose channel to it is already gone. Nothing recovers without a
  // reload, so the panel has to say that rather than repeat the platform's
  // wording, which reads like a crash.
  const STALE = "ClueBro was updated. Reload this tab to keep saving.";
  const TOOLBAR_PROMPT = "Saving · click C in the toolbar to transcribe";
  // Read during a live conversation: few lines, and none replaced before it
  // could be read.
  const MAX_INSIGHTS = 3;
  const HOLD_MS = 12_000;
  async function request(path, body) {
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "cluebro-request",
        path,
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      throw new Error(/context invalidated/i.test(error?.message ?? "") ? STALE : error.message);
    }
    if (!response) throw new Error(STALE);
    if (response.error) throw new Error(response.error);
    if (response.status >= 400) {
      let failure = {};
      try {
        failure = JSON.parse(response.text);
      } catch {}
      throw new Error(failure.error || `Bridge returned ${response.status}`);
    }
    if (path.endsWith("/export")) return response.text;
    return response.text ? JSON.parse(response.text) : null;
  }
  function controls() {
    el(".project").disabled =
      recording || working || pending.length > 0 || Boolean(meeting && !meeting.ended_at);
  }
  function remember() {
    if (meeting) sessionStorage.setItem(SESSION_KEY, JSON.stringify(meeting));
    sessionStorage.setItem(`cluebro-project:${ROOM}`, project());
  }
  function persistQueue() {
    const key = `cluebro-pending:${meeting.id}`,
      snapshot = pending.slice();
    saving = saving.catch(() => {}).then(() => chrome.storage.local.set({ [key]: snapshot }));
    return saving;
  }
  async function drain() {
    if (draining) return drainTask;
    if (!meeting || !pending.length) return;
    draining = true;
    drainTask = (async () => {
      try {
        await saving;
        while (pending.length) {
          await request("/captions", pending[0]);
          pending.shift();
          await persistQueue();
        }
        status(recording ? "Saving" : "All captions saved");
      } catch (error) {
        status(`Pending: ${pending.length} caption(s). ${error.message}. Retrying automatically.`);
      } finally {
        draining = false;
        controls();
      }
    })();
    return drainTask;
  }
  async function enqueue(text, speaker) {
    if (!meeting || !text.trim()) return;
    const at = new Date().toISOString();
    for (let offset = 0; offset < text.trim().length; offset += 8000)
      pending.push({
        meeting_id: meeting.id,
        caption_id: crypto.randomUUID(),
        text: text.trim().slice(offset, offset + 8000),
        speaker_name: speaker,
        speaker_id: speaker,
        occurred_at: at,
        offset_ms: Math.round(performance.now()),
      });
    try {
      await persistQueue();
      void drain();
    } catch (error) {
      status(`Local queue could not be saved: ${error.message}`);
      recording = false;
      controls();
    }
  }
  function flushCandidate(candidate) {
    if (candidate.text === candidate.sent) return;
    const text =
      candidate.sent && candidate.text.startsWith(candidate.sent)
        ? candidate.text.slice(candidate.sent.length).trim()
        : candidate.text;
    candidate.sent = candidate.text;
    if (text) void enqueue(text, candidate.speaker);
  }
  function scan() {
    // Meet's captions are the fallback, never a second source: with OpenAI
    // transcription configured they are worse than the audio, and while the
    // audio is recorded they would store every sentence twice.
    if (!recording || audioActive || audioAvailable) return;
    const container = SELECTORS.map((s) => document.querySelector(s)).find(Boolean),
      now = Date.now();
    if (container) {
      for (const node of container.querySelectorAll("div, span")) {
        if (node.querySelector("div, span") || node.closest("#cluebro-panel")) continue;
        const text = node.textContent?.trim();
        if (!text || text.length < 2 || NOISE.test(text)) continue;
        const speaker = node.closest("[data-sender-name]")?.dataset.senderName || "Unknown speaker";
        if (text === speaker) continue;
        const previous = candidates.get(node);
        if (!previous) candidates.set(node, { text, speaker, changed: now, sent: "" });
        else if (previous.text !== text) {
          previous.text = text;
          previous.speaker = speaker;
          previous.changed = now;
        }
      }
    }
    for (const [node, candidate] of candidates) {
      if (!node.isConnected || now - candidate.changed >= 1200) flushCandidate(candidate);
      if (!node.isConnected) candidates.delete(node);
    }
  }
  // The answer is the whole point; where it came from is one tap away.
  function renderInsight(item) {
    shownAnswers = [item.answer.trim().toLowerCase(), ...shownAnswers].slice(0, 20);
    lastInsightAt = Date.now();
    queuedInsight = null;
    const list = el(".insights");
    list.querySelector(".empty")?.remove();
    const card = document.createElement("article");
    card.className = "insight";
    const answer = document.createElement("p");
    answer.className = "answer";
    answer.textContent = item.answer.trim();
    card.append(answer);
    if (item.quote || item.source) {
      const why = document.createElement("details");
      why.className = "why";
      const summary = document.createElement("summary");
      summary.textContent = "Source";
      why.append(summary);
      if (item.quote) {
        const quote = document.createElement("p");
        quote.className = "quote";
        quote.textContent = item.quote;
        why.append(quote);
      }
      if (item.source) {
        const source = document.createElement("p");
        source.className = "source";
        source.textContent = item.source;
        why.append(source);
      }
      card.append(why);
    }
    list.prepend(card);
    const cards = list.querySelectorAll(".insight");
    for (let i = MAX_INSIGHTS; i < cards.length; i++) cards[i].remove();
  }
  function addInsight(item) {
    const text = (item.answer ?? "").trim();
    if (!text || shownAnswers.includes(text.toLowerCase())) return;
    // A newer line waits instead of pushing away the one someone is reading;
    // only the latest waiting line is kept, since older ones are stale.
    if (Date.now() - lastInsightAt < HOLD_MS) {
      queuedInsight = item;
      return;
    }
    renderInsight(item);
  }
  function showContext(result) {
    // No answer means nothing worth interrupting for. Raw excerpts are not a
    // substitute: they are exactly the wall of text this panel avoids.
    if (!result?.synthesis?.answer) return;
    const cited =
      result.hits.find((hit) => result.synthesis.sources.includes(hit.event_id)) ?? result.hits[0];
    addInsight({
      answer: result.synthesis.answer,
      quote: cited?.text ?? null,
      source: cited
        ? `${cited.speaker} · ${cited.label} · ${new Date(cited.occurred_at).toLocaleString()}`
        : null,
    });
  }
  async function download(id) {
    const markdown = await request(`/meetings/${id}/export`);
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `Meeting-${id}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function history() {
    const rows = await request(`/meetings?project=${encodeURIComponent(project())}`);
    const target = el(".meetings");
    target.replaceChildren();
    if (!rows.length) {
      target.textContent = "No saved meetings in this project yet.";
      return;
    }
    for (const row of rows) {
      const item = document.createElement("article");
      item.className = "memory-hit";
      const title = document.createElement("strong");
      title.textContent = row.label;
      const detail = document.createElement("p");
      detail.className = "source";
      detail.textContent = `${new Date(row.started_at).toLocaleString()} · ${row.event_count} captions · ${row.processing ? "Organizing…" : row.processing_error ? `Organization failed: ${row.processing_error}` : row.ended_at ? (row.extraction_enabled ? `${row.processed_count}/${row.event_count} processed` : "Transcript only") : "Open"}`;
      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.textContent = "Download .md";
      exportButton.onclick = () => void download(row.id).catch((error) => status(error.message));
      const process = document.createElement("button");
      process.type = "button";
      process.textContent = "Organize";
      process.disabled = !row.ended_at || row.processing;
      process.onclick = async () => {
        process.disabled = true;
        status("Organizing saved captions…");
        try {
          await request(`/meetings/${row.id}/finish`, {});
          status("Organizing started. Refresh to check progress.");
          await history();
        } catch (error) {
          status(`Transcript saved. ${error.message}`);
        } finally {
          process.disabled = false;
        }
      };
      item.append(title, detail, exportButton, process);
      target.append(item);
      if (!row.ended_at) {
        const resume = document.createElement("button");
        resume.type = "button";
        resume.textContent = "Restore session";
        resume.disabled = recording || working || pending.length > 0;
        resume.onclick = async () => {
          try {
            meeting = await request(`/meetings/${row.id}`);
            el(".project").value = meeting.project;
            const key = `cluebro-pending:${meeting.id}`;
            pending = (await chrome.storage.local.get(key))[key] || [];
            candidates = new Map();
            remember();
            controls();
            void drain();
            status("Session restored");
          } catch (error) {
            status(error.message);
          }
        };
        item.append(resume);
      }
    }
  }
  function connect() {
    if (stream) clearInterval(stream);
    const id = meeting.id;
    const poll = async () => {
      try {
        const result = await request(`/suggestions?meeting_id=${id}&poll=1`);
        for (const card of result.frames) {
          addInsight({
            answer: card.body,
            quote: null,
            source: (card.sources || []).map((s) => `${s.label} (${s.ref})`).join(" · ") || null,
          });
        }
      } catch {
        /* Keep the panel usable if a frame is malformed. */
      }
    };
    void poll();
    stream = setInterval(poll, 3000);
  }
  async function startSaving(automatic = false) {
    if (!project()) {
      el(".more").open = true;
      el(".project").focus();
      status("Set a project to start saving");
      return;
    }
    working = true;
    controls();
    try {
      if (meeting && !meeting.ended_at) meeting = await request(`/meetings/${meeting.id}`);
      if (!meeting || meeting.ended_at) {
        meeting = await request("/meetings", {
          room: ROOM,
          label: document.title,
          project: project(),
        });
        pending = [];
        candidates = new Map();
        lastContext = "";
      }
      recording = true;
      remember();
      connect();
      // Nobody pressed a button, so the status line is what tells people the
      // call is being saved: support they can see, not a hidden recorder.
      status(audioAvailable ? TOOLBAR_PROMPT : "Saving · turn on Meet captions");
    } catch (error) {
      status(error.message);
    } finally {
      working = false;
      controls();
    }
  }
  async function finishMeeting() {
    if (!meeting || working) return;
    scan();
    working = true;
    recording = false;
    endAudioCapture();
    for (const candidate of candidates.values()) flushCandidate(candidate);
    controls();
    try {
      await saving;
      await drain();
      if (pending.length) throw new Error("Wait for pending captions to upload before finishing.");
      status("Meeting saved · organizing notes");
      meeting = await request(`/meetings/${meeting.id}/finish`, {});
      remember();
      clearInterval(stream);
      status(meeting.extraction_enabled ? "Meeting saved · organizing notes" : "Meeting saved");
      await history();
    } catch (error) {
      if (meeting) {
        try {
          meeting = await request(`/meetings/${meeting.id}`);
          remember();
        } catch {}
      }
      status(`Captions kept · ${error.message}`);
    } finally {
      working = false;
      controls();
    }
  }
  function endAudioCapture() {
    if (!audioActive) return;
    audioActive = false;
    // Nothing may be listening, and a stale content script throws before it
    // returns a promise at all; neither should surface as a page error.
    try {
      void chrome.runtime.sendMessage({ type: "cluebro-capture-end" }).catch(() => {});
    } catch {}
  }
  // Chrome only lets the extension record a tab from its toolbar button, so
  // the background asks this panel which session the audio belongs to.
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "cluebro-capture-begin") {
      void (async () => {
        if (!recording) await startSaving(false);
        if (!recording || !meeting) {
          reply({ error: "Enter a project in the panel, then click the ClueBro button again." });
          return;
        }
        audioActive = true;
        candidates = new Map();
        status("Transcribing the call's audio");
        reply({ meeting_id: meeting.id });
      })();
      return true;
    }
    if (message?.type === "cluebro-capture-status") {
      if (message.state === "stopped") {
        audioActive = false;
        status(audioAvailable ? "Transcription stopped · click C to resume" : "Audio stopped · using Meet captions");
      } else if (message.state === "mic-denied") {
        status("Microphone blocked · only others are transcribed");
      } else if (message.state === "mic-error") {
        status("Microphone unavailable · only others are transcribed");
      } else if (message.state === "error") {
        audioActive = false;
        status(audioAvailable ? `Audio failed · ${message.detail}` : "Audio failed · using Meet captions");
      }
      return false;
    }
    return false;
  });
  el(".refresh").onclick = () => void history().catch((error) => status(error.message));
  el(".more").addEventListener("toggle", () => {
    if (el(".more").open) void history().catch((error) => status(error.message));
  });
  el(".collapse").onclick = () => {
    const hidden = !el(".panel-content").hidden;
    el(".panel-content").hidden = hidden;
    el(".collapse").textContent = hidden ? "+" : "−";
    el(".collapse").setAttribute("aria-expanded", String(!hidden));
    el(".collapse").setAttribute("aria-label", hidden ? "Expand panel" : "Minimize panel");
  };
  // Joining and leaving a call are the real start and end of a meeting.
  // Waiting for someone to remember two buttons loses the transcript of
  // every call where they forget the second one.
  setInterval(() => {
    const now = inCall();
    if (now && !wasInCall) {
      if (!recording && !working) void startSaving(true);
    } else if (!now && wasInCall) {
      if (recording) void finishMeeting();
    }
    wasInCall = now;
  }, 2000);

  // A tab closed mid-call never reaches the watcher above. The background
  // worker outlives this page, so handing the request over there is what
  // makes the transcript survive.
  addEventListener("pagehide", () => {
    endAudioCapture();
    if (!recording || !meeting) return;
    recording = false;
    try {
      chrome.runtime.sendMessage({
        type: "cluebro-request",
        path: `/meetings/${meeting.id}/finish`,
        body: {},
      });
    } catch {}
  });

  // Where text comes from is the bridge's decision, not the page's: ask once.
  void request("/health")
    .then((health) => {
      audioAvailable = Boolean(health?.audio);
      if (!audioAvailable) return;
      el(".hint").textContent =
        "Saving follows the call. Click C in the toolbar once per call to transcribe its audio. Use the same project name to connect meetings.";
      if (recording && !audioActive) status(TOOLBAR_PROMPT);
    })
    .catch(() => {});

  setInterval(scan, 500);
  // Context is only useful while the topic is still on the table. The lookup
  // is a local full-text query and the bridge reuses an answer until the
  // matching excerpts change, so asking often costs little and waiting fifteen
  // seconds made the panel answer after people had moved on.
  const CONTEXT_EVERY_MS = 4000;
  setInterval(() => {
    void drain();
    if (queuedInsight && Date.now() - lastInsightAt >= HOLD_MS) renderInsight(queuedInsight);
    if (!recording || Date.now() - lastContextAt < CONTEXT_EVERY_MS) return;
    lastContextAt = Date.now();
    void request(`/meetings/${meeting.id}/context`)
      .then((result) => {
        const key = result.hits.map((h) => h.event_id).join(",");
        if (key && key !== lastContext) {
          lastContext = key;
          showContext(result);
        }
      })
      .catch(() => {});
    // Ticks faster than the lookup so the lookup really runs on its own
    // cadence; drain() returns at once when nothing is waiting to upload.
  }, 1000);
  void (async () => {
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) {
        meeting = JSON.parse(stored);
        el(".project").value = meeting.project;
        const key = `cluebro-pending:${meeting.id}`;
        pending = (await chrome.storage.local.get(key))[key] || [];
        meeting = await request(`/meetings/${meeting.id}`);
        status(meeting.ended_at ? "Previous meeting saved" : "Session restored");
        void drain();
      }
    } catch (error) {
      status(`Could not restore session: ${error.message}`);
    }
    controls();
  })();
})();
