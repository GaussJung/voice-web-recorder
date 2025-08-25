/**
 * myAudio-app.js
 * version: v1.09-a
 * description:
 *   App (UI) layer. "Wait then auto-record" + upload button behavior.
 *   Grabs the DOM and wires buttons/sliders/labels/logs to the engine.
 *   The engine (Recorder/Player) is event-driven and independent of the DOM.
 */

import { ENGINE_VERSION, Recorder, Player } from "./myAudio-engine.js?v=1.03";
import {
  PRESIGNED_URL_ENDPOINT,
  uploadBase64ToServer,
  uploadToS3,
  blobToBase64String,
  timestampFilename,
  timestampRandFilename,
} from "./myUploads.js?v=1.09";

const APP_VERSION = "v1.09-a";
const BASE_PROFILE = "voice";
console.log(`myAudio-app ${APP_VERSION}, engine=${ENGINE_VERSION}, profile=${BASE_PROFILE}`);

// DOM elements
const waitRecordButton   = document.getElementById("waitRecordButton");
const startRecordButton  = document.getElementById("startRecordButton");
const stopRecordButton   = document.getElementById("stopRecordButton");
const playButton         = document.getElementById("playButton");
const stopPlayButton     = document.getElementById("stopPlayButton");
const downloadButton     = document.getElementById("downloadButton");
const viewBase64Button   = document.getElementById("viewBase64Button");
const s3UploadButton     = document.getElementById("s3UploadButton");
const base64UploadButton = document.getElementById("base64UploadButton");
const logAreaEl          = document.getElementById("logArea");
const base64Textarea     = document.getElementById("base64audio");

// Wait slider / time input
const waitTimeInput   = document.getElementById("audioWaitTime");
const waitSlider      = document.getElementById("audioWaitSlider");
const waitElapsedEl   = document.getElementById("audioWaitElapsed");

// Recording slider / time input
const timeInput       = document.getElementById("audioRecordTime");
const recordSlider    = document.getElementById("audioRecordSlider");
const recordElapsedEl = document.getElementById("audioRecordElapsed");

// Playback duration/slider + controls
const playerTimeEl    = document.getElementById("audioPlayerTime");
const playerSlider    = document.getElementById("audioPlayerSlider");
const playerElapsedEl = document.getElementById("audioPlayerElapsed");
const pauseBtn        = document.getElementById("audioPauseButton");
const resumeBtn       = document.getElementById("audioResumeButton");

// Logging
function log(msg = "") {
  console.log(msg);
  if (!logAreaEl) return;
  logAreaEl.textContent += (typeof msg === "string" ? msg : String(msg)) + "\n";
}

const secs  = (n) => Math.max(0, Math.round(n));
const secs1 = (n) => Number.isFinite(n) ? `${(Math.floor(Math.max(0,n)*10)/10).toFixed(1)}s` : "0.0s";

// Enable/disable player
function setPlayerEnabled(enabled) {
  if (playerSlider) playerSlider.disabled = !enabled;
  if (!enabled) { pauseBtn.disabled = true; resumeBtn.disabled = true; }
}

// Pause/Resume button state
function setPauseResumeState({ canPause, canResume }) {
  pauseBtn.disabled  = !canPause;
  resumeBtn.disabled = !canResume;
}

// Play/Stop button state
function updatePlaybackUI(isPlaying) {
  if (isPlaying) {
    startRecordButton.disabled = true;
    waitRecordButton.disabled  = true;
    playButton.disabled        = true;
    stopPlayButton.disabled    = false;
  } else {
    startRecordButton.disabled = false;
    waitRecordButton.disabled  = false;
    const hasData = recorder.chunks.length > 0 || !!recorder.mp3Blob;
    playButton.disabled        = !hasData;
    stopPlayButton.disabled    = true;
  }
}

// Initialize recording slider
function resetRecordSliderWithMax(maxSec) {
  if (!recordSlider) return;
  recordSlider.min   = "0";
  recordSlider.max   = String(maxSec);
  recordSlider.value = "0";
  if (recordElapsedEl) recordElapsedEl.textContent = "0.0s";
}

// Initialize wait slider
function resetWaitSliderWithMax(maxSec) {
  if (!waitSlider) return;
  waitSlider.min   = "0";
  waitSlider.max   = String(maxSec);
  waitSlider.value = "0";
  if (waitElapsedEl) waitElapsedEl.textContent = "0.0s";
}

/* ===== Instantiate engine ===== */
// const recorder = new Recorder({ profile: "voice", kbps: 96 });
const recorder = new Recorder({ profile: BASE_PROFILE, kbps: 96 });
const player   = new Player();

