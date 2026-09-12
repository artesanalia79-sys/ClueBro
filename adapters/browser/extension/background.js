// Host permissions apply to service-worker fetches, not Meet content scripts.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "cluebro-request") return false;
  if (sender.id !== chrome.runtime.id || !sender.tab?.url?.startsWith("https://meet.google.com/")) {
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
});
