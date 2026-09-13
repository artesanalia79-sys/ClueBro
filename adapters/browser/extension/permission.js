const state = document.getElementById("state");

document.getElementById("allow").onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    state.textContent = "Microphone allowed. You can close this tab and go back to the call.";
    await chrome.runtime.sendMessage({ type: "cluebro-mic-granted" });
  } catch (error) {
    state.textContent = `Microphone still blocked (${error.message}). Only the other participants will be transcribed.`;
  }
};
