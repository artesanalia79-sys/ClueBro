// Resampling is the AudioContext's job; this only turns float frames into the
// 16-bit little-endian PCM the transcriber expects, in 100 ms pieces so the
// socket is not sent a message every 128 samples.
const CHUNK = 2400;

class Pcm16 extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(CHUNK);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      if (this.filled === CHUNK) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(CHUNK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm16", Pcm16);
