// Records the call in a page the Meet tab cannot see. chrome.runtime is the
// only extension API an offscreen document gets.
const BRIDGE = "ws://127.0.0.1:8787/audio";
let active = [];
let meetingId = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "offscreen") return false;
  if (message.type === "cluebro-offscreen-start") void start(message.streamId, message.meetingId);
  else if (message.type === "cluebro-offscreen-stop") stop();
  else if (message.type === "cluebro-offscreen-mic") void captureMicrophone();
  return false;
});

const report = (state, detail = "") =>
  chrome.runtime.sendMessage({ type: "cluebro-offscreen-status", state, detail }).catch(() => {});

async function start(streamId, id) {
  stop();
  meetingId = id;
  try {
    const tab = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
    // Recording a tab silences it for the person in the call. Playing it
    // back through an ordinary context is what keeps them hearing everyone.
    const playback = new AudioContext();
    playback.createMediaStreamSource(tab).connect(playback.destination);
    active.push({ stream: tab, context: playback });
    await pipe(tab, "room");
  } catch (error) {
    report("error", `Tab audio: ${error.message}`);
    return;
  }
  report("recording");
  await captureMicrophone();
}

// The tab carries everyone else. Meet never plays your own voice back to
// you, so your side of the call only exists in the microphone.
async function captureMicrophone() {
  if (!meetingId || active.some((entry) => entry.speaker === "self")) return;
  try {
    const microphone = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    await pipe(microphone, "self");
    report("recording");
  } catch (error) {
    report(error.name === "NotAllowedError" ? "mic-denied" : "mic-error", `Microphone: ${error.message}`);
  }
}

async function pipe(stream, speaker) {
  // The context resamples to the 24 kHz the transcriber expects.
  const context = new AudioContext({ sampleRate: 24000 });
  await context.audioWorklet.addModule("pcm-worklet.js");
  const node = new AudioWorkletNode(context, "pcm16");
  const socket = new WebSocket(`${BRIDGE}?meeting_id=${encodeURIComponent(meetingId)}&speaker=${speaker}`);
  socket.binaryType = "arraybuffer";
  node.port.onmessage = (event) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
  };
  socket.onclose = (event) => {
    // A socket closed by stop() is no longer listed, so only an unexpected
    // drop is reported.
    if (active.some((entry) => entry.socket === socket))
      report("error", `Audio link to the bridge closed (${event.code}) ${event.reason}`.trim());
  };
  context.createMediaStreamSource(stream).connect(node);
  // A worklet is only pulled while it reaches the output. A silent gain keeps
  // it running without playing the audio a second time.
  const silent = context.createGain();
  silent.gain.value = 0;
  node.connect(silent).connect(context.destination);
  active.push({ stream, context, socket, speaker });
}

function stop() {
  const entries = active;
  active = [];
  meetingId = null;
  for (const { socket, context, stream } of entries) {
    socket?.close();
    for (const track of stream?.getTracks() ?? []) track.stop();
    void context?.close();
  }
}
