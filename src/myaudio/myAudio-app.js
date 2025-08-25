/**
 * myAudio-app.js
 * version: v1.07-h
 * description:
 *   앱(UI) 레이어. '대기 후 자동 녹음' + 업로드 버튼 동작.
 *   DOM을 잡고 버튼/슬라이더/라벨/로그를 엔진에 연결합니다.
 *   엔진(Recorder/Player)은 DOM을 모르며, 이벤트로만 소통합니다.
 *
 * Change Log
 * - v1.06 (2025-08-22): S3 업로드 호출을 myUploads v1.06 인터페이스로 변경
 *                       (uploadToS3(blob, { keyname, endpoint?, contentType? })) / S3 key는 선행 "/" 없이 사용
 * - v1.04 (2025-08-22): '대기 취소' 제거. 대기 중에는 stop 버튼 비활성화, 레이블을 '녹음 중지'로 변경.
 * - v1.03 (2025-08-22): 대기 타이머/슬라이더/경과 표시 + 자동 녹음 시작 기능 추가
 * - v1.01: 초기 모듈화 버전
 */

import { ENGINE_VERSION, Recorder, Player } from "./myAudio-engine.js?v=1.03";
import {
  PRESIGNED_URL_ENDPOINT,
  uploadBase64ToServer,
  uploadToS3,
  blobToBase64String,
  timestampFilename,
  timestampRandFilename,
} from "./myUploads.js?v=1.07b";

const APP_VERSION = "v1.07-h";
const BASE_PROFILE = "voice"; 
console.log(`myAudio-app ${APP_VERSION}, engine=${ENGINE_VERSION}, profile=${BASE_PROFILE}`);

/* ===== DOM ===== */
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

// 대기 슬라이더/시간 입력
const waitTimeInput   = document.getElementById("audioWaitTime");
const waitSlider      = document.getElementById("audioWaitSlider");
const waitElapsedEl   = document.getElementById("audioWaitElapsed");

// 녹음 슬라이더/시간 입력
const timeInput       = document.getElementById("audioRecordTime");
const recordSlider    = document.getElementById("audioRecordSlider");
const recordElapsedEl = document.getElementById("audioRecordElapsed");

// 재생 시간/슬라이더 + 제어
const playerTimeEl    = document.getElementById("audioPlayerTime");
const playerSlider    = document.getElementById("audioPlayerSlider");
const playerElapsedEl = document.getElementById("audioPlayerElapsed");
const pauseBtn        = document.getElementById("audioPauseButton");
const resumeBtn       = document.getElementById("audioResumeButton");

/* ===== 로깅 유틸 ===== */
function log(msg = "") {
  console.log(msg);
  if (!logAreaEl) return;
  logAreaEl.textContent += (typeof msg === "string" ? msg : String(msg)) + "\n";
};

const secs  = (n) => Math.max(0, Math.round(n));
const secs1 = (n) => Number.isFinite(n) ? `${(Math.floor(Math.max(0,n)*10)/10).toFixed(1)}s` : "0.0s";
 
/* ===== UI 상태 유틸 ===== */
function setPlayerEnabled(enabled) {
  if (playerSlider) playerSlider.disabled = !enabled;
  if (!enabled) { pauseBtn.disabled = true; resumeBtn.disabled = true; }
};

function setPauseResumeState({ canPause, canResume }) {
  pauseBtn.disabled  = !canPause;
  resumeBtn.disabled = !canResume;
};

function updatePlaybackUI(isPlaying) {
  if (isPlaying) {
    startRecordButton.disabled = true;
    waitRecordButton.disabled  = true;
    playButton.disabled        = true;
    stopPlayButton.disabled    = false;
  } 
  else {
    startRecordButton.disabled = false;
    waitRecordButton.disabled  = false;
    const hasData = recorder.chunks.length > 0 || !!recorder.mp3Blob;
    playButton.disabled        = !hasData;
    stopPlayButton.disabled    = true;
  }
};

function resetRecordSliderWithMax(maxSec) {
  if (!recordSlider) return;
  recordSlider.min   = "0";
  recordSlider.max   = String(maxSec);
  recordSlider.value = "0";
  if (recordElapsedEl) recordElapsedEl.textContent = "0.0s";
};

