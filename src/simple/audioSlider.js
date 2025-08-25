/**
 * audioSlider.js
 * version: 0.96-g
 * description: Input recording time (seconds) + progress slider (400–800px) + auto stop when time elapses
 */

// ===== Settings (endpoints) =====
const version = "v0.96-g";
console.log(`audioSlider ${version}`);

// ===== DOM =====
const startRecordButton  = document.getElementById('startRecordButton');
const stopRecordButton   = document.getElementById('stopRecordButton');
const playButton         = document.getElementById('playButton');
const stopPlayButton     = document.getElementById('stopPlayButton');
const downloadButton     = document.getElementById('downloadButton');

const logAreaEl          = document.getElementById('logArea');

// Recording slider / time input
const timeInput     = document.getElementById('audioRecordTime');
const recordSlider  = document.getElementById('audioRecordSlider');

// Playback duration/slider + controls
const playerTimeEl  = document.getElementById('audioPlayerTime');
const playerSlider  = document.getElementById('audioPlayerSlider');
const pauseBtn      = document.getElementById('audioPauseButton');
const resumeBtn     = document.getElementById('audioResumeButton');

// (Add) elapsed time display elements
const recordElapsedEl = document.getElementById('audioRecordElapsed');
const playerElapsedEl = document.getElementById('audioPlayerElapsed');

// ===== Capture profile =====
// const CAPTURE_PROFILE = "music"; // Gain 1.0
const CAPTURE_PROFILE = "voice";    // Gain 1.2 (20% boost)

// ===== Audio context / nodes =====
let audioContext = null;
let mediaStream = null;
let mediaSourceNode = null;
let recorderNode = null;

// Input gain / compressor
let inputGain = null;
let comp = null;

// ===== Recording data / state =====
let recordedChunks = [];     // Float32Array[]
let sampleRate = 48000;      // will be replaced by actual audioContext.sampleRate
let mp3Blob = null;          // encoding cache
let lastObjectURL = null;    // playback URL cache
let playbackAudio = null;    // <audio> playback object

// Recording slider / auto-stop state
let startTs = 0;
let targetDurationSec = 60;  // final recording time (sec)
let rafId = null;
let autoStopTimerId = null;

// ===== MP3 settings =====
const MP3_CHANNELS = 1;      // mono
let MP3_KBPS = 128;          // 96(voice), 128(music)

// Log utility
function log(msg = "") {
  console.log(msg);
  if (!logAreaEl) return;
  logAreaEl.textContent += (typeof msg === "string" ? msg : String(msg)) + "\n";
};

// Print an object as JSON string
function logJSON(label, obj) {
  const pretty = JSON.stringify(obj, null, 2);
  log(`${label}:\n${pretty}`);
};

// Seconds -> integer seconds
function secs(n) { return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0; };

// Seconds -> one decimal place
function secs1(n) {
  if (!Number.isFinite(n)) return "0.0s";
  return `${Math.max(0, Math.floor(n * 10) / 10).toFixed(1)}s`; // 0.1s resolution
};

// Enable/disable playback controls
function setPlayerEnabled(enabled) {
  if (playerSlider) playerSlider.disabled = !enabled;
  if (!enabled) {
    pauseBtn.disabled  = true;
    resumeBtn.disabled = true;
  }
};

// Pause/Resume button states
function setPauseResumeState({ canPause, canResume }) {
  if (pauseBtn)  pauseBtn.disabled  = !canPause;
  if (resumeBtn) resumeBtn.disabled = !canResume;
};

/* Update playback UI (top buttons) */
function updatePlaybackUI(isPlaying) {
  if (isPlaying) {
    startRecordButton.disabled = true;    // cannot start recording while playing
    playButton.disabled        = true;
    stopPlayButton.disabled    = false;
  } else {
    startRecordButton.disabled = false;
    const hasData = recordedChunks.length > 0 || !!mp3Blob;
    playButton.disabled        = !hasData;
    stopPlayButton.disabled    = true;
  }
};

