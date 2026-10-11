"use strict";
// Records the microphone as 16 kHz mono PCM16, the format the dictation route
// takes. Loaded from this listener rather than a Blob URL, so the page's
// `script-src 'self'` admits it.
var TARGET_RATE = 16000;
// A quarter second of output per message keeps the main thread quiet.
var CHUNK = 4096;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is the context's rate, usually 44.1 or 48 kHz. Each output
    // sample averages the input samples it spans, which also low-passes them.
    this.ratio = sampleRate / TARGET_RATE;
    this.t = 0;
    this.acc = 0;
    this.n = 0;
    this.last = 0;
    this.out = new Int16Array(CHUNK);
    this.len = 0;
    var self = this;
    this.port.onmessage = function (e) {
      if (e.data === "flush") {
        self.flush();
        self.port.postMessage({ done: true });
      }
    };
  }

  emit(v) {
    v = Math.max(-1, Math.min(1, v));
    this.out[this.len++] = v < 0 ? v * 32768 : v * 32767;
    if (this.len === CHUNK) this.flush();
  }

  flush() {
    if (this.len === 0) return;
    this.port.postMessage(this.out.slice(0, this.len));
    this.len = 0;
  }

  process(inputs) {
    var input = inputs[0];
    if (!input || input.length === 0) return true;
    var frames = input[0].length, channels = input.length;
    for (var i = 0; i < frames; i++) {
      var s = 0;
      for (var c = 0; c < channels; c++) s += input[c][i];
      this.acc += s / channels;
      this.n++;
      this.t += 1;
      while (this.t >= this.ratio) {
        if (this.n > 0) this.last = this.acc / this.n;
        this.emit(this.last);
        this.t -= this.ratio;
        this.acc = 0;
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
