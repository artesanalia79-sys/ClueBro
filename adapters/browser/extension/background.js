// Host permissions apply to service-worker fetches, not Meet content scripts.
const OFFSCREEN = "offscreen.html";

const fromMeetTab = (sender) =>
  sender.id === chrome.runtime.id && Boolean(sender.tab?.url?.startsWith("https://meet.google.com/"));
const fromOwnPage = (sender, page) =>
  sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(page);

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  switch (message?.type) {
    case "cluebro-request":
      return relay(message, sender, reply);
    case "cluebro-capture-end":
      if (fromMeetTab(sender)) void stopCapture();
      return false;
    case "cluebro-offscreen-status":
      if (fromOwnPage(sender, OFFSCREEN)) void onRecorderStatus(message);
      return false;
    case "cluebro-mic-granted":
      if (fromOwnPage(sender, "permission.html"))
        void chrome.runtime.sendMessage({ type: "cluebro-offscreen-mic", target: "offscreen" }).catch(() => {});
      return false;
    default:
      return false;
  }
});

function relay(message, sender, reply) {
  if (!fromMeetTab(sender)) {
    reply({ error: "Requests must originate from the meeting panel." });
    return false;
  }
  const path = message.path;
  if (
    typeof path !== "string" ||
    !/^\/(health|captions|meetings|memory\/search|suggestions)(?:[/?]|$)/.test(path) ||
    path.includes("\\") ||
    path.includes("..")
  ) {
    reply({ error: "Unsupported bridge endpoint." });
    return false;
  }
  void (async () => {
    try {
      const response = await fetch(`http://127.0.0.1:8787${path}`, {
        ...(message.body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(message.body),
            }),
        signal: AbortSignal.timeout(25000),
      });
      reply({ status: response.status, text: await response.text() });
    } catch (error) {
      reply({ error: `Bridge unavailable: ${error.message}` });
    }
  })();
  return true;
}

// Chrome only lets an extension record a tab after the extension itself is
// invoked, and a click inside the page's panel does not count. The toolbar
// button is that invocation, and clicking it again stops the recording.
chrome.action.onClicked.addListener((tab) => void toggleCapture(tab));

// The service worker can be stopped between events, so which tab is being
// recorded is kept where it survives that.
const capturedTab = async () => (await chrome.storage.session.get("captureTabId")).captureTabId;

async function toggleCapture(tab) {
  if (!tab?.id || !tab.url?.startsWith("https://meet.google.com/")) return;
  const current = await capturedTab();
  if (current !== undefined) {
    await stopCapture();
    if (current === tab.id) return;
  }
  try {
    // Requested first, while the click that granted it is freshest.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const session = await chrome.tabs.sendMessage(tab.id, { type: "cluebro-capture-begin" });
    if (!session?.meeting_id) throw new Error(session?.error ?? "The meeting panel did not start a session.");
    await ensureRecorder();
    await chrome.storage.session.set({ captureTabId: tab.id });
    await chrome.runtime.sendMessage({
      type: "cluebro-offscreen-start",
      target: "offscreen",
      streamId,
      meetingId: session.meeting_id,
    });
    // The badge is the part of the disclosure that stays visible when the
    // panel is minimized.
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#b3261e" });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "REC" });
  } catch (error) {
    await tell(tab.id, "error", error.message);
    await stopCapture();
  }
}

async function ensureRecorder() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN)],
  });
  if (existing.length > 0) return;
  // USER_MEDIA only. AUDIO_PLAYBACK would close the document after thirty
  // seconds without sound, which is an ordinary pause in a meeting.
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ["USER_MEDIA"],
    justification: "Records this call's audio for transcription and keeps it audible while recorded.",
  });
}

async function stopCapture() {
  const tabId = await capturedTab();
  await chrome.storage.session.remove("captureTabId");
  await chrome.runtime.sendMessage({ type: "cluebro-offscreen-stop", target: "offscreen" }).catch(() => {});
  await chrome.offscreen.closeDocument().catch(() => {});
  if (tabId === undefined) return;
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  await tell(tabId, "stopped");
}

async function onRecorderStatus({ state, detail }) {
  // An offscreen document cannot show a permission prompt, so the one place
  // the microphone can be allowed is a normal extension tab.
  if (state === "mic-denied") await chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
  const tabId = await capturedTab();
  if (tabId !== undefined) await tell(tabId, state, detail);
  if (state === "error") await stopCapture();
}

async function tell(tabId, state, detail = "") {
  await chrome.tabs.sendMessage(tabId, { type: "cluebro-capture-status", state, detail }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void capturedTab().then((current) => {
    if (current === tabId) void stopCapture();
  });
});