// Initial setup
function initSetup() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const temp = new AC();
      log(`Initial detected device sampleRate: ${temp.sampleRate} Hz`);
      temp.close && temp.close();
    }
  } catch (e) {
    log('초기 sampleRate 확인 중 오류: ' + e.message);
  }

  MP3_KBPS = (CAPTURE_PROFILE === "voice") ? 96 : 128;
  log(`SET To ${CAPTURE_PROFILE} : ${MP3_KBPS}`);

  const initSec = parseInt(timeInput?.value ?? "60", 10) || 60;
  resetRecordSliderWithMax(initSec);

  setPlayerEnabled(false);
  setPauseResumeState({ canPause: false, canResume: false });
  if (playerTimeEl) playerTimeEl.textContent = "0";
  if (recordElapsedEl) recordElapsedEl.textContent = "0.0s";
  if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";
};

// Call initial setup
initSetup();

// Build audio capture constraints
function buildAudioConstraints(profile) {
  if (profile === "music") {
    return { sampleRate: 48000, channelCount: MP3_CHANNELS, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  } else {
    return { sampleRate: 48000, channelCount: MP3_CHANNELS, echoCancellation: false, noiseSuppression: true, autoGainControl: false };
  }
};

// Float32Array -> Int16Array conversion
function float32ToInt16(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = (s < 0 ? s * 0x8000 : s * 0x7FFF) | 0;
  }
  return out;
};

// Merge Float32Array chunks
function mergeFloat32(chunks) {
  const total = chunks.reduce((acc, a) => acc + a.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const a of chunks) { out.set(a, offset); offset += a.length; }
  return out;
};

// MP3 encoding (lamejs)
function encodeMP3FromFloat32Chunks(chunks, sampleRate, kbps = MP3_KBPS) {
  if (!chunks.length) throw new Error('No audio chunks to encode.');
  const merged = mergeFloat32(chunks);
  const pcm16  = float32ToInt16(merged);
  const encoder = new lamejs.Mp3Encoder(MP3_CHANNELS, sampleRate, kbps);
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
  return new Blob(mp3Data, { type: 'audio/mpeg' });
};

// Revoke the last ObjectURL
function revokeLastURL() {
  if (lastObjectURL) { URL.revokeObjectURL(lastObjectURL); lastObjectURL = null; }
};

// Prepare mp3Blob if recorded data exists
function ensureMP3Ready() {
  if (!recordedChunks.length) throw new Error('인코딩할 오디오가 없습니다.');
  if (!mp3Blob) { mp3Blob = encodeMP3FromFloat32Chunks(recordedChunks, sampleRate, MP3_KBPS); }
};

