/**
 * myUploads.js
 * version: v1.07-c
 * description:
 *   업로드/파일 유틸리티 모듈. 엔진/앱 레이어와 분리.
 *   - S3 프리사인드 URL 발급: POST(+body: {keyname, contentType})
 *   - 호출 인터페이스 단순화: uploadToS3(blob, uploadParamObj) 만 허용
 *   - keyname 정규화(normalizeS3Key)로 선행 "/" 제거 및 중복 슬래시 압축
 */

// PRESIGNED_URL_ENDPOINT : S3에 업로드를 위한 프리사인URL받아옮. 지정시간(예:30분)동안 객체 등록 가능 
console.log("myUpload v1.07-c"); 

// 프리사인 URL발급 엔드포인트 : 호출하는 쪽에서 endpoint없을시 기본으로 사용됨. 
export const PRESIGNED_URL_ENDPOINT = "https://4748nqydud.execute-api.ap-northeast-2.amazonaws.com"; // example "/api/presigned-url";
export const BASE64_UPLOAD_ENDPOINT = "/api/upload-base64";

const DEFAULT_CONTENT_TYPE = "audio/mpeg";


/**
 * 10000 ~ 99999 사이의 랜덤 5자리 숫자 반환
 * @returns {string}
 */
function generateRandomSuffix() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}


/** 파일명 타임스탬프 유틸 */
export function timestampFilename(prefix = "recording", ext = "mp3") {
  const d = new Date(), pad = (n)=>String(n).padStart(2, "0");
  return `${prefix}_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
};

/** 파일명 타임스탬프 + 랜덤숫자 */
export function timestampRandFilename(prefix, ext) {
  const d = new Date(), pad = (n)=>String(n).padStart(2, "0");
  return `${prefix}_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${generateRandomSuffix()}.${ext}`;
};

/** Blob → base64 payload (dataURL 본문만) */
export function blobToBase64String(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const s = String(r.result), i = s.indexOf(",");
      if (i === -1) return reject(new Error("Invalid data URL."));
      resolve(s.slice(i + 1));
    };
    r.onerror = (e) => reject(e);
    r.readAsDataURL(blob);
  });

};

/** 서버로 base64 업로드 */
export async function uploadBase64ToServer(blob, endpoint = BASE64_UPLOAD_ENDPOINT) {
  const base64 = await blobToBase64String(blob);
  const filename = timestampFilename("recording", "mp3");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, data: base64 })
  });

  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json().catch(() => ({}));

};

/** S3 Key 정규화: 선행 "/" 제거, 중복 슬래시 압축, 공백 트림 */
function normalizeS3Key(keyname) {
  if (typeof keyname !== "string") return keyname;
  return keyname.trim().replace(/^\/+/, "").replace(/\/{2,}/g, "/");
};

/**
 * 프리사인드 URL 요청 (POST + JSON body)
 * 서버는 항상 JSON 형태로 { presignUrl: string, presignKey: string } 를 반환한다고 가정.
 *
 * @param {string} keyname - 업로드할 S3 오브젝트 키 (예: 'records/recording_20250822_162650.mp3')
 * @param {string} [endpoint=PRESIGNED_URL_ENDPOINT] - 프리사인드 URL 발급 엔드포인트
 * @param {string} [contentTypeValue=DEFAULT_CONTENT_TYPE] - 업로드 컨텐츠 타입
 * @returns {Promise<{presignUrl: string, presignKey: string}>}
 */
export async function requestPresignedUrl(
  keyname,
  endpoint = PRESIGNED_URL_ENDPOINT,
  contentTypeValue = DEFAULT_CONTENT_TYPE
) {
 
  if (!keyname) throw new Error("keyname이 필요합니다.");

  // 왼편 슬래시(/) 제거 등 키 정규화
  const safeKeyValue = normalizeS3Key(keyname);
  console.log("E3-b safeKeyValue=" + safeKeyValue);

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keyname: safeKeyValue,
      contentType: contentTypeValue,
    }),
  });

 
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`프리사인드 URL 요청 실패: ${resp.status} ${text}`);
  }

  // JSON 응답 파싱 (스펙 고정: { presignUrl, presignKey })
  const data = await resp.json();
  const { presignUrl, presignKey } = data || {};
  
  if (typeof presignUrl !== "string" || !presignUrl) {
    throw new Error("응답에 유효한 presignUrl이 없습니다.");
  };

  if (typeof presignKey !== "string" || !presignKey) {
    throw new Error("응답에 유효한 presignKey가 없습니다.");
  };
 
  return { presignUrl, presignKey };
};

 
/**
 * Blob을 S3에 업로드 (객체 방식만 허용)
 *
 * @param {Blob} blob - 업로드할 Blob(필수)
 * @param {object} uploadParamObj - 업로드 옵션 객체(필수)
 * @param {string} uploadParamObj.keyname - 업로드할 S3 Key (예: 'records/xxx.mp3')
 * @param {string} [uploadParamObj.endpoint] - 프리사인드 URL 엔드포인트 (기본값 PRESIGNED_URL_ENDPOINT)
 * @param {string} [uploadParamObj.contentType] - Content-Type (기본값 DEFAULT_CONTENT_TYPE, ex: audio/mpeg, image/jpeg)
 * @returns {Promise<{presignUrl: string, presignKey: string}>}
 */
export async function uploadToS3(blob, uploadParamObj) {

  if (!blob) throw new Error("업로드할 blob이 없습니다.");

  if (!uploadParamObj || typeof uploadParamObj !== "object") {
    throw new Error("uploadParamObj 객체가 필요합니다.");
  }

  if (!uploadParamObj.keyname) {
    throw new Error("uploadParamObj.keyname은 필수입니다.");
  }

  const endpoint = uploadParamObj.endpoint || PRESIGNED_URL_ENDPOINT;
 
  const keyname = normalizeS3Key(uploadParamObj.keyname);
 
  const contentType = uploadParamObj.contentType || DEFAULT_CONTENT_TYPE;
 
  // 1) 프리사인드 URL 발급
  const { presignUrl, presignKey } = await requestPresignedUrl(
    keyname,
    endpoint,
    contentType
  );

  // console.log("E4 presignUrl=" + presignUrl + " / presignKey=" + presignKey);

  // 2) PUT 업로드 (서명에 사용한 Content-Type과 동일)
  const putRes = await fetch(presignUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: blob,
  });

  if (!putRes.ok) {
    throw new Error(`S3 업로드 실패: ${putRes.status}`);
  }

  return { presignUrl, presignKey };

};
