/**
 * audioSlider.js
 * version: 1.06
 * description: 녹음 시간(초) 입력 + 진행 슬라이더(400~800px) + 시간 경과 시 자동 중지
 *
 * Change Log
 * - v1.06 (2025-08-22): #log → #logArea로 변경. JSON 로그 pretty-print(줄바꿈/들여쓰기) 적용.
 * - v1.05 (2025-08-22): 경과 시간(0.1초) 표시, 녹음 완료 후 audioResumeButton으로도 재생 가능
 * - v1.04 (2025-08-22): 변수명 리팩토링 want → desiredSeconds
 * - v1.03 (2025-08-22): 재생 시간 우측 Pause/Play 추가(일시정지/재개). 상단 Stop은 초기화 유지
 * - v1.02 (2025-08-22): 재생 시간 라벨/슬라이더 추가, 슬라이더 줄바꿈→CSS 마진
 * - v1.01 (2025-08-22): audioRecord.js 기능 포함 + 녹음시간 입력 + 진행 슬라이더 + 자동 중지
 */

// ===== 설정(엔드포인트) =====
const PRESIGNED_URL_ENDPOINT = "/api/presigned-url";
const BASE64_UPLOAD_ENDPOINT = "/api/upload-base64";
const version = "v1.06";
console.log(`audioSlider ${version}`);

// ===== DOM =====
const startRecordButton  = document.getElementById('startRecordButton');
const stopRecordButton   = document.getElementById('stopRecordButton');
const playButton         = document.getElementById('playButton');
const stopPlayButton     = document.getElementById('stopPlayButton');
const downloadButton     = document.getElementById('downloadButton');
const viewBase64Button   = document.getElementById('viewBase64Button');
const s3UploadButton     = document.getElementById('s3UploadButton');
const base64UploadButton = document.getElementById('base64UploadButton');
const logAreaEl          = document.getElementById('logArea');
const base64Textarea     = document.getElementById('base64audio');

// 녹음 슬라이더/시간 입력
const timeInput     = document.getElementById('audioRecordTime');
const recordSlider  = document.getElementById('audioRecordSlider');

// 재생 시간/슬라이더 + 제어
const playerTimeEl  = document.getElementById('audioPlayerTime');
const playerSlider  = document.getElementById('audioPlayerSlider');
const pauseBtn      = document.getElementById('audioPauseButton');
const resumeBtn     = document.getElementById('audioResumeButton');

// (추가) 경과 시간 표시 엘리먼트
const recordElapsedEl = document.getElementById('audioRecordElapsed');
const playerElapsedEl = document.getElementById('audioPlayerElapsed');

// ===== 캡처 프로필 =====
// const CAPTURE_PROFILE = "music"; // Gain 1.0
const CAPTURE_PROFILE = "voice";    // Gain 1.2 (20% 증폭)

// ===== 오디오 컨텍스트/노드 =====
let audioContext = null;
let mediaStream = null;
let mediaSourceNode = null;
let recorderNode = null;

// 입력 볼륨/컴프레서
let inputGain = null;
let comp = null;

// ===== 녹음 데이터/상태 =====
let recordedChunks = [];     // Float32Array[]
let sampleRate = 48000;      // 실제 audioContext.sampleRate로 대체
let mp3Blob = null;          // 인코딩 캐시
let lastObjectURL = null;    // 재생 URL 캐시
let playbackAudio = null;    // <audio> 재생 객체

// 녹음 슬라이더/자동중지 상태
let startTs = 0;
let targetDurationSec = 60;  // 최종 적용 녹음 시간(초)
let rafId = null;
let autoStopTimerId = null;

// ===== MP3 설정 =====
const MP3_CHANNELS = 1;      // mono
let MP3_KBPS = 128;          // 96(voice), 128(music)

/* ===== 유틸 ===== */
function log(msg = "") {
  console.log(msg);
  if (!logAreaEl) return;
  logAreaEl.textContent += (typeof msg === "string" ? msg : String(msg)) + "\n";
}
function logJSON(label, obj) {
  const pretty = JSON.stringify(obj, null, 2);
  log(`${label}:\n${pretty}`);
}
function secs(n) { return Math.max(0, Math.round(n)); }
function secs1(n) {
  if (!Number.isFinite(n)) return "0.0s";
  return `${Math.max(0, Math.floor(n * 10) / 10).toFixed(1)}s`; // 0.1초 단위
}