// Initial setup
(function initSetup() {
  const initWait = parseInt(waitTimeInput?.value ?? "30", 10) || 30;
  resetWaitSliderWithMax(initWait);

  const initRec  = parseInt(timeInput?.value ?? "60", 10) || 60;
  resetRecordSliderWithMax(initRec);

  setPlayerEnabled(false);
  setPauseResumeState({ canPause: false, canResume: false });
  if (playerTimeEl)    playerTimeEl.textContent = "0";
  if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";

  log(`App ${APP_VERSION} ready for ${BASE_PROFILE} profile`);
})();

// Wait/record/play state variables
let isWaiting = false;
let waitStartTs = 0;
let waitTargetSec = 30;
let waitRafId = null;
let waitTimerId = null;

let recodingCount = 0;     // number of recordings (incremented on recording start or auto-start)
let currentUploadNum = 0;  // current upload count (incremented on upload)

// Clear wait timers/animation
function clearWaitTimers() {
  if (waitRafId) cancelAnimationFrame(waitRafId);
  waitRafId = null;
  clearTimeout(waitTimerId);
  waitTimerId = null;
}

// Animate wait slider
function animateWaitSlider() {
  if (!isWaiting || !waitStartTs) return;
  const elapsed = (performance.now() - waitStartTs) / 1000;
  if (waitSlider) waitSlider.value = Math.min(elapsed, waitTargetSec).toFixed(3);
  if (waitElapsedEl) waitElapsedEl.textContent = secs1(elapsed);
  if (elapsed >= waitTargetSec) return; // actual start is handled by setTimeout
  waitRafId = requestAnimationFrame(animateWaitSlider);
}

// Start recording (specified duration, default 60s)
async function startRecordingWithDuration(recDuration) {
  // If playing, stop and reset to 0
  player.stop();
  updatePlaybackUI(false);

  const desiredSeconds = Number.isFinite(recDuration) ? recDuration : parseInt(timeInput?.value ?? "60", 10);
  const target = Math.max(1, Math.min(3600, Number.isFinite(desiredSeconds) ? desiredSeconds : 60));
  resetRecordSliderWithMax(target);

  // Switch UI state
  startRecordButton.disabled   = true;
  waitRecordButton.disabled    = true;
  stopRecordButton.disabled    = false;   // recording "stop" button (disabled while waiting)
  playButton.disabled          = true;
  stopPlayButton.disabled      = true;
  downloadButton.disabled      = true;
  viewBase64Button.disabled    = true;
  s3UploadButton.disabled      = true;
  base64UploadButton.disabled  = true;
  setPlayerEnabled(false);
  setPauseResumeState({ canPause: false, canResume: false });
  if (playerTimeEl)    playerTimeEl.textContent = "0";
  if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";
  if (base64Textarea)  base64Textarea.value = "";

  try {
    await recorder.start({ durationSec: target });

    recodingCount++; // increment recording counter when a recording starts

    log(`▶ Recording started (profile=${BASE_PROFILE}, duration=${target}s)`);
  } catch (err) {
    log("Error: " + err.message);
    startRecordButton.disabled = false;
    waitRecordButton.disabled  = false;
    stopRecordButton.disabled  = true;
  }
}

// Start "wait then auto-record"
function startWaitThenRecord() {
  if (isWaiting) return; // prevent duplicate starts

  // Parse/clamp wait duration
  const desiredWait = parseInt(waitTimeInput?.value ?? "30", 10);
  waitTargetSec = Math.max(1, Math.min(3600, Number.isFinite(desiredWait) ? desiredWait : 30));
  resetWaitSliderWithMax(waitTargetSec);

  // Reset playback/recording state
  player.stop();
  // If a recording is in progress before waiting, stop it (prepare for new recording)
  try { recorder.stop("pre-wait"); } catch {}

  // UI: waiting started (no cancel -> keep stopRecordButton disabled)
  isWaiting = true;
  waitStartTs = performance.now();
  startRecordButton.disabled = true;
  waitRecordButton.disabled  = true;
  stopRecordButton.disabled  = true;   // always disabled during waiting (no cancel)
  playButton.disabled        = true;
  stopPlayButton.disabled    = true;
  downloadButton.disabled    = true;
  viewBase64Button.disabled  = true;
  s3UploadButton.disabled    = true;
  base64UploadButton.disabled= true;

  animateWaitSlider();
  clearTimeout(waitTimerId);
  waitTimerId = setTimeout(async () => {
    // Wait ends → auto start recording
    isWaiting = false;
    clearWaitTimers();
    if (waitSlider) waitSlider.value = String(waitTargetSec);
    if (waitElapsedEl) waitElapsedEl.textContent = secs1(waitTargetSec);

    log(`Wait finished (${waitTargetSec}s) → auto recording started`);

    const recDur = parseInt(timeInput?.value ?? "60", 10) || 60;
    await startRecordingWithDuration(recDur);
  }, waitTargetSec * 1000);

  log(`▶ Waiting started: auto recording in ${waitTargetSec}s`);
}

