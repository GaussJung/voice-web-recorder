/**
 * myUploads.js
 * version: v1.09
 * description:
 *   Upload/File utility module. Separated from engine/app layers.
 *   - Request S3 presigned URL: POST (+ body: { keyname, contentType })
 *   - Simplified interface: only allow uploadToS3(blob, uploadParamObj)
 *   - Normalize key name via normalizeS3Key: remove leading "/" and collapse duplicate slashes
 */

// PRESIGNED_URL_ENDPOINT: Obtains a presigned URL for S3 uploads.
// The resulting URL allows object uploads for a limited time (e.g., 30 minutes).
console.log("myUploads v1.09");

// Default presign endpoint used when the caller does not provide one.
export const PRESIGNED_URL_ENDPOINT = "https://4748nqydud.execute-api.ap-northeast-2.amazonaws.com"; // example "/api/presigned-url"
export const BASE64_UPLOAD_ENDPOINT = "/api/upload-base64";

const DEFAULT_CONTENT_TYPE = "audio/mpeg";

/**
 * Return a random 5-digit string between 10000 and 99999
 * @returns {string}
 */
function generateRandomSuffix() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

/** Filename timestamp utility */
export function timestampFilename(prefix = "recording", ext = "mp3") {
  const d = new Date(), pad = (n)=>String(n).padStart(2, "0");
  return `${prefix}_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
};

/** Filename timestamp + random digits */
export function timestampRandFilename(prefix, ext) {
  const d = new Date(), pad = (n)=>String(n).padStart(2, "0");
  return `${prefix}_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${generateRandomSuffix()}.${ext}`;
};

/** Blob → base64 payload (only the dataURL body) */
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

/** Upload base64 to server */
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

/** S3 key normalization: remove leading "/", collapse duplicate slashes, trim spaces */
function normalizeS3Key(keyname) {
  if (typeof keyname !== "string") return keyname;
  return keyname.trim().replace(/^\/+/, "").replace(/\/{2,}/g, "/");
};

/**
 * Request a presigned URL (POST + JSON body).
 * The server is expected to always return JSON: { presignUrl: string, presignKey: string }.
 *
 * @param {string} keyname - S3 object key to upload (e.g., 'records/recording_20250822_162650.mp3')
 * @param {string} [endpoint=PRESIGNED_URL_ENDPOINT] - Presigned URL issuing endpoint
 * @param {string} [contentTypeValue=DEFAULT_CONTENT_TYPE] - Content-Type to upload with
 * @returns {Promise<{presignUrl: string, presignKey: string}>}
 */
export async function requestPresignedUrl(
  keyname,
  endpoint = PRESIGNED_URL_ENDPOINT,
  contentTypeValue = DEFAULT_CONTENT_TYPE
) {
  if (!keyname) throw new Error("keyname is required.");

  // Normalize key (e.g., remove leading slash)
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
    throw new Error(`Presigned URL request failed: ${resp.status} ${text}`);
  }

  // Parse JSON response (fixed spec: { presignUrl, presignKey })
  const data = await resp.json();
  const { presignUrl, presignKey } = data || {};
  
  if (typeof presignUrl !== "string" || !presignUrl) {
    throw new Error("Response missing a valid presignUrl.");
  }

  if (typeof presignKey !== "string" || !presignKey) {
    throw new Error("Response missing a valid presignKey.");
  }
 
  return { presignUrl, presignKey };
};

/**
 * Upload a Blob to S3 (object upload only).
 *
 * @param {Blob} blob - Blob to upload (required)
 * @param {object} uploadParamObj - Upload options object (required)
 * @param {string} uploadParamObj.keyname - S3 key to upload to (e.g., 'records/xxx.mp3')
 * @param {string} [uploadParamObj.endpoint] - Presigned URL endpoint (defaults to PRESIGNED_URL_ENDPOINT)
 * @param {string} [uploadParamObj.contentType] - Content-Type (defaults to DEFAULT_CONTENT_TYPE, e.g., audio/mpeg, image/jpeg)
 * @returns {Promise<{presignUrl: string, presignKey: string}>}
 */
export async function uploadToS3(blob, uploadParamObj) {
  if (!blob) throw new Error("No blob to upload.");

  if (!uploadParamObj || typeof uploadParamObj !== "object") {
    throw new Error("uploadParamObj is required.");
  }

  if (!uploadParamObj.keyname) {
    throw new Error("uploadParamObj.keyname is required.");
  }

  const endpoint = uploadParamObj.endpoint || PRESIGNED_URL_ENDPOINT;
  const keyname = normalizeS3Key(uploadParamObj.keyname);
  const contentType = uploadParamObj.contentType || DEFAULT_CONTENT_TYPE;
 
  // 1) Request a presigned URL
  const { presignUrl, presignKey } = await requestPresignedUrl(
    keyname,
    endpoint,
    contentType
  );
 
  // 2) PUT upload (Content-Type must match the one used to sign)
  const putRes = await fetch(presignUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: blob,
  });

  if (!putRes.ok) {
    throw new Error(`S3 upload failed: ${putRes.status}`);
  }

  return { presignUrl, presignKey };
};
