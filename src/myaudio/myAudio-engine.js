/**
 * myAudio-engine.js
 * version: v1.03
 * description:
 *   Browser audio engine (record/play/encode) module. Separated from the UI
 *   and reports progress/stop/error via EventTarget-based custom events.
 *
 * Events (Recorder):
 *   - 'progress' { detail: { elapsed, target } }
 *   - 'stopped'  { detail: { reason, chunksLength } }
 *   - 'error'    { detail: { message } }
 *
 * Events (Player):
 *   - 'time'     { detail: { currentTime, duration } }
 *   - 'paused'   {}
 *   - 'ended'    {}
 *
 * Note
 * - MP3 encoder (lamejs) is loaded globally.
 *   (Include CDN script in HTML first: lamejs 1.2.1)
 */

export const ENGINE_VERSION = "v1.03";

/* ===== Internal utilities ===== */
function float32ToInt16(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

// Merge Float32Array chunks
function mergeFloat32(chunks) {
  const total = chunks.reduce((acc, a) => acc + a.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const a of chunks) { out.set(a, offset); offset += a.length; }
  return out;
};

// Build audio constraints
export function buildAudioConstraints(profile = "voice", channels = 1) {
  if (profile === "music") {
    return {
      sampleRate: 48000,
      channelCount: channels,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };
  }
  return {
    sampleRate: 48000,
    channelCount: channels,
    echoCancellation: false,
    noiseSuppression: true,
    autoGainControl: false
  };
}

// MP3 encoding
export function encodeMP3FromFloat32Chunks(chunks, sampleRate, kbps = 128, channels = 1) {
  if (!Array.isArray(chunks) || !chunks.length) throw new Error("No audio chunks to encode.");
  if (!window.lamejs?.Mp3Encoder) throw new Error("lamejs not loaded.");
  const merged = mergeFloat32(chunks);
  const pcm16  = float32ToInt16(merged);

  const encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
  const mp3Data = [];
  const SAMPLES_PER_FRAME = 1152;

  let i = 0;
  while (i + SAMPLES_PER_FRAME <= pcm16.length) {
    const frame = pcm16.subarray(i, i + SAMPLES_PER_FRAME);
    const enc = encoder.encodeBuffer(frame);
    if (enc.length) mp3Data.push(enc);
    i += SAMPLES_PER_FRAME;
  }
  const remain = pcm16.length - i;
  if (remain > 0) {
    const last = new Int16Array(SAMPLES_PER_FRAME);
    last.set(pcm16.subarray(i));
    const enc = encoder.encodeBuffer(last);
    if (enc.length) mp3Data.push(enc);
  }
  const flush = encoder.flush();
  if (flush.length) mp3Data.push(flush);
  return new Blob(mp3Data, { type: "audio/mpeg" });
}

/* ============================================================
 * Class: Recorder — mic capture + Worklet collection + (optional) compressor/gain
 * ============================================================ */
export class Recorder extends EventTarget {
  constructor({ profile = "voice", kbps = 96 } = {}) {
    super();
    this.profile = profile;
    this.kbps = (profile === "voice") ? kbps : 128;

    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.inputGain = null;
    this.comp = null;

    this.sampleRate = 48000;
    this.chunks = [];      // Float32Array[]
    this._mp3Blob = null;  // encoding cache

    this._startTs = 0;
    this._targetSec = 60;
    this._rafId = null;
    this._autoStopId = null;

    this.CHANNELS = 1;
  }

  _emitProgress() {
    if (!this._startTs) return;
    const elapsed = (performance.now() - this._startTs) / 1000;
    this.dispatchEvent(new CustomEvent("progress", {
      detail: { elapsed, target: this._targetSec }
    }));
  }

  _tick = () => {
    this._emitProgress();
    if (!this._startTs) return;
    if ((performance.now() - this._startTs)/1000 >= this._targetSec) {
      this.stop("auto-stop");
      return;
    }
    this._rafId = requestAnimationFrame(this._tick);
  }

  async start({ durationSec = 60 } = {}) {
    try {
      this._clearTimers();
      this._mp3Blob = null;
      this.chunks = [];

      const AC = window.AudioContext || window.webkitAudioContext;
      if (!this.audioContext) this.audioContext = new AC();
      if (this.audioContext.state === "suspended") await this.audioContext.resume();
      this.sampleRate = this.audioContext.sampleRate;

      await this.audioContext.audioWorklet.addModule("recorder-worklet.js");

      const constraints = buildAudioConstraints(this.profile, this.CHANNELS);
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      const track = this.mediaStream.getAudioTracks()[0];
      if (track?.applyConstraints) { try { await track.applyConstraints(constraints); } catch {} }

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.inputGain  = this.audioContext.createGain();
      this.inputGain.gain.value = (this.profile === "voice") ? 1.2 : 1.0;

      this.comp = new DynamicsCompressorNode(this.audioContext, {
        threshold: -10, ratio: 3, attack: 0.003, release: 0.25, knee: 6
      });

      this.workletNode = new AudioWorkletNode(this.audioContext, "recorder-worklet");
      this.workletNode.port.onmessage = (e) => {
        const chunk = e.data;
        if (chunk) this.chunks.push(new Float32Array(chunk));
      };

      this.sourceNode.connect(this.inputGain).connect(this.comp).connect(this.workletNode);
      this.workletNode.connect(this.audioContext.destination); // monitor

      this._targetSec = Math.max(1, Math.min(3600, Number(durationSec) || 60));
      this._startTs = performance.now();
      this._rafId = requestAnimationFrame(this._tick);
      this._autoStopId = setTimeout(() => this.stop("timer"), this._targetSec * 1000);
    } catch (err) {
      this._emitError(err);
      throw err;
    }
  }

  stop(reason = "user") {
    this._clearTimers();

    try { this.sourceNode?.disconnect(this.inputGain); } catch {}
    try { this.inputGain?.disconnect(this.comp); } catch {}
    try { this.comp?.disconnect(this.workletNode); } catch {}
    try { this.workletNode?.disconnect(); } catch {}

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }

    this._emitProgress();
    this._startTs = 0;

    this.dispatchEvent(new CustomEvent("stopped", {
      detail: { reason, chunksLength: this.chunks.length }
    }));
  }

  _clearTimers() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    if (this._autoStopId) clearTimeout(this._autoStopId);
    this._autoStopId = null;
  }

  _emitError(err) {
    this.dispatchEvent(new CustomEvent("error", {
      detail: { message: err?.message || String(err) }
    }));
  }

  ensureMP3Ready() {
    if (!this.chunks.length) throw new Error("No audio to encode.");
    if (!this._mp3Blob) {
      this._mp3Blob = encodeMP3FromFloat32Chunks(this.chunks, this.sampleRate, this.kbps, this.CHANNELS);
    }
    return this._mp3Blob;
  }

  get mp3Blob() {
    return this._mp3Blob || null;
  }
}