// Recorder progress event
recorder.addEventListener("progress", (e) => {
  const { elapsed, target } = e.detail;
  if (recordSlider) recordSlider.value = Math.min(elapsed, target).toFixed(3);
  if (recordElapsedEl) recordElapsedEl.textContent = secs1(elapsed);
});

// Recorder stopped event
recorder.addEventListener("stopped", async (e) => {
  const { reason, chunksLength } = e.detail;

  startRecordButton.disabled   = false;
  waitRecordButton.disabled    = false;
  stopRecordButton.disabled    = true;

  const hasData = chunksLength > 0;
  playButton.disabled          = !hasData;
  stopPlayButton.disabled      = true;
  downloadButton.disabled      = !hasData;
  viewBase64Button.disabled    = !hasData;
  s3UploadButton.disabled      = !hasData;
  base64UploadButton.disabled  = !hasData;

  if (hasData) {
    try {
      recorder.ensureMP3Ready();
      await player.loadFromBlob(recorder.mp3Blob);
      const dur = player.duration;
      if (playerTimeEl)    playerTimeEl.textContent = String(secs(dur));
      if (playerSlider)   { playerSlider.max = String(dur || 0); playerSlider.value = "0"; }
      if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";
      setPlayerEnabled(true);
      setPauseResumeState({ canPause: false, canResume: true });
    } catch (err) {
      log("Player preparation error: " + err.message);
      setPlayerEnabled(false);
      setPauseResumeState({ canPause: false, canResume: false });
    }
  } else {
    setPlayerEnabled(false);
    setPauseResumeState({ canPause: false, canResume: false });
    if (playerTimeEl)    playerTimeEl.textContent = "0";
    if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";
  }

  log(`Recording stopped (${reason}). chunks=${chunksLength}`);
});

// Recorder error event
recorder.addEventListener("error", (e) => {
  log("Recorder error: " + (e.detail?.message || ""));
});

// Player time update event
player.addEventListener("time", (e) => {
  const { currentTime } = e.detail;
  if (playerSlider && !playerSlider.disabled) playerSlider.value = String(currentTime || 0);
  if (playerElapsedEl) playerElapsedEl.textContent = secs1(currentTime || 0);
});

// Player paused/ended events
player.addEventListener("paused", () => {
  setPauseResumeState({ canPause: false, canResume: true });
});

// Player ended event
player.addEventListener("ended", () => {
  updatePlaybackUI(false);
  setPauseResumeState({ canPause: false, canResume: true });
  if (playerSlider)    playerSlider.value = "0";
  if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";
  log("Playback ended/stopped");
});

// "Wait then record" button: disabled while waiting
waitRecordButton.addEventListener("click", startWaitThenRecord);

// "Start recording" button: works only when not recording/waiting
startRecordButton.addEventListener("click", async () => {
  // Cannot start manual recording while waiting (no cancel)
  if (isWaiting) {
    log("Cannot start manual recording while waiting.");
    return;
  }
  const recDur = parseInt(timeInput?.value ?? "60", 10) || 60;
  await startRecordingWithDuration(recDur);
});

// "Stop recording" button: only while recording
stopRecordButton.addEventListener("click", () => {
  try {
    // Canceling waiting is not supported
    recorder.stop("user");
  } catch (e) {
    log("Stop error: " + e.message);
  }
});

// "Play" button: only when not playing and data exists
playButton.addEventListener("click", () => {
  player.play(0)
    .then(() => {
      updatePlaybackUI(true);
      setPauseResumeState({ canPause: true, canResume: false });
      log("Playing MP3");
    })
    .catch(err => {
      log("Playback error: " + err.message);
      updatePlaybackUI(false);
      setPauseResumeState({ canPause: false, canResume: true });
    });
});

// "Pause" button: only while playing
pauseBtn.addEventListener("click", () => { try { player.pause(); } catch (e) { log("Pause error: " + e.message); } });

// "Resume" button: only while paused
resumeBtn.addEventListener("click", () => {
  const t = parseFloat(playerSlider?.value || "0");
  player.play(Number.isFinite(t) ? Math.max(0, t) : 0)
    .then(() => {
      updatePlaybackUI(true);
      setPauseResumeState({ canPause: true, canResume: false });
      log("Resume/Play");
    })
    .catch(err => log("Resume error: " + err.message));
});

