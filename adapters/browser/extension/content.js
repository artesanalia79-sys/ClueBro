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
  // The hang-up button exists only once you are actually in the call, not in
  // the lobby and not after you leave. That makes it the signal for when a
  // meeting starts and ends.
  const LEAVE_BUTTON = [
    '[aria-label*="Leave call" i]',
    '[aria-label*="Salir de la llamada" i]',
    '[aria-label*="Abandonar la llamada" i]',
    '[aria-label*="Finalizar llamada" i]',
    '[aria-label*="End call" i]',
  ];
  const inCall = () => LEAVE_BUTTON.some((s) => document.querySelector(s));
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
    wasInCall = false;
  const panel = document.createElement("aside");
  panel.id = "cluebro-panel";
  panel.setAttribute("aria-label", "ClueBro meeting memory");
  panel.innerHTML = `
    <header><div><span class="eyebrow">MEETING MEMORY</span><strong>ClueBro</strong></div><button class="collapse" type="button" aria-label="Minimize panel" aria-expanded="true">−</button></header>
    <div class="panel-content">
      <p class="state" role="status" aria-live="polite">Ready when you are.</p>
      <label class="project-label">Project<input class="project" maxlength="120" placeholder="e.g. Product launch" /></label>
      <p class="hint">Saving starts when you join the call and stops when you leave. Captions stay on this machine. Use the same project to connect meetings. Turn on Meet captions.</p>
      <div class="actions"><button class="start primary" type="button">Start saving</button><button class="finish" type="button" disabled>Finish & organize</button></div>
      <nav aria-label="Memory views"><button class="view active" data-view="context" type="button">Context</button><button class="view" data-view="history" type="button">History</button></nav>
      <section class="context-view"><form class="search"><label class="sr-only" for="cluebro-query">Search project memory</label><input id="cluebro-query" maxlength="1000" placeholder="What did we agree about delivery?" required /><button type="submit" aria-label="Search memory">↗</button></form><div class="memory-results"><p class="empty">Your previous meetings will appear here as the conversation develops.</p></div><div class="cards"></div></section>
      <section class="history-view" hidden><button class="refresh" type="button">Refresh meetings</button><div class="meetings"></div></section>
      <footer>Local memory · Sources included</footer>
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

  async function request(path, body) {
    const response = await chrome.runtime.sendMessage({
      type: "cluebro-request",
      path,
      ...(body === undefined ? {} : { body }),
    });
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
    el(".start").disabled = working || recording || pending.length > 0;
    el(".start").textContent = meeting && !meeting.ended_at ? "Resume saving" : "Start saving";
    el(".finish").disabled = working || !meeting;
    el(".finish").textContent = meeting?.ended_at ? "Retry organizing" : "Finish & organize";
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
        status(recording ? "Saving captions locally." : "All captured captions saved.");
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
    if (!recording) return;
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
  function showHits(hits, automatic = false, synthesis = null, warning = null) {
    const target = el(".memory-results");
    target.replaceChildren();
    const caption = document.createElement("p");
    caption.className = "result-label";
    caption.textContent = automatic ? "RELATED FROM EARLIER MEETINGS" : "MATCHING SOURCES";
    target.append(caption);
    if (synthesis || warning) {
      const answer = document.createElement("p");
      answer.className = "memory-hit";
      answer.textContent = synthesis ? synthesis.answer : warning;
      target.append(answer);
    }
    if (!hits.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No matching sources in this project. Try a person, topic or decision.";
      target.append(empty);
    }
    for (const hit of hits) {
      const item = document.createElement("article");
      item.className = "memory-hit";
      const quote = document.createElement("p");
      quote.textContent = hit.text;
      const source = document.createElement("p");
      source.className = "source";
      source.textContent = `${hit.speaker} · ${hit.label} · ${new Date(hit.occurred_at).toLocaleString()}`;
      if (synthesis?.sources.includes(hit.event_id))
        source.textContent = `Cited in answer · ${source.textContent}`;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Download source";
      button.onclick = () => void download(hit.meeting_id).catch((error) => status(error.message));
      item.append(quote, source, button);
      target.append(item);
    }
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
      detail.textContent = `${new Date(row.started_at).toLocaleString()} · ${row.event_count} captions · ${row.processing ? "Organizing…" : row.processing_error ? "Organization failed — retry" : row.ended_at ? (row.extraction_enabled ? `${row.processed_count}/${row.event_count} processed` : "Transcript only") : "Open"}`;
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
            status("Session restored. Resume saving or finish organizing.");
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
          const item = document.createElement("article");
          item.className = "card";
          const body = document.createElement("p");
          body.textContent = card.body;
          const source = document.createElement("p");
          source.className = "source";
          source.textContent = (card.sources || []).map((s) => `${s.label} (${s.ref})`).join(" · ");
          item.append(body, source);
          el(".cards").prepend(item);
          while (el(".cards").children.length > 8) el(".cards").lastChild.remove();
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
      if (automatic) return;
      el(".project").focus();
      status("Enter a project to connect your meetings.");
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
      // Say so out loud when nobody pressed the button: the panel being
      // visible is what makes this support rather than a hidden recorder.
      status(
        automatic
          ? "Saving started automatically for this call. Turn on Meet captions."
          : "Saving captions locally. Turn on Meet captions.",
      );
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
    for (const candidate of candidates.values()) flushCandidate(candidate);
    controls();
    try {
      await saving;
      await drain();
      if (pending.length) throw new Error("Wait for pending captions to upload before finishing.");
      status("Transcript saved. Organizing notes…");
      meeting = await request(`/meetings/${meeting.id}/finish`, {});
      remember();
      clearInterval(stream);
      status(
        meeting.extraction_enabled
          ? "Transcript saved. Organizing in the background; check History for progress."
          : "Transcript saved and searchable. AI organization is unavailable.",
      );
      await history();
    } catch (error) {
      if (meeting) {
        try {
          meeting = await request(`/meetings/${meeting.id}`);
          remember();
        } catch {}
      }
      status(`Your captured captions are retained. ${error.message}`);
    } finally {
      working = false;
      controls();
    }
  }
  el(".start").onclick = () => void startSaving(false);
  el(".finish").onclick = () => void finishMeeting();
  el(".search").onsubmit = async (event) => {
    event.preventDefault();
    const button = el(".search button");
    button.disabled = true;
    try {
      const result = await request(
        `/memory/search?project=${encodeURIComponent(project())}&q=${encodeURIComponent(el("#cluebro-query").value)}`,
      );
      showHits(result.hits, false, result.synthesis, result.warning);
    } catch (error) {
      status(error.message);
    } finally {
      button.disabled = false;
    }
  };
  el(".refresh").onclick = () => void history().catch((error) => status(error.message));
  panel.querySelectorAll(".view").forEach(
    (button) =>
      (button.onclick = () => {
        panel.querySelectorAll(".view").forEach((b) => b.classList.toggle("active", b === button));
        el(".context-view").hidden = button.dataset.view !== "context";
        el(".history-view").hidden = button.dataset.view !== "history";
        if (button.dataset.view === "history")
          void history().catch((error) => status(error.message));
      }),
  );
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
    } else if (!now && wasInCall && recording) {
      void finishMeeting();
    }
    wasInCall = now;
  }, 2000);

  // A tab closed mid-call never reaches the watcher above. The background
  // worker outlives this page, so handing the request over there is what
  // makes the transcript survive.
  addEventListener("pagehide", () => {
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

  setInterval(scan, 500);
  setInterval(() => {
    void drain();
    if (!recording || Date.now() - lastContextAt < 15000 || el("#cluebro-query").value) return;
    lastContextAt = Date.now();
    void request(`/meetings/${meeting.id}/context`)
      .then((result) => {
        const key = result.hits.map((h) => h.event_id).join(",");
        if (key && key !== lastContext) {
          lastContext = key;
          showHits(result.hits, true);
        }
      })
      .catch(() => {});
  }, 3000);
  void (async () => {
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) {
        meeting = JSON.parse(stored);
        el(".project").value = meeting.project;
        const key = `cluebro-pending:${meeting.id}`;
        pending = (await chrome.storage.local.get(key))[key] || [];
        meeting = await request(`/meetings/${meeting.id}`);
        status(
          meeting.ended_at
            ? "Previous meeting saved. Start a new session when ready."
            : "Previous session restored. Resume saving when ready.",
        );
        void drain();
      }
    } catch (error) {
      status(`Could not restore session: ${error.message}`);
    }
    controls();
  })();
})();