/* ============================================================
 * Class: Player — load Blob + play/pause/stop + time events
 * ============================================================ */
export class Player extends EventTarget {
  constructor() {
    super();
    this._audio = new Audio();
    this._audio.preload = "metadata";
    this._objectURL = null;

    this._audio.addEventListener("timeupdate", () => {
      this.dispatchEvent(new CustomEvent("time", {
        detail: { currentTime: this._audio.currentTime || 0, duration: this._audio.duration || 0 }
      }));
    });
    this._audio.addEventListener("pause", () => {
      if (this._audio.currentTime > 0 && !this._audio.ended) {
        this.dispatchEvent(new Event("paused"));
      }
    });
    this._audio.addEventListener("ended", () => {
      this.dispatchEvent(new Event("ended"));
    });
  }

  async loadFromBlob(blob) {
    this.unload();
    this._objectURL = URL.createObjectURL(blob);
    this._audio.src = this._objectURL;
    await this._audio.load();
    return new Promise(resolve => {
      if (Number.isFinite(this._audio.duration)) return resolve();
      this._audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
    });
  }

  unload() {
    if (this._objectURL) {
      try { URL.revokeObjectURL(this._objectURL); } catch {}
      this._objectURL = null;
    }
    this._audio.src = "";
  }

  play(atSec = null) {
    if (Number.isFinite(atSec)) {
      this._audio.currentTime = Math.max(0, atSec);
    }
    return this._audio.play();
  }

  pause() { this._audio.pause(); }
  stop()  { this._audio.pause(); this._audio.currentTime = 0; }
  setCurrentTime(sec) { this._audio.currentTime = Math.max(0, Number(sec) || 0); }

  get duration() { return Number.isFinite(this._audio.duration) ? this._audio.duration : 0; }
  get currentTime() { return this._audio.currentTime || 0; }
}
