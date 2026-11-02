// Capture worklet. Runs on the browser audio render thread.
// Collects incoming microphone samples into ~100 ms frames and posts to main thread.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = Math.round(sampleRate * 0.1);
    this.buf = new Float32Array(this.frameSize);
    this.len = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buf[this.len++] = channel[i];
      if (this.len === this.frameSize) {
        const frame = this.buf.slice(0, this.frameSize);
        this.port.postMessage(frame.buffer, [frame.buffer]);
        this.buf = new Float32Array(this.frameSize);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
