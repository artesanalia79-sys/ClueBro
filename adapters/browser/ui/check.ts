import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";

const script = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const window = new Window({ url: "https://meet.google.com/abc-defg-hij" });
let now = Date.now();
const timers = new Map<number, () => void>();
let timerId = 0;
window.setInterval = ((callback: () => void) => {
  timers.set(++timerId, callback);
  return timerId;
}) as unknown as typeof window.setInterval;
window.clearInterval = ((id: number) => {
  timers.delete(id);
}) as unknown as typeof window.clearInterval;
window.Date.now = () => now;
const storage: Record<string, unknown> = {};
const sent: Record<string, unknown>[] = [];
let offline = false;
let closed = false;
const session = {
  id: "0a869b4e-5c25-4512-ae04-04a0b708d08e",
  project: "launch",
  room: "abc-defg-hij",
  label: "Planning",
  started_at: new Date().toISOString(),
  event_count: 1,
  processed_count: 0,
  ended_at: null,
  extraction_enabled: false,
};
Object.assign(window, {
  chrome: {
    storage: {
      local: {
        set: async (data: Record<string, unknown>) => Object.assign(storage, structuredClone(data)),
        get: async (key: string) => ({ [key]: storage[key] }),
      },
    },
    runtime: {
      id: "test",
      onMessage: { addListener: () => {} },
      sendMessage: async (message: { path: string; body?: Record<string, unknown> }) => {
        if (message.path === "/captions") {
          sent.push(structuredClone(message.body!));
          if (offline) return { error: "Offline" };
          return { status: 202, text: "" };
        }
        let result: unknown = session;
        if (message.path.endsWith("/finish")) {
          closed = true;
          result = { ...session, ended_at: new Date().toISOString() };
        }
        if (message.path.startsWith("/meetings?"))
          result = [{ ...session, ended_at: closed ? new Date().toISOString() : null }];
        if (message.path.startsWith("/suggestions?")) result = { frames: [] };
        if (message.path.includes("/context")) result = { hits: [] };
        if (message.path.startsWith("/memory/search"))
          result = {
            hits: [
              {
                event_id: "one",
                meeting_id: session.id,
                label: "Planning",
                occurred_at: session.started_at,
                speaker: "Sam",
                text: "<script>unsafe()</script> Friday launch",
              },
            ],
            synthesis: { answer: "Friday launch", sources: ["one"] },
          };
        return { status: 200, text: JSON.stringify(result) };
      },
    },
  },
});
window.document.body.innerHTML =
  '<div jsname="dsyhDe"><div data-sender-name="Sam"><span id="caption">We agreed to launch Friday.</span></div></div>';
window.eval(script);
const find = (selector: string) => window.document.querySelector(selector)!;
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));
};
const tick = async (milliseconds: number) => {
  now += milliseconds;
  for (const callback of [...timers.values()]) callback();
  await settle();
};
try {
  await tick(2000);
  assert.equal(sent.length, 0, "captions must not be captured before Start saving");
  (find(".project") as unknown as HTMLInputElement).value = "launch";
  (find(".start") as unknown as HTMLButtonElement).click();
  await settle();
  await tick(500);
  await tick(1300);
  assert.equal(sent.length, 1, "nested containers must not duplicate the leaf caption");
  await tick(1500);
  assert.equal(sent.length, 1, "stable DOM must not resend captions");
  find("#caption").textContent = "We agreed to launch Friday. Sam owns delivery.";
  await tick(500);
  await tick(1300);
  assert.equal(sent.length, 2);
  assert.equal(
    sent[1]!.text,
    "Sam owns delivery.",
    "growing subtitles do not repeat their stable prefix",
  );
  offline = true;
  find("#caption").textContent = "The budget is approved.";
  await tick(500);
  await tick(1300);
  const retryId = sent.at(-1)!.caption_id;
  assert.equal(
    (storage[`cluebro-pending:${session.id}`] as unknown[]).length,
    1,
    "offline captions are persisted before retries",
  );
  offline = false;
  await tick(3000);
  assert.equal(sent.at(-1)!.caption_id, retryId, "retry identity must remain stable");
  assert.equal((storage[`cluebro-pending:${session.id}`] as unknown[]).length, 0);
  (find("#cluebro-query") as unknown as HTMLInputElement).value = "launch";
  find(".search").dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.match(find(".memory-results").textContent, /Friday launch/);
  assert.equal(
    find(".memory-results").querySelector("script"),
    null,
    "source text must be escaped in the panel",
  );
  (find(".finish") as unknown as HTMLButtonElement).click();
  await settle();
  assert.equal(closed, true);
  assert.equal((find(".start") as unknown as HTMLButtonElement).disabled, false);
  find("#caption").textContent = "After finish.";
  await tick(2000);
  assert.notEqual(sent.at(-1)!.text, "After finish.");
  (find(".collapse") as unknown as HTMLButtonElement).click();
  assert.equal(find(".collapse").getAttribute("aria-expanded"), "false");
  assert.equal((find(".panel-content") as unknown as HTMLElement).hidden, true);
} finally {
  await window.happyDOM.close();
}