// Timestamp-based filename
function timestampFilename(prefix = 'recording', ext = 'mp3') {
  const d = new Date(), pad = (n)=>String(n).padStart(2,'0');
  return `${prefix}_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
};



//  Recording slider / auto-stop
function resetRecordSliderWithMax(maxSec) {
  if (!recordSlider) return;
  recordSlider.min = "0";
  recordSlider.max = String(maxSec);
  recordSlider.value = "0";
  if (recordElapsedEl) recordElapsedEl.textContent = "0.0s";
};

// Animate recording slider
function animateRecordSlider() {
  if (!startTs || !recordSlider) return;
  const now = performance.now();
  const elapsedSec = (now - startTs) / 1000;
  recordSlider.value = Math.min(elapsedSec, targetDurationSec).toFixed(3);
  if (recordElapsedEl) recordElapsedEl.textContent = secs1(elapsedSec);
  if (elapsedSec >= targetDurationSec) { stopRecording("auto-stop"); return; }
  rafId = requestAnimationFrame(animateRecordSlider);
};

// Clear timers/animation
function clearTimers() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  clearTimeout(autoStopTimerId);
  autoStopTimerId = null;
};

// Prepare playback
function preparePlayerFromBlob() {
  try { ensureMP3Ready(); } catch (_) { return; }
  if (!lastObjectURL) lastObjectURL = URL.createObjectURL(mp3Blob);

  const probe = new Audio(lastObjectURL);
  probe.addEventListener('loadedmetadata', () => {
    const dur = isFinite(probe.duration) ? probe.duration : 0;
    if (playerTimeEl) playerTimeEl.textContent = String(secs(dur));
    if (playerSlider) {
      playerSlider.max = String(dur || 0);
      playerSlider.value = "0";
      setPlayerEnabled(true);
    };

    if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";
    // After recording completes: enable Resume(Play) (first play also allowed)
    setPauseResumeState({ canPause: false, canResume: true });
    log(`Prepared player (duration=${dur.toFixed(3)}s)`);
  }, { once: true });

};

// Start recording
async function startRecording() {

  if (playbackAudio && !playbackAudio.paused) {
    playbackAudio.pause();
    playbackAudio.currentTime = 0;
    updatePlaybackUI(false);
  };

  // Parse input (desiredSeconds)
  const desiredSeconds = parseInt(timeInput?.value ?? "60", 10);
  targetDurationSec = Number.isFinite(desiredSeconds) && desiredSeconds >= 1 ? desiredSeconds : 60;
  if (targetDurationSec > 3600) targetDurationSec = 3600;
  resetRecordSliderWithMax(targetDurationSec);

  revokeLastURL();
  mp3Blob = null;
  recordedChunks = [];

  setPlayerEnabled(false);
  setPauseResumeState({ canPause: false, canResume: false });
  if (playerTimeEl) playerTimeEl.textContent = "0";
  if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";

  try {
    if (!audioContext) audioContext = new AudioContext();
    if (audioContext.state === 'suspended') await audioContext.resume();

    sampleRate = audioContext.sampleRate;
    log(`AudioContext sampleRate: ${sampleRate}`);
    log(`Capture profile: ${CAPTURE_PROFILE}`);

    await audioContext.audioWorklet.addModule('recorder-worklet.js');
    log('AudioWorklet module loaded');

    const audioConstraints = buildAudioConstraints(CAPTURE_PROFILE);
    logJSON('Request getUserMedia constraints', audioConstraints);

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    mediaSourceNode = audioContext.createMediaStreamSource(mediaStream);

    const track = mediaStream.getAudioTracks()[0];
    if (track?.applyConstraints) {
      try { await track.applyConstraints(audioConstraints); }
      catch(e) { log('applyConstraints 경고: ' + e.message); }
      if (track.getSettings) {
        const s = track.getSettings();
        logJSON('Actual track settings', s);
      }
    };

    inputGain = audioContext.createGain();
    inputGain.gain.value = (CAPTURE_PROFILE === "voice") ? 1.2 : 1.0;

    comp = new DynamicsCompressorNode(audioContext, { threshold: -10, ratio: 3, attack: 0.003, release: 0.25, knee: 6 });

    recorderNode = new AudioWorkletNode(audioContext, 'recorder-worklet');
    recorderNode.port.onmessage = (event) => {
      const chunk = event.data;
      recordedChunks.push(new Float32Array(chunk));
    };

    mediaSourceNode.connect(inputGain).connect(comp).connect(recorderNode);
    recorderNode.connect(audioContext.destination); // monitoring

    startRecordButton.disabled   = true;
    stopRecordButton.disabled    = false;
    playButton.disabled          = true;
    stopPlayButton.disabled      = true;
    downloadButton.disabled      = true;


    startTs = performance.now();
    animateRecordSlider();
    clearTimeout(autoStopTimerId);
    autoStopTimerId = setTimeout(() => stopRecording("timer"), targetDurationSec * 1000);

    log(`Recording started (profile=${CAPTURE_PROFILE}, gain=${inputGain.gain.value}, compressor=ON, duration=${targetDurationSec}s)`);
  } catch (err) {
    console.error(err);
    log('오류: ' + err.message);
    stopRecording("error");
  }

};

// Stop recording
function stopRecording(reason = "user") {
  try {
    clearTimers();

    if (mediaSourceNode && inputGain) {
      try { mediaSourceNode.disconnect(inputGain); } catch (_) {}
    }
    if (inputGain && comp) {
      try { inputGain.disconnect(comp); } catch (_) {}
      try { comp.disconnect(recorderNode); } catch (_) {}
    }
    if (recorderNode) {
      try { recorderNode.disconnect(); } catch (_) {}
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }

    startRecordButton.disabled   = false;
    stopRecordButton.disabled    = true;
    const hasData                = recordedChunks.length > 0;
    playButton.disabled          = !hasData;
    stopPlayButton.disabled      = true;
    downloadButton.disabled      = !hasData;

    if (recordSlider && startTs) {
      const elapsedSec = (performance.now() - startTs) / 1000;
      recordSlider.value = Math.min(elapsedSec, targetDurationSec).toFixed(3);
      if (recordElapsedEl) recordElapsedEl.textContent = secs1(elapsedSec);
    }
    startTs = 0;

    if (hasData) {
      try { ensureMP3Ready(); preparePlayerFromBlob(); }
      catch (e) { log('플레이어 준비 오류: ' + e.message); }
    } else {
      setPlayerEnabled(false);
      setPauseResumeState({ canPause: false, canResume: false });
      if (playerTimeEl) playerTimeEl.textContent = "0";
      if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";
    }

    log(`Recording stopped (${reason}). chunks=${recordedChunks.length}`);
  } catch (err) {
    console.error(err);
    log('오류: ' + err.message);
  }
};

// Playback / Pause / Resume
function ensurePlaybackObject() {
  if (playbackAudio) return;

  if (!mp3Blob) ensureMP3Ready();
  if (!lastObjectURL) lastObjectURL = URL.createObjectURL(mp3Blob);
  playbackAudio = new Audio(lastObjectURL);

  playbackAudio.addEventListener('loadedmetadata', () => {
    const dur = isFinite(playbackAudio.duration) ? playbackAudio.duration : 0;
    if (playerTimeEl) playerTimeEl.textContent = String(secs(dur));
    if (playerSlider) {
      playerSlider.max = String(dur || 0);
      if (!playerSlider.value) playerSlider.value = "0";
      setPlayerEnabled(true);
    }
    if (playerElapsedEl) playerElapsedEl.textContent = secs1(playbackAudio.currentTime || 0);
  }, { once: true });

  playbackAudio.addEventListener('timeupdate', () => {
    if (playerSlider && !playerSlider.disabled) {
      playerSlider.value = String(playbackAudio.currentTime || 0);
    }
    if (playerElapsedEl) playerElapsedEl.textContent = secs1(playbackAudio.currentTime || 0);
  });

  const onStopLike = () => {
    updatePlaybackUI(false);
    setPauseResumeState({ canPause: false, canResume: true }); // after stop, Resume(Play) is allowed
    if (playerSlider) playerSlider.value = "0";
    if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";
    log('Playback ended/stopped');
  };
  playbackAudio.addEventListener('ended', onStopLike);
  playbackAudio.addEventListener('pause', () => {
    if (playbackAudio && playbackAudio.currentTime > 0 && !playbackAudio.ended) {
      setPauseResumeState({ canPause: false, canResume: true });
    } else if (playbackAudio && playbackAudio.currentTime === 0) {
      onStopLike();
    }
  });
};

// Play button
playButton.addEventListener('click', () => {
  if (!recordedChunks.length && !mp3Blob) { log('재생할 데이터가 없습니다.'); return; }
  try {
    ensurePlaybackObject();
    playbackAudio.currentTime = 0;
    playbackAudio.play()
      .then(() => {
        updatePlaybackUI(true);
        setPauseResumeState({ canPause: true, canResume: false });
        log(`Playing MP3 (mono, ${MP3_KBPS}kbps)`);
      })
      .catch(err => {
        log('재생 오류: ' + err.message);
        updatePlaybackUI(false);
        setPauseResumeState({ canPause: false, canResume: true });
      });
  } catch (e) {
    console.error(e);
    log('MP3 재생 준비 오류: ' + e.message);
  }
});

// Pause button
pauseBtn.addEventListener('click', () => {
  if (!playbackAudio) return;
  try { playbackAudio.pause(); } catch (e) { log('Pause 오류: ' + e.message); }
});

// Resume button after recording (includes first play)
resumeBtn.addEventListener('click', () => {
  try {
    if (!recordedChunks.length && !mp3Blob) { log('재생할 데이터가 없습니다.'); return; }
    ensurePlaybackObject();
    const t = parseFloat(playerSlider?.value || "0");
    if (Number.isFinite(t)) playbackAudio.currentTime = Math.max(0, t);
    playbackAudio.play()
      .then(() => {
        updatePlaybackUI(true);
        setPauseResumeState({ canPause: true, canResume: false });
        log('Resume/Play');
      })
      .catch(err => log('Resume 오류: ' + err.message));
  } catch (e) {
    log('Resume 준비 오류: ' + e.message);
  }
});

// Stop playback button
stopPlayButton.addEventListener('click', () => {
  try {
    if (playbackAudio) {
      playbackAudio.pause();
      playbackAudio.currentTime = 0;   // full stop (back to start)
      updatePlaybackUI(false);
      setPauseResumeState({ canPause: false, canResume: true }); // Play allowed after stop
      if (playerSlider) playerSlider.value = "0";
      if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";
      log('Manual stop: playback stopped');
    } else {
      log('재생 중인 오디오가 없습니다.');
    }
  } catch (e) {
    console.error(e);
    log('재생 중지 오류: ' + e.message);
  }
});

// Seek with playback slider
playerSlider?.addEventListener('input', () => {
  if (!playerSlider || playerSlider.disabled) return;
  if (!playbackAudio) return;
  const t = parseFloat(playerSlider.value || "0");
  if (Number.isFinite(t)) {
    try {
      playbackAudio.currentTime = Math.max(0, t);
      if (playerElapsedEl) playerElapsedEl.textContent = secs1(playbackAudio.currentTime);
    } catch(_) {}
  }
});


// Other buttons / inputs
startRecordButton.addEventListener('click', startRecording);
stopRecordButton.addEventListener('click', () => stopRecording("user"));

// Manual adjustment of recording slider
recordSlider?.addEventListener('input', () => {
  if (!startTs) return;
  const elapsedSec = (performance.now() - startTs) / 1000;
  recordSlider.value = Math.min(elapsedSec, targetDurationSec).toFixed(3);
  if (recordElapsedEl) recordElapsedEl.textContent = secs1(elapsedSec);
});

// Recording time input
timeInput?.addEventListener('change', () => {
  const sec = parseInt(timeInput.value, 10) || 60;
  resetRecordSliderWithMax(Math.max(1, Math.min(3600, sec)));
});

// Download button
downloadButton.addEventListener('click', () => {
  if (!recordedChunks.length) { log('다운로드할 데이터가 없습니다.'); return; }
  try {
    ensureMP3Ready();
    if (!lastObjectURL) lastObjectURL = URL.createObjectURL(mp3Blob);
    const a = document.createElement('a');
    a.href = lastObjectURL;
    a.download = timestampFilename('recording', 'mp3');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => revokeLastURL(), 10_000);
    log('MP3 다운로드 시작');
  } catch (e) {
    console.error(e);
    log('다운로드 오류: ' + e.message);
  }
});