// "Stop" button: only while playing
stopPlayButton.addEventListener("click", () => {
  try {
    player.stop();
    updatePlaybackUI(false);
    setPauseResumeState({ canPause: false, canResume: true });
    if (playerSlider)    playerSlider.value = "0";
    if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";
    log("Manual stop: playback stopped");
  } catch (e) {
    log("Error while stopping playback: " + e.message);
  }
});

// Clamp slider input while waiting
waitSlider?.addEventListener("input", () => {
  if (!isWaiting) return;
  const elapsed = (performance.now() - waitStartTs) / 1000;
  waitSlider.value = Math.min(elapsed, waitTargetSec).toFixed(3);
  if (waitElapsedEl) waitElapsedEl.textContent = secs1(elapsed);
});

recordSlider?.addEventListener("input", () => {
  // Sync only during recording (engine updates via progress event)
});

// On time input change → update slider max
waitTimeInput?.addEventListener("change", () => {
  const sec = parseInt(waitTimeInput.value, 10) || 30;
  resetWaitSliderWithMax(Math.max(1, Math.min(3600, sec)));
});

// On time input change → update slider max
timeInput?.addEventListener("change", () => {
  const sec = parseInt(timeInput.value, 10) || 60;
  resetRecordSliderWithMax(Math.max(1, Math.min(3600, sec)));
});

// Download button: only when data exists
downloadButton.addEventListener("click", () => {
  try {
    recorder.ensureMP3Ready();
    const blob = recorder.mp3Blob;
    if (!blob) return log("No data to download.");

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = timestampFilename("recording", "mp3");
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    log("▶ Started MP3 download");
  } catch (e) {
    log("Download error: " + e.message);
  }
});

// "View Base64" button: only when data exists
viewBase64Button.addEventListener("click", async () => {
  try {
    recorder.ensureMP3Ready();
    const b64 = await blobToBase64String(recorder.mp3Blob);
    if (base64Textarea) base64Textarea.value = b64;
    log(`▶ Base64 length: ${b64.length}`);
  } catch (e) {
    log("Base64 conversion error: " + e.message);
  }
});

// Base URL for links shown in the page
const WEB_BASE_URL = "https://web.ebaeum.com";

/**
 * Append a link to #linkArea using the uploaded MP3 path (presignKey).
 * @param {string} mp3path - e.g., "voices/records/recording_20250823_222813_44178.mp3"
 */
function appendMp3Link(mp3path) {
  const linkArea = document.getElementById("linkArea");
  if (!linkArea) return;

  const mp3url = `${WEB_BASE_URL}/${mp3path}`;

  // One-row container
  const row = document.createElement("div");
  row.style.marginTop = "6px";

  // Hyperlink
  const a = document.createElement("a");
  a.href = mp3url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = `▶ Play uploaded MP3 (#${currentUploadNum})`;

  row.appendChild(a);

  // Append in chronological order; for newest-first, use linkArea.prepend above
  if (linkArea.firstChild) {
    linkArea.appendChild(row);
  } else {
    linkArea.prepend(row);
  }
}

// S3 upload click listener
s3UploadButton.addEventListener("click", async () => {
  if (recodingCount === 0) {
    alert("Please record before uploading!");
    return false;
  } else if (currentUploadNum === recodingCount) {
    alert("Already uploaded! Please record again before uploading.");
    return false;
  }

  try {
    recorder.ensureMP3Ready();

    // Generate S3 key path to upload (no leading "/"), e.g. records/recording_20250823_183409_12345.mp3
    // OLD timestamp const keynameValue = `records/${timestampFilename("recording", "mp3")}`;
    const keynameValue = `records/${timestampRandFilename("recording", "mp3")}`;

    // Final endpoint: PRESIGNED_URL_ENDPOINT from myUploads.js + voice recording upload path
    // e.g. "https://4748nqydud.execute-api.ap-northeast-2.amazonaws.com/voices"
    const voiceUploadEndpoint = PRESIGNED_URL_ENDPOINT + "/voices";

    const result = await uploadToS3(recorder.mp3Blob, {
      keyname: keynameValue,
      contentType: "audio/mpeg",
      endpoint: voiceUploadEndpoint
    });

    // Set current upload number
    currentUploadNum = recodingCount;

    log("▶ S3 upload succeeded. Key: " + result.presignKey);

    // Append playback link for the uploaded file
    appendMp3Link(result.presignKey);

  } catch (ex) {
    log("S3 upload error: " + ex.message);
  }
});

// Base64 upload listener
base64UploadButton.addEventListener("click", async () => {
  try {
    recorder.ensureMP3Ready();
    await uploadBase64ToServer(recorder.mp3Blob);
    log("▶ Base64 upload succeeded");
  } catch (ex) {
    log("Base64 upload error: " + ex.message);
  }
});