function resetWaitSliderWithMax(maxSec) {
  if (!waitSlider) return;
  waitSlider.min   = "0";
  waitSlider.max   = String(maxSec);
  waitSlider.value = "0";
  if (waitElapsedEl) waitElapsedEl.textContent = "0.0s";
};

/* ===== 엔진 인스턴스 생성 ===== */
// const recorder = new Recorder({ profile: "voice", kbps: 96 });

const recorder = new Recorder({ profile: BASE_PROFILE, kbps: 128 });
const player   = new Player();

/* ===== 초기 세팅 ===== */
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

/* =========================
   대기(카운트다운) → 자동 녹음
   (대기 취소 없음)
========================= */
let isWaiting = false;
let waitStartTs = 0;
let waitTargetSec = 30;
let waitRafId = null;
let waitTimerId = null;

let recodingCount = 0;     // 녹음횟수(녹음시작 혹은 자동녹음시작시에 추가됨) 
let currentUploadNum = 0;  // 현재업로드횟수 (업로드시에 추가됨 )

function clearWaitTimers() {
  if (waitRafId) cancelAnimationFrame(waitRafId);
  waitRafId = null;
  clearTimeout(waitTimerId);
  waitTimerId = null;
};

function animateWaitSlider() {
  if (!isWaiting || !waitStartTs) return;
  const elapsed = (performance.now() - waitStartTs) / 1000;
  if (waitSlider) waitSlider.value = Math.min(elapsed, waitTargetSec).toFixed(3);
  if (waitElapsedEl) waitElapsedEl.textContent = secs1(elapsed);
  if (elapsed >= waitTargetSec) return; // setTimeout 쪽에서 실제 시작
  waitRafId = requestAnimationFrame(animateWaitSlider);
};

async function startRecordingWithDuration(recDuration) {
  // 재생 중이면 끊고 0으로
  player.stop();
  updatePlaybackUI(false);
  
  const desiredSeconds = Number.isFinite(recDuration) ? recDuration : parseInt(timeInput?.value ?? "60", 10);
  const target = Math.max(1, Math.min(3600, Number.isFinite(desiredSeconds) ? desiredSeconds : 60));
  resetRecordSliderWithMax(target);

  // UI 상태 전환
  startRecordButton.disabled   = true;
  waitRecordButton.disabled    = true;
  stopRecordButton.disabled    = false;   // 녹음 '중지' 버튼 (대기 중에는 비활성)
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

    recodingCount++; // 녹음이 시작되면 레코딩 카운트를 추가함 

    log(`▶ Recording started (profile=$(BASE_PROFILE), duration=${target}s)`);
  } catch (err) {
    log("오류: " + err.message);
    startRecordButton.disabled = false;
    waitRecordButton.disabled  = false;
    stopRecordButton.disabled  = true;
  }

};

function startWaitThenRecord() {

  if (isWaiting) return; // 중복 방지

  // 대기 시간 파싱/클램프
  const desiredWait = parseInt(waitTimeInput?.value ?? "30", 10);
  waitTargetSec = Math.max(1, Math.min(3600, Number.isFinite(desiredWait) ? desiredWait : 30));
  resetWaitSliderWithMax(waitTargetSec);

  // 재생/녹음 상태 정리
  player.stop();
  // 대기 시작 전에 진행 중 녹음이 있으면 중단 (새 녹음 대비)
  try { recorder.stop("pre-wait"); } catch {}

  // UI: 대기 시작 (대기 취소 없음 → stopRecordButton 비활성 유지)
  isWaiting = true;
  waitStartTs = performance.now();
  startRecordButton.disabled = true;
  waitRecordButton.disabled  = true;
  stopRecordButton.disabled  = true;   // ← 대기 중에는 항상 비활성화 (취소 불가)
  playButton.disabled        = true;
  stopPlayButton.disabled    = true;
  downloadButton.disabled    = true;
  viewBase64Button.disabled  = true;
  s3UploadButton.disabled    = true;
  base64UploadButton.disabled= true;

  animateWaitSlider();
  clearTimeout(waitTimerId);
  waitTimerId = setTimeout(async () => {
    // 대기 종료 → 자동 녹음 시작
    isWaiting = false;
    clearWaitTimers();
    if (waitSlider) waitSlider.value = String(waitTargetSec);
    if (waitElapsedEl) waitElapsedEl.textContent = secs1(waitTargetSec);
    
    log(`대기 완료(${waitTargetSec}s) → 자동 녹음 시작`);

    const recDur = parseInt(timeInput?.value ?? "60", 10) || 60;
    await startRecordingWithDuration(recDur);
  }, waitTargetSec * 1000);

  log(`▶ 대기 시작: ${waitTargetSec}s 후 자동 녹음`);

};

