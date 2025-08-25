// Program : audioRecord.js 

// ===== 설정(엔드포인트) =====
const PRESIGNED_URL_ENDPOINT = "/api/presigned-url";   // 예: GET -> { url, key }
const BASE64_UPLOAD_ENDPOINT = "/api/upload-base64";   // 예: POST { filename, data }
const version = "v1.25";
console.log(`audioRecord ${version}`); 

// ===== DOM =====
const startRecordButton  = document.getElementById('startRecordButton');
const stopRecordButton   = document.getElementById('stopRecordButton');
const playButton         = document.getElementById('playButton');
const stopPlayButton     = document.getElementById('stopPlayButton');
const downloadButton     = document.getElementById('downloadButton');
const viewBase64Button   = document.getElementById('viewBase64Button');
const s3UploadButton     = document.getElementById('s3UploadButton');
const base64UploadButton = document.getElementById('base64UploadButton');
const logEl              = document.getElementById('log');
const base64Textarea     = document.getElementById('base64audio');

// ===== 캡처 프로필(시험 종류별) =====
// "voice": 말하기 시험(소음 ON, AGC OFF)
// "music": 음악 실기(원음 보존: 소음/에코/AGC OFF)
// const CAPTURE_PROFILE = "music"; // Gain 1.0
const CAPTURE_PROFILE = "voice"; // Gain 1.2 (20% 증폭)

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
let playbackAudio = null;    // <audio> 플레이어 인스턴스

// ===== MP3 설정 =====
const MP3_CHANNELS = 1;      // mono
// 64:전화수준, 96:평가용 균형, 128:여유 있는 고급
let MP3_KBPS = 128;
 
// ===== 유틸 =====
function log(msg) {
  console.log(msg);
  if (logEl) logEl.textContent += msg + '\n';
};

// 재생 UI 상태 업데이트
function updatePlaybackUI(isPlaying) {
  if (isPlaying) {
    startRecordButton.disabled = true;    // 재생 중엔 녹음 시작 불가
    playButton.disabled = true;
    stopPlayButton.disabled = false;
  } else {
    // 재생이 멈추면 녹음 시작 가능
    startRecordButton.disabled = false;
    const hasData = recordedChunks.length > 0 || !!mp3Blob;
    playButton.disabled = !hasData;
    stopPlayButton.disabled = true;
  }
}

function initSetup() {
  // === 초기1 : 기기/브라우저 기본 sampleRate 알림 ===
  (function showInitialSampleRateAlert() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const temp = new AC();
      const sr = temp.sampleRate;
      // alert(`이 기기의 브라우저 기본 sampleRate: ${sr} Hz`);
      log(`Initial detected device sampleRate: ${sr} Hz`);
      temp.close && temp.close();
    } catch (e) {
      log('초기 sampleRate 확인 중 오류: ' + e.message);
    }
  })();
  
  // 초기2 : 모드에 따른 품질 
  if ( CAPTURE_PROFILE === "voice" ) {
    MP3_KBPS = 96; 
  }
  else if ( CAPTURE_PROFILE === "music" ) {
    MP3_KBPS = 128; 
  }
  else {
    MP3_KBPS = 64;
  }; 	
  log(`SET To ${CAPTURE_PROFILE} : ${MP3_KBPS}`);
}; 

// 초기 설정 진행 
initSetup(); 

function buildAudioConstraints(profile) {
  if (profile === "music") {
    // 음악 실기: 원음 보존
    return {
      sampleRate: 48000,
      channelCount: MP3_CHANNELS, // 현재 인코더 모노
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };
  }
  else if (profile === "voice") {
    // voice: 말하기 시험(소음억제 ON, AGC OFF)
    return {
      sampleRate: 48000,
      channelCount: MP3_CHANNELS,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false
    };
  };
};

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
  for (const a of chunks) {
    out.set(a, offset);
    offset += a.length;
  }
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
  if (lastObjectURL) {
    URL.revokeObjectURL(lastObjectURL);
    lastObjectURL = null;
  }
}

function ensureMP3Ready() {
  if (!recordedChunks.length) throw new Error('인코딩할 오디오가 없습니다.');
  if (!mp3Blob) {
    mp3Blob = encodeMP3FromFloat32Chunks(recordedChunks, sampleRate, MP3_KBPS);
  }
}