// Joining a call starts the session and leaving it closes the session, so a
// transcript no longer depends on remembering two buttons.
{
  const auto = new Window({ url: "https://meet.google.com/abc-defg-hij" });
  let clock = Date.now();
  const ticks = new Map<number, () => void>();
  let id = 0;
  auto.setInterval = ((callback: () => void) => {
    ticks.set(++id, callback);
    return id;
  }) as unknown as typeof auto.setInterval;
  auto.clearInterval = ((key: number) => {
    ticks.delete(key);
  }) as unknown as typeof auto.clearInterval;
  auto.Date.now = () => clock;
  const captions: Record<string, unknown>[] = [];
  let finished = false;
  const store: Record<string, unknown> = {};
  const meeting = { ...session, id: "6f1c0f04-0a3b-4a1e-9c23-7a3f5d0e21bb", ended_at: null };
  let autoListener:
    | ((message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean)
    | undefined;
  const runtimeTypes: string[] = [];
  Object.assign(auto, {
    chrome: {
      storage: {
        local: {
          set: async (data: Record<string, unknown>) => Object.assign(store, structuredClone(data)),
          get: async (key: string) => ({ [key]: store[key] }),
        },
      },
      runtime: {
        id: "test",
        onMessage: {
          addListener: (fn: typeof autoListener) => {
            autoListener = fn;
          },
        },
        sendMessage: async (message: { type?: string; path: string; body?: Record<string, unknown> }) => {
          runtimeTypes.push(message.type ?? "");
          if (!message.path) return { status: 200, text: "" };
          if (message.path === "/captions") {
            captions.push(structuredClone(message.body!));
            return { status: 202, text: "" };
          }
          let result: unknown = meeting;
          if (message.path.endsWith("/finish")) {
            finished = true;
            result = { ...meeting, ended_at: new Date().toISOString() };
          }
          if (message.path.startsWith("/meetings?")) result = [meeting];
          if (message.path.startsWith("/suggestions?")) result = { frames: [] };
          if (message.path.includes("/context")) result = { hits: [] };
          return { status: 200, text: JSON.stringify(result) };
        },
      },
    },
  });
  // An empty caption region is what a Meet page looks like outside a call.
  auto.document.body.innerHTML =
    '<div jsname="dsyhDe"><div data-sender-name="Sam"><span id="caption"></span></div></div>';
  auto.eval(script);
  const settleAuto = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  };
  const tickAuto = async (ms: number) => {
    clock += ms;
    for (const callback of [...ticks.values()]) callback();
    await settleAuto();
  };
  try {
    await tickAuto(2000);
    assert.equal(captions.length, 0, "a page outside a call must capture nothing");

    // A tile carries no hang-up label, so this also covers a Meet running in
    // an interface language the selectors do not spell out.
    const tile = auto.document.createElement("div");
    tile.setAttribute("data-participant-id", "sam");
    auto.document.body.appendChild(tile);
    auto.document.querySelector("#caption")!.textContent = "Shipping is Friday.";
    await tickAuto(2000);
    await tickAuto(500);
    await tickAuto(1300);
    assert.equal(captions.length, 1, "joining a call starts the session on its own");

    // Leaving tears the call interface down, captions included.
    tile.remove();
    auto.document.querySelector("#caption")!.textContent = "";
    await tickAuto(2000);
    await settleAuto();
    assert.equal(finished, true, "leaving a call closes the session on its own");

    // Captions coming back mean the call is live again, so a new session
    // opens rather than the closed one silently reopening.
    const afterLeaving = captions.length;
    auto.document.querySelector("#caption")!.textContent = "Back in the call.";
    for (let i = 0; i < 4; i++) await tickAuto(1300);
    assert.equal(captions.length, afterLeaving + 1, "rejoining a call opens a new session");

    // Stopping by hand has to survive captions that keep arriving, or the
    // watcher would undo the decision two seconds later.
    (auto.document.querySelector("#cluebro-panel .finish") as unknown as HTMLButtonElement).click();
    await settleAuto();
    const afterStopping = captions.length;
    auto.document.querySelector("#caption")!.textContent = "Still talking afterwards.";
    for (let i = 0; i < 4; i++) await tickAuto(1300);
    assert.equal(captions.length, afterStopping, "an explicit stop is not undone by the watcher");

    // The toolbar button attaches the call's audio to the panel's session, and
    // while it records, Meet's captions are not stored a second time.
    const audioReply = await new Promise<{ meeting_id?: string; error?: string }>((resolve) => {
      autoListener!({ type: "cluebro-capture-begin" }, { id: "test" }, resolve as (value: unknown) => void);
    });
    assert.equal(audioReply.meeting_id, meeting.id, "recorded audio is attached to the panel's session");
    const beforeAudio = captions.length;
    auto.document.querySelector("#caption")!.textContent = "Captions while the audio is recorded.";
    for (let i = 0; i < 4; i++) await tickAuto(1300);
    assert.equal(captions.length, beforeAudio, "Meet captions are not stored while audio carries the call");

    autoListener!({ type: "cluebro-capture-status", state: "stopped" }, { id: "test" }, () => {});
    auto.document.querySelector("#caption")!.textContent = "Captions after the recorder stopped.";
    for (let i = 0; i < 4; i++) await tickAuto(1300);
    assert.equal(captions.length, beforeAudio + 1, "stopping the recorder hands the transcript back to captions");

    autoListener!({ type: "cluebro-capture-begin" }, { id: "test" }, () => {});
    await settleAuto();
    (auto.document.querySelector("#cluebro-panel .finish") as unknown as HTMLButtonElement).click();
    await settleAuto();
    assert.ok(runtimeTypes.includes("cluebro-capture-end"), "finishing the meeting stops the recorder");

    // Reloading the extension kills this page's channel to it. The panel has
    // to say what fixes that, because nothing here can fix it on its own.
    (auto as unknown as { chrome: { runtime: { sendMessage: () => Promise<never> } } }).chrome.runtime.sendMessage =
      () => Promise.reject(new Error("Extension context invalidated."));
    (auto.document.querySelector("#cluebro-panel .refresh") as unknown as HTMLButtonElement).click();
    await settleAuto();
    assert.match(
      auto.document.querySelector("#cluebro-panel .state")!.textContent,
      /Reload this tab/,
      "a stale content script tells the reader to reload",
    );
  } finally {
    await auto.happyDOM.close();
  }
}