/* =========================
   녹음/정지
========================= */
recorder.addEventListener("progress", (e) => {
  const { elapsed, target } = e.detail;
  if (recordSlider) recordSlider.value = Math.min(elapsed, target).toFixed(3);
  if (recordElapsedEl) recordElapsedEl.textContent = secs1(elapsed);
});

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
      log("플레이어 준비 오류: " + err.message);
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

recorder.addEventListener("error", (e) => {
  log("Recorder error: " + (e.detail?.message || ""));
});

/* ===== Player 이벤트 ===== */
player.addEventListener("time", (e) => {
  const { currentTime } = e.detail;
  if (playerSlider && !playerSlider.disabled) playerSlider.value = String(currentTime || 0);
  if (playerElapsedEl) playerElapsedEl.textContent = secs1(currentTime || 0);
});
player.addEventListener("paused", () => {
  setPauseResumeState({ canPause: false, canResume: true });
});
player.addEventListener("ended", () => {
  updatePlaybackUI(false);
  setPauseResumeState({ canPause: false, canResume: true });
  if (playerSlider)    playerSlider.value = "0";
  if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";
  log("Playback ended/stopped");
});

/* ===== UI 핸들러 ===== */
waitRecordButton.addEventListener("click", startWaitThenRecord);

startRecordButton.addEventListener("click", async () => {
  // 대기 중에는 수동 녹음 불가 (취소 기능 없음)
  if (isWaiting) {
    log("대기 중에는 수동 녹음을 시작할 수 없습니다.");
    return;
  }
  const recDur = parseInt(timeInput?.value ?? "60", 10) || 60;
  await startRecordingWithDuration(recDur);
});

// '녹음 중지' 버튼: 녹음 중일 때만 동작
stopRecordButton.addEventListener("click", () => {
  try {
    // 대기 취소는 지원하지 않음
    recorder.stop("user");
  } catch (e) {
    log("정지 오류: " + e.message);
  }
});

playButton.addEventListener("click", () => {
  player.play(0)
    .then(() => {
      updatePlaybackUI(true);
      setPauseResumeState({ canPause: true, canResume: false });
      log("Playing MP3");
    })
    .catch(err => {
      log("재생 오류: " + err.message);
      updatePlaybackUI(false);
      setPauseResumeState({ canPause: false, canResume: true });
    });
});

pauseBtn.addEventListener("click", () => { try { player.pause(); } catch (e) { log("Pause 오류: " + e.message); } });
resumeBtn.addEventListener("click", () => {
  const t = parseFloat(playerSlider?.value || "0");
  player.play(Number.isFinite(t) ? Math.max(0, t) : 0)
    .then(() => {
      updatePlaybackUI(true);
      setPauseResumeState({ canPause: true, canResume: false });
      log("Resume/Play");
    })
    .catch(err => log("Resume 오류: " + err.message));
});

stopPlayButton.addEventListener("click", () => {
  try {
    player.stop();
    updatePlaybackUI(false);
    setPauseResumeState({ canPause: false, canResume: true });
    if (playerSlider)    playerSlider.value = "0";
    if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";
    log("Manual stop: playback stopped");
  } catch (e) {
    log("재생 중지 오류: " + e.message);
  }
});

// 슬라이더 입력 시 강제 보정
waitSlider?.addEventListener("input", () => {
  if (!isWaiting) return;
  const elapsed = (performance.now() - waitStartTs) / 1000;
  waitSlider.value = Math.min(elapsed, waitTargetSec).toFixed(3);
  if (waitElapsedEl) waitElapsedEl.textContent = secs1(elapsed);
});
recordSlider?.addEventListener("input", () => {
  // 녹음 중에만 경과값에 동기화 (엔진에서 progress 이벤트로 갱신)
});