function timestampFilename(prefix = 'recording', ext = 'mp3') {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const HH = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${prefix}_${yyyy}${MM}${dd}_${HH}${mm}${ss}.${ext}`;
}

function blobToBase64String(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result; // "data:audio/mpeg;base64,AAAA..."
      const commaIdx = String(dataUrl).indexOf(',');
      if (commaIdx === -1) return reject(new Error('Invalid data URL.'));
      resolve(String(dataUrl).slice(commaIdx + 1)); // base64 only
    };
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(blob);
  });
}

// === Base64를 textarea에 표시 ===
async function viewAudioBase64() {
  try {
    ensureMP3Ready();
    const b64 = await blobToBase64String(mp3Blob);
    if (base64Textarea) base64Textarea.value = b64;
    log(`Base64 length: ${b64.length}`);
    return b64;
  } catch (e) {
    console.error(e);
    log('Base64 변환 오류: ' + e.message);
    throw e;
  }
}

// === Base64 업로드(JSON POST) ===
async function uploadBase64ToServer(endpoint = BASE64_UPLOAD_ENDPOINT) {
  try {
    ensureMP3Ready();
    const base64 = await viewAudioBase64(); // textarea에도 표시됨
    const filename = timestampFilename('recording', 'mp3');

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, data: base64 })
    });

    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const json = await res.json().catch(() => ({}));
    log(`✅ Base64 업로드 성공 (${filename})`);
    return json;
  } catch (e) {
    console.error(e);
    log('Base64 업로드 오류: ' + e.message);
    throw e;
  }
}

// === S3 프리사인드 URL 업로드 ===
async function uploadToS3(mp3Blob) {
  try {
    const resp = await fetch(PRESIGNED_URL_ENDPOINT, { method: 'GET' });
    if (!resp.ok) throw new Error('프리사인드 URL 요청 실패');
    const { url, key } = await resp.json();
    if (!url) throw new Error('프리사인드 URL이 응답에 없습니다.');

    const putRes = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: mp3Blob,
    });
    if (!putRes.ok) throw new Error(`S3 업로드 실패: ${putRes.status}`);

    log(`✅ S3 업로드 성공 (key: ${key || 'unknown'})`);
    return { key, url };
  } catch (e) {
    console.error(e);
    log('S3 업로드 오류: ' + e.message);
    throw e;
  }
}

// ===== 버튼 이벤트 =====
startRecordButton.addEventListener('click', async () => {
  try {
    // 재생 중이면 녹음 시작 전에 재생을 멈춤
    if (playbackAudio && !playbackAudio.paused) {
      playbackAudio.pause();
      playbackAudio.currentTime = 0;
      updatePlaybackUI(false);
    }

    revokeLastURL();
    mp3Blob = null;
    recordedChunks = [];
    if (base64Textarea) base64Textarea.value = '';

    if (!audioContext) audioContext = new AudioContext();
    if (audioContext.state === 'suspended') await audioContext.resume();

    sampleRate = audioContext.sampleRate;
    log(`AudioContext sampleRate: ${sampleRate}`);
    log(`Capture profile: ${CAPTURE_PROFILE}`);

    // 워크릿 로드 (파일명: recorder-worklet.js)
    await audioContext.audioWorklet.addModule('recorder-worklet.js');
    log('AudioWorklet module loaded');

    // === 프로필별 getUserMedia 옵션 반영 ===
    const audioConstraints = buildAudioConstraints(CAPTURE_PROFILE);
    log('Request getUserMedia constraints: ' + JSON.stringify(audioConstraints));

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints
    });
    mediaSourceNode = audioContext.createMediaStreamSource(mediaStream);

    // 트랙에 한 번 더 제약 적용 시도 및 실제 설정 로깅
    const track = mediaStream.getAudioTracks()[0];
    if (track && track.applyConstraints) {
      try {
        await track.applyConstraints(audioConstraints);
      } catch (e) {
        log('applyConstraints 경고: ' + e.message);
      }
      if (track.getSettings) {
        const s = track.getSettings();
        log('Actual track settings: ' + JSON.stringify(s));
      }
    }

    // === 입력 게인 (모드별) ===
    inputGain = audioContext.createGain();
    if (CAPTURE_PROFILE === "voice") {
      inputGain.gain.value = 1.2;
    } else {
      inputGain.gain.value = 1.0;
    }

    // 컴프레서(클리핑 방지/레벨 안정화)
    comp = new DynamicsCompressorNode(audioContext, {
      threshold: -10,   // -10 dBFS 이상 신호가 들어오면 압축 시작
      ratio: 3,         // 3:1 비율로 압축
      attack: 0.003,    // 3ms 안에 빠르게 반응
      release: 0.25,    // 250ms 동안 서서히 풀림
      knee: 6           // 부드럽게 압축 시작 (soft knee)
    });

    // 워크릿 노드
    recorderNode = new AudioWorkletNode(audioContext, 'recorder-worklet');
    recorderNode.port.onmessage = (event) => {
      const chunk = event.data; // Float32Array (transfer된 버퍼)
      recordedChunks.push(new Float32Array(chunk));
    };

    // 체인: Mic → Gain(모드별) → Compressor → Worklet
    mediaSourceNode.connect(inputGain).connect(comp).connect(recorderNode);

    // 모니터링(원치 않으면 제거 가능)
    recorderNode.connect(audioContext.destination);

    // 버튼 상태
    startRecordButton.disabled   = true;
    stopRecordButton.disabled    = false;
    playButton.disabled          = true;
    stopPlayButton.disabled      = true;
    downloadButton.disabled      = true;
    viewBase64Button.disabled    = true;
    s3UploadButton.disabled      = true;
    base64UploadButton.disabled  = true;

    log(`Recording started (profile=${CAPTURE_PROFILE}, gain=${inputGain.gain.value}, compressor=ON)`);

  } catch (err) {
    console.error(err);
    log('오류: ' + err.message);
  }
});

stopRecordButton.addEventListener('click', () => {
  try {
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
    stopPlayButton.disabled      = true; // 녹음 종료 직후엔 재생 안 하는 상태
    downloadButton.disabled      = !hasData;
    viewBase64Button.disabled    = !hasData;
    s3UploadButton.disabled      = !hasData;
    base64UploadButton.disabled  = !hasData;

    log(`Recording stopped. chunks: ${recordedChunks.length}`);
  } catch (err) {
    console.error(err);
    log('오류: ' + err.message);
  }
});

playButton.addEventListener('click', () => {
  if (!recordedChunks.length && !mp3Blob) {
    log('재생할 데이터가 없습니다.');
    return;
  }
  try {
    if (!mp3Blob) {
      ensureMP3Ready();
    }
    // 이전 재생 객체 정리
    if (playbackAudio) {
      try { playbackAudio.pause(); } catch(_) {}
      playbackAudio = null;
    }

    if (!lastObjectURL) {
      lastObjectURL = URL.createObjectURL(mp3Blob);
    }
    playbackAudio = new Audio(lastObjectURL);

    // 재생 완료/중단 시 UI 복구
    const onStopLike = () => {
      updatePlaybackUI(false);
      log('Playback ended/stopped');
    };
    playbackAudio.addEventListener('ended', onStopLike);
    playbackAudio.addEventListener('pause', () => {
      if (playbackAudio && playbackAudio.currentTime === 0) {
        onStopLike();
      }
    });

    playbackAudio.play()
      .then(() => {
        updatePlaybackUI(true);
        log(`Playing MP3 (mono, ${MP3_KBPS}kbps)`);
      })
      .catch((err) => {
        log('재생 오류: ' + err.message);
        updatePlaybackUI(false);
      });
  } catch (e) {
    console.error(e);
    log('MP3 인코딩/재생 오류: ' + e.message);
  }
});

stopPlayButton.addEventListener('click', () => {
  try {
    if (playbackAudio) {
      // 완전 정지: 일시정지 + 위치 초기화
      playbackAudio.pause();
      playbackAudio.currentTime = 0;
      updatePlaybackUI(false);
      log('Manual stop: playback stopped');
    } else {
      log('재생 중인 오디오가 없습니다.');
    }
  } catch (e) {
    console.error(e);
    log('재생 중지 오류: ' + e.message);
  }
});

downloadButton.addEventListener('click', () => {
  if (!recordedChunks.length) {
    log('다운로드할 데이터가 없습니다.');
    return;
  }
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

viewBase64Button.addEventListener('click', async () => {
  try {
    await viewAudioBase64();
  } catch (_) { /* 로그에 이미 출력됨 */ }
});

s3UploadButton.addEventListener('click', async () => {
  try {
    ensureMP3Ready();
    await uploadToS3(mp3Blob);
  } catch (_) { /* 로그에 이미 출력됨 */ }
});

base64UploadButton.addEventListener('click', async () => {
  try {
    await uploadBase64ToServer(BASE64_UPLOAD_ENDPOINT);
  } catch (_) { /* 로그에 이미 출력됨 */ }
});
