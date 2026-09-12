/**
 * Stage 2 surface: a meeting, feeding the same agent core.
 *
 * It does two things and nothing else:
 *   1. posts caption lines to the local bridge as they appear
 *   2. renders whatever the agent decides to surface, with its sources
 *
 * It never speaks in the meeting. The panel is visible to the person using
 * it, always shows where a claim came from, and the agent's presence is
 * known: support, not a hidden prompter.
 *
 * The caption selectors below are the fragile part. Google Meet's DOM is not
 * a public API and it changes. Expect to open DevTools on the day, find the
 * caption container, and add its selector to CAPTION_SELECTORS. That is a
 * ten minute job, not a redesign: everything downstream is unaffected
 * because the bridge only ever receives text.
 */
const BRIDGE = "http://127.0.0.1:8787";

const CAPTION_SELECTORS = [
  '[jsname="dsyhDe"]',
  '[jsname="tgaKEf"]',
  ".a4cQT",
  '[role="region"][aria-label*="aption" i]',
];

const MEETING_ID = location.pathname.replace(/^\//, "") || "unknown-meeting";

/** Who the agent is supporting. Whoever runs the extension is the principal. */
const PRINCIPAL = { id: "U-PRINCIPAL", name: "Me", role: "interviewer" };

let panel;
let seq = 0;
const seen = new Set();

function mountPanel() {
  panel = document.createElement("div");
  panel.id = "cluebro-panel";
  panel.innerHTML =
    '<header><span>ClueBro</span><span class="state">connecting</span></header>' +
    '<div class="cards"><div class="empty">Listening. Nothing worth surfacing yet.</div></div>';
  document.body.appendChild(panel);
}

function setState(text) {
  const el = panel?.querySelector(".state");
  if (el) el.textContent = text;
}

function addCard(suggestion) {
  const cards = panel?.querySelector(".cards");
  if (!cards) return;
  cards.querySelector(".empty")?.remove();

  const card = document.createElement("div");
  card.className = "card";

  const body = document.createElement("p");
  body.className = "body";
  body.textContent = suggestion.body;

  const why = document.createElement("p");
  why.className = "why";
  why.textContent = `${suggestion.reason_code} (${Number(suggestion.confidence).toFixed(2)}) — ${suggestion.rationale}`;

  card.append(body, why);

  if (Array.isArray(suggestion.sources) && suggestion.sources.length > 0) {
    const list = document.createElement("ul");
    list.className = "sources";
    for (const source of suggestion.sources) {
      const item = document.createElement("li");
      item.textContent = `${source.label} (${source.ref})`;
      list.appendChild(item);
    }
    card.appendChild(list);
  }

  cards.prepend(card);
}

function listen() {
  const stream = new EventSource(`${BRIDGE}/suggestions`);
  stream.onopen = () => setState("connected");
  stream.onerror = () => setState("bridge offline");
  stream.onmessage = (event) => {
    try {
      addCard(JSON.parse(event.data));
    } catch {
      /* a malformed frame must not take the panel down mid-meeting */
    }
  };
}

async function sendCaption(text, speakerName) {
  seq += 1;
  try {
    await fetch(`${BRIDGE}/captions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        meeting_id: MEETING_ID,
        meeting_label: document.title,
        caption_id: `cap-${String(seq).padStart(4, "0")}`,
        speaker_id: speakerName === PRINCIPAL.name ? PRINCIPAL.id : `U-${speakerName}`,
        speaker_name: speakerName,
        speaker_role: speakerName === PRINCIPAL.name ? PRINCIPAL.role : "participant",
        text,
        offset_ms: Math.round(performance.now()),
      }),
    });
  } catch {
    setState("bridge offline");
  }
}

function watchCaptions() {
  const observer = new MutationObserver(() => {
    const container = CAPTION_SELECTORS.map((s) => document.querySelector(s)).find(Boolean);
    if (!container) return;

    // Captions rewrite themselves as the speaker talks, so only a line that
    // has stopped changing is worth sending.
    for (const node of container.querySelectorAll("div, span")) {
      const text = node.textContent?.trim();
      if (!text || text.length < 12 || seen.has(text)) continue;
      seen.add(text);
      const speaker = node.closest("[data-sender-name]")?.dataset.senderName || "Participant";
      void sendCaption(text, speaker);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

mountPanel();
listen();
watchCaptions();