// 시간 입력 변경 → 슬라이더 max 갱신
waitTimeInput?.addEventListener("change", () => {
  const sec = parseInt(waitTimeInput.value, 10) || 30;
  resetWaitSliderWithMax(Math.max(1, Math.min(3600, sec)));
});
timeInput?.addEventListener("change", () => {
  const sec = parseInt(timeInput.value, 10) || 60;
  resetRecordSliderWithMax(Math.max(1, Math.min(3600, sec)));
});

/* ===== 다운로드/업로드 ===== */
downloadButton.addEventListener("click", () => {
  try {
    recorder.ensureMP3Ready();
    const blob = recorder.mp3Blob;
    if (!blob) return log("다운로드할 데이터가 없습니다.");

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = timestampFilename("recording", "mp3");
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    log("▶ MP3 다운로드 시작");
  } catch (e) {
    log("다운로드 오류: " + e.message);
  }
});

viewBase64Button.addEventListener("click", async () => {
  try {
    recorder.ensureMP3Ready();
    const b64 = await blobToBase64String(recorder.mp3Blob);
    if (base64Textarea) base64Textarea.value = b64;
    log(`▶ Base64 length: ${b64.length}`);
  } catch (e) {
    log("Base64 변환 오류: " + e.message);
  }
});

// 보여주기 기본주소 
const WEB_BASE_URL = "https://web.ebaeum.com";
 

/**
 * 업로드된 mp3 경로(presignKey)를 받아 #linkArea에 링크 추가
 * @param {string} mp3path - 예: "voices/records/recording_20250823_222813_44178.mp3"
 */
function appendMp3Link(mp3path) {
  const linkArea = document.getElementById("linkArea");
  if (!linkArea) return;

  const mp3url = `${WEB_BASE_URL}/${mp3path}`;

  // 한 줄(행) 컨테이너
  const row = document.createElement("div");
  row.style.marginTop = "6px";

  // 하이퍼링크
  const a = document.createElement("a");
  a.href = mp3url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = `▶ ${currentUploadNum}차 업로드된 MP3 재생`;

  row.appendChild(a);

  //  시간순으로 appendChild / 최신순일경우 linkArea.prepend를 위에 
  if (linkArea.firstChild) {
    linkArea.appendChild(row);
  } else {
    linkArea.prepend(row);
  }
};
 
// S3업로드 리스너 
s3UploadButton.addEventListener("click", async () => {


  if ( recodingCount === 0 ) {
    alert("녹음을 진행한 후에 업로드 가능합니다!"); 
    return false; 
  }   
  else if ( currentUploadNum === recodingCount ) {
    alert("이미 업로드되었습니다! 추가적으로 녹음을 진행한 후에 업로드 해 주세요!"); 
    return false; 
  };  

  try {
    recorder.ensureMP3Ready();

    // 업로드할 S3 key 경로 생성 (선행 "/" 없음)  예시 : records/recording_20250823_183409_12345.mp3  
    // OLD 타임스템프 const keynameValue = `records/${timestampFilename("recording", "mp3")}`;
    const keynameValue = `records/${timestampRandFilename("recording", "mp3")}`;

    // 최종 EndPoint : myUploads.js의 PRESIGNED_URL_ENDPOINT + 음성녹음업로드경로 
    // ex : "https://4748nqydud.execute-api.ap-northeast-2.amazonaws.com/voices"; 
    const voiceUploadEndpoint =  PRESIGNED_URL_ENDPOINT + "/voices"; 

    const result = await uploadToS3(recorder.mp3Blob, {
      keyname: keynameValue,
      contentType: "audio/mpeg",
      endpoint: voiceUploadEndpoint
    });

    // 현재의 업로드 번호 
    currentUploadNum = recodingCount; 

    log("▶ S3 업로드 성공 Key: " + result.presignKey);

    // 업로드된 링크 재생링크 
    appendMp3Link(result.presignKey);

  } catch (ex) {
    log("S3 업로드 오류: " + ex.message);
  }
});

// Base64 업로드 리스너 
base64UploadButton.addEventListener("click", async () => {
  try {
    recorder.ensureMP3Ready();
    await uploadBase64ToServer(recorder.mp3Blob);
    log("▶ Base64 업로드 성공");
  } catch (ex) {
    log("Base64 업로드 오류: " + ex.message);
  }
});


 