// With OpenAI transcription configured, Meet's captions are never the source:
// they are worse than the audio and would store every sentence a second time.
{
  const quiet = new Window({ url: "https://meet.google.com/abc-defg-hij" });
  let clock = Date.now();
  const ticks = new Map<number, () => void>();
  let id = 0;
  quiet.setInterval = ((callback: () => void) => {
    ticks.set(++id, callback);
    return id;
  }) as unknown as typeof quiet.setInterval;
  quiet.clearInterval = ((key: number) => {
    ticks.delete(key);
  }) as unknown as typeof quiet.clearInterval;
  quiet.Date.now = () => clock;
  const stored: unknown[] = [];
  const store: Record<string, unknown> = {};
  const live = { ...session, id: "9b2d4c11-7e3a-4f5b-8c6d-1a2b3c4d5e6f", ended_at: null };
  Object.assign(quiet, {
    chrome: {
      storage: {
        local: {
          set: async (data: Record<string, unknown>) => Object.assign(store, structuredClone(data)),
          get: async (key: string) => ({ [key]: store[key] }),
        },
      },
      runtime: {
        id: "test",
        onMessage: { addListener: () => {} },
        sendMessage: async (message: { path?: string; body?: Record<string, unknown> }) => {
          if (message.path === "/health")
            return { status: 200, text: JSON.stringify({ ok: true, audio: true }) };
          if (message.path === "/captions") {
            stored.push(message.body);
            return { status: 202, text: "" };
          }
          let result: unknown = live;
          if (message.path?.startsWith("/meetings?")) result = [live];
          if (message.path?.startsWith("/suggestions?")) result = { frames: [] };
          if (message.path?.includes("/context")) result = { hits: [] };
          return { status: 200, text: JSON.stringify(result) };
        },
      },
    },
  });
  quiet.document.body.innerHTML =
    '<div data-participant-id="me"></div><div jsname="dsyhDe"><div data-sender-name="Sam"><span id="caption">A Meet caption that must not be stored.</span></div></div>';
  quiet.eval(script);
  const settleQuiet = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  };
  try {
    await settleQuiet();
    for (let i = 0; i < 6; i++) {
      clock += 1300;
      for (const callback of [...ticks.values()]) callback();
      await settleQuiet();
    }
    assert.equal(stored.length, 0, "Meet captions are not stored when OpenAI transcription is configured");
    assert.match(
      quiet.document.querySelector("#cluebro-panel .state")!.textContent,
      /toolbar/,
      "the panel points to the toolbar button, not to Meet captions",
    );
  } finally {
    await quiet.happyDOM.close();
  }
}