/* ===== 재생 제어 버튼 상태 ===== */
function setPlayerEnabled(enabled) {
  if (playerSlider) playerSlider.disabled = !enabled;
  if (!enabled) {
    pauseBtn.disabled  = true;
    resumeBtn.disabled = true;
  }
}
function setPauseResumeState({ canPause, canResume }) {
  if (pauseBtn)  pauseBtn.disabled  = !canPause;
  if (resumeBtn) resumeBtn.disabled = !canResume;
}

/* 재생 UI 상태 업데이트 (상단 버튼) */
function updatePlaybackUI(isPlaying) {
  if (isPlaying) {
    startRecordButton.disabled = true;    // 재생 중엔 녹음 시작 불가
    playButton.disabled        = true;
    stopPlayButton.disabled    = false;
  } else {
    startRecordButton.disabled = false;
    const hasData = recordedChunks.length > 0 || !!mp3Blob;
    playButton.disabled        = !hasData;
    stopPlayButton.disabled    = true;
  }
}

/* 초기 세팅 */
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
}
initSetup();

/* 제약 */
function buildAudioConstraints(profile) {
  if (profile === "music") {
    return { sampleRate: 48000, channelCount: MP3_CHANNELS, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  } else {
    return { sampleRate: 48000, channelCount: MP3_CHANNELS, echoCancellation: false, noiseSuppression: true, autoGainControl: false };
  }
}

/* 변환/인코딩 */
function float32ToInt16(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}
function mergeFloat32(chunks) {
  const total = chunks.reduce((acc, a) => acc + a.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const a of chunks) { out.set(a, offset); offset += a.length; }
  return out;
}
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
}
function revokeLastURL() {
  if (lastObjectURL) { URL.revokeObjectURL(lastObjectURL); lastObjectURL = null; }
}
function ensureMP3Ready() {
  if (!recordedChunks.length) throw new Error('인코딩할 오디오가 없습니다.');
  if (!mp3Blob) { mp3Blob = encodeMP3FromFloat32Chunks(recordedChunks, sampleRate, MP3_KBPS); }
}
function timestampFilename(prefix = 'recording', ext = 'mp3') {
  const d = new Date(), pad = (n)=>String(n).padStart(2,'0');
  return `${prefix}_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}
function blobToBase64String(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const s = String(r.result), i = s.indexOf(',');
      if (i === -1) return reject(new Error('Invalid data URL.'));
      resolve(s.slice(i + 1));
    };
    r.onerror = (e) => reject(e);
    r.readAsDataURL(blob);
  });
}

/* === Base64를 textarea에 표시 === */
async function viewAudioBase64() {
  ensureMP3Ready();
  const b64 = await blobToBase64String(mp3Blob);
  if (base64Textarea) base64Textarea.value = b64;
  log(`Base64 length: ${b64.length}`);
  return b64;
}

/* === Base64 업로드(JSON POST) === */
async function uploadBase64ToServer(endpoint = BASE64_UPLOAD_ENDPOINT) {
  ensureMP3Ready();
  const base64 = await viewAudioBase64();
  const filename = timestampFilename('recording', 'mp3');
  const res = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, data: base64 })
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const json = await res.json().catch(() => ({}));
  log(`✅ Base64 업로드 성공 (${filename})`);
  return json;
}

/* === S3 프리사인드 URL 업로드 === */
async function uploadToS3(mp3Blob) {
  const resp = await fetch(PRESIGNED_URL_ENDPOINT, { method: 'GET' });
  if (!resp.ok) throw new Error('프리사인드 URL 요청 실패');
  const { url, key } = await resp.json();
  if (!url) throw new Error('프리사인드 URL이 응답에 없습니다.');
  const putRes = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'audio/mpeg' }, body: mp3Blob });
  if (!putRes.ok) throw new Error(`S3 업로드 실패: ${putRes.status}`);
  log(`✅ S3 업로드 성공 (key: ${key || 'unknown'})`);
  return { key, url };
}

/* =========================
   슬라이더/자동 중지 관련(녹음)
========================= */
function resetRecordSliderWithMax(maxSec) {
  if (!recordSlider) return;
  recordSlider.min = "0";
  recordSlider.max = String(maxSec);
  recordSlider.value = "0";
  if (recordElapsedEl) recordElapsedEl.textContent = "0.0s";
}
function animateRecordSlider() {
  if (!startTs || !recordSlider) return;
  const now = performance.now();
  const elapsedSec = (now - startTs) / 1000;
  recordSlider.value = Math.min(elapsedSec, targetDurationSec).toFixed(3);
  if (recordElapsedEl) recordElapsedEl.textContent = secs1(elapsedSec);
  if (elapsedSec >= targetDurationSec) { stopRecording("auto-stop"); return; }
  rafId = requestAnimationFrame(animateRecordSlider);
}
function clearTimers() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  clearTimeout(autoStopTimerId);
  autoStopTimerId = null;
}

/* =========================
   재생 준비/메타데이터
========================= */
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
    }
    if (playerElapsedEl) playerElapsedEl.textContent = "0.0s";
    // 녹음 완료 이후: Resume(Play) 버튼 활성화(처음 재생도 가능)
    setPauseResumeState({ canPause: false, canResume: true });
    log(`Prepared player (duration=${dur.toFixed(3)}s)`);
  }, { once: true });
}

/* =========================
   녹음 시작/중지
========================= */
async function startRecording() {
  if (playbackAudio && !playbackAudio.paused) {
    playbackAudio.pause();
    playbackAudio.currentTime = 0;
    updatePlaybackUI(false);
  }

  // 입력값 파싱 (desiredSeconds)
  const desiredSeconds = parseInt(timeInput?.value ?? "60", 10);
  targetDurationSec = Number.isFinite(desiredSeconds) && desiredSeconds >= 1 ? desiredSeconds : 60;
  if (targetDurationSec > 3600) targetDurationSec = 3600;
  resetRecordSliderWithMax(targetDurationSec);

  revokeLastURL();
  mp3Blob = null;
  recordedChunks = [];
  if (base64Textarea) base64Textarea.value = '';
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
    }

    inputGain = audioContext.createGain();
    inputGain.gain.value = (CAPTURE_PROFILE === "voice") ? 1.2 : 1.0;

    comp = new DynamicsCompressorNode(audioContext, { threshold: -10, ratio: 3, attack: 0.003, release: 0.25, knee: 6 });

    recorderNode = new AudioWorkletNode(audioContext, 'recorder-worklet');
    recorderNode.port.onmessage = (event) => {
      const chunk = event.data;
      recordedChunks.push(new Float32Array(chunk));
    };

    mediaSourceNode.connect(inputGain).connect(comp).connect(recorderNode);
    recorderNode.connect(audioContext.destination); // 모니터링

    startRecordButton.disabled   = true;
    stopRecordButton.disabled    = false;
    playButton.disabled          = true;
    stopPlayButton.disabled      = true;
    downloadButton.disabled      = true;
    viewBase64Button.disabled    = true;
    s3UploadButton.disabled      = true;
    base64UploadButton.disabled  = true;

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
}

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
    viewBase64Button.disabled    = !hasData;
    s3UploadButton.disabled      = !hasData;
    base64UploadButton.disabled  = !hasData;

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
}

/* =========================
   재생/일시정지/재개
========================= */
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
    setPauseResumeState({ canPause: false, canResume: true }); // 정지 후에도 Resume(Play) 가능
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
}

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

pauseBtn.addEventListener('click', () => {
  if (!playbackAudio) return;
  try { playbackAudio.pause(); } catch (e) { log('Pause 오류: ' + e.message); }
});

// 녹음 완료 후에도 Resume 버튼으로 재생(처음 재생 포함)
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

stopPlayButton.addEventListener('click', () => {
  try {
    if (playbackAudio) {
      playbackAudio.pause();
      playbackAudio.currentTime = 0;   // 완전 정지(처음으로)
      updatePlaybackUI(false);
      setPauseResumeState({ canPause: false, canResume: true }); // 정지 후에도 Play 가능
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

// 재생 슬라이더로 시크(탐색)
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

/* =========================
   기타 버튼/입력
========================= */
startRecordButton.addEventListener('click', startRecording);
stopRecordButton.addEventListener('click', () => stopRecording("user"));

recordSlider?.addEventListener('input', () => {
  if (!startTs) return;
  const elapsedSec = (performance.now() - startTs) / 1000;
  recordSlider.value = Math.min(elapsedSec, targetDurationSec).toFixed(3);
  if (recordElapsedEl) recordElapsedEl.textContent = secs1(elapsedSec);
});

timeInput?.addEventListener('change', () => {
  const sec = parseInt(timeInput.value, 10) || 60;
  resetRecordSliderWithMax(Math.max(1, Math.min(3600, sec)));
});

/* ===== 다운로드/업로드 ===== */
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

viewBase64Button.addEventListener('click', async () => { try { await viewAudioBase64(); } catch (_) {} });
s3UploadButton.addEventListener('click', async () => { try { ensureMP3Ready(); await uploadToS3(mp3Blob); } catch (_) {} });
base64UploadButton.addEventListener('click', async () => { try { await uploadBase64ToServer(BASE64_UPLOAD_ENDPOINT); } catch (_) {} });