let listener: (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
let clicked: ((tab: unknown) => void) | undefined;
const fetched: string[] = [];
const workerCalls: string[] = [];
const workerSent: Record<string, unknown>[] = [];
const sessionStore: Record<string, unknown> = {};
runInNewContext(readFileSync(new URL("../extension/background.js", import.meta.url), "utf8"), {
  chrome: {
    runtime: {
      id: "test",
      onMessage: {
        addListener: (fn: typeof listener) => {
          listener = fn;
        },
      },
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: async () => [],
      sendMessage: async (message: Record<string, unknown>) => {
        workerSent.push(message);
      },
    },
    action: {
      onClicked: {
        addListener: (fn: typeof clicked) => {
          clicked = fn;
        },
      },
      setBadgeText: async (details: { text: string }) => {
        workerCalls.push(`badge:${details.text}`);
      },
      setBadgeBackgroundColor: async () => {},
    },
    tabs: {
      onRemoved: { addListener: () => {} },
      sendMessage: async (_tabId: number, message: { type: string }) =>
        message.type === "cluebro-capture-begin"
          ? { meeting_id: "6f1c0f04-0a3b-4a1e-9c23-7a3f5d0e21bb" }
          : undefined,
      create: async () => {},
    },
    tabCapture: {
      getMediaStreamId: async (options: { targetTabId: number }) => {
        workerCalls.push(`capture:${options.targetTabId}`);
        return "stream-1";
      },
    },
    offscreen: {
      createDocument: async (options: { reasons: string[] }) => {
        workerCalls.push(`offscreen:${options.reasons.join(",")}`);
      },
      closeDocument: async () => {
        workerCalls.push("offscreen:closed");
      },
    },
    storage: {
      session: {
        get: async (key: string) => ({ [key]: sessionStore[key] }),
        set: async (data: Record<string, unknown>) => {
          Object.assign(sessionStore, data);
        },
        remove: async (key: string) => {
          delete sessionStore[key];
        },
      },
    },
  },
  fetch: async (url: string) => {
    fetched.push(url);
    return { status: 200, text: async () => "{}" };
  },
  AbortSignal,
});
const sender = { id: "test", tab: { url: "https://meet.google.com/abc-defg-hij" } };
const call = (path: string, from: unknown = sender) =>
  new Promise<unknown>((resolve) => listener!({ type: "cluebro-request", path }, from, resolve));
await call("/health");
assert.equal(fetched.length, 1);
await call("https://evil.example/");
await call("/meetings/../../secret");
await call("/health", { id: "other", tab: sender.tab });
assert.equal(
  fetched.length,
  1,
  "the worker must reject arbitrary destinations and external senders",
);

// The toolbar button is the only invocation Chrome accepts for recording a
// tab. It asks the panel for the session, starts a recorder with no
// silence-based lifetime, shows that it is recording, and a second click stops.
const meetTab = { id: 7, url: "https://meet.google.com/abc-defg-hij" };
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
clicked!(meetTab);
await flush();
assert.ok(workerCalls.includes("capture:7"), "the Meet tab that was clicked is the one recorded");
assert.ok(
  workerCalls.includes("offscreen:USER_MEDIA"),
  "the recorder is not given AUDIO_PLAYBACK, which closes after thirty silent seconds",
);
assert.equal(
  workerSent.find((m) => m.type === "cluebro-offscreen-start")?.meetingId,
  "6f1c0f04-0a3b-4a1e-9c23-7a3f5d0e21bb",
  "recorded audio goes to the panel's session",
);
assert.ok(workerCalls.includes("badge:REC"), "the recording stays visible on the toolbar");
clicked!(meetTab);
await flush();
assert.ok(workerSent.some((m) => m.type === "cluebro-offscreen-stop"), "a second click stops the recorder");
assert.ok(workerCalls.includes("badge:"), "and clears the badge");
clicked!({ id: 9, url: "https://example.com/" });
await flush();
assert.equal(
  workerCalls.filter((call) => call.startsWith("capture:")).length,
  1,
  "a tab outside Meet is never recorded",
);
console.log(
  "Meeting panel: automatic session, audio handover, no captions with OpenAI audio, caption stability, offline queue, sources, finish, recorder toggle and worker restrictions passed.",
);
