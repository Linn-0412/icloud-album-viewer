import { applyInferredDateCards } from './timeline.js';

const BASE_62_CHAR_SET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const APPLE_HEADERS = {
  Origin: 'https://www.icloud.com',
  'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Content-Type': 'text/plain',
  Accept: '*/*',
  Referer: 'https://www.icloud.com/sharedalbum/'
};

const ASSET_BATCH_SIZE = 25;
const DEFAULT_ICLOUD_TIMEOUT_MS = 120_000;
const DEFAULT_ASSET_CONCURRENCY = 1;
const DEFAULT_ASSET_BATCH_DELAY_MS = 300;
const DEFAULT_ICLOUD_RETRIES = 4;
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504, 509]);

export class ICloudAlbumError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'ICloudAlbumError';
    this.statusCode = statusCode;
  }
}

export function parsePublicToken(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    throw new ICloudAlbumError('iCloud共有アルバムのURLを入力してください。', 400);
  }

  let candidate = raw;
  try {
    const withProtocol = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withProtocol);
    if (url.hash) {
      candidate = url.hash.slice(1);
    } else {
      const parts = url.pathname.split('/').filter(Boolean);
      candidate = parts[parts.length - 1] || raw;
    }
  } catch {
    candidate = raw.replace(/^#/, '');
  }

  const token = decodeURIComponent(candidate)
    .replace(/^#/, '')
    .split('?')[0]
    .split('&')[0]
    .split(';')[0]
    .trim();

  if (token.length < 3 || !/^[0-9A-Za-z;._-]+$/.test(token)) {
    throw new ICloudAlbumError('共有アルバムURLから有効なトークンを読み取れませんでした。', 400);
  }

  return token;
}

export function getBaseUrl(token) {
  const partitionValue = token[0] === 'A' ? token[1] : token.slice(1, 3);
  const serverPartition = base62ToInt(partitionValue);
  const paddedPartition = serverPartition < 10 ? `0${serverPartition}` : String(serverPartition);
  return `https://p${paddedPartition}-sharedstreams.icloud.com/${token}/sharedstreams/`;
}

function base62ToInt(value) {
  return [...value].reduce((total, char) => {
    const index = BASE_62_CHAR_SET.indexOf(char);
    if (index < 0) {
      throw new ICloudAlbumError('共有アルバムトークンの形式が不正です。', 400);
    }

    return total * 62 + index;
  }, 0);
}

async function postAppleJson(url, payload, env = {}) {
  const retryCount = Math.max(0, getEnvNumber(env, 'ICLOUD_REQUEST_RETRIES', DEFAULT_ICLOUD_RETRIES));
  let lastError = null;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      return await postAppleJsonOnce(url, payload, env);
    } catch (error) {
      lastError = error;
      if (attempt >= retryCount || !isRetryableICloudError(error)) {
        throw error;
      }

      await sleep(getRetryDelayMs(attempt, error));
    }
  }

  throw lastError;
}

async function postAppleJsonOnce(url, payload, env = {}) {
  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: APPLE_HEADERS,
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: createTimeoutSignal(getEnvNumber(env, 'ICLOUD_REQUEST_TIMEOUT_MS', DEFAULT_ICLOUD_TIMEOUT_MS))
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      const timeoutError = new ICloudAlbumError('iCloud request timed out.', 504);
      timeoutError.retryable = true;
      throw timeoutError;
    }

    throw error;
  }

  const bodyText = await response.text();
  let body = {};

  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new ICloudAlbumError('iCloudからJSONではない応答が返りました。', 502);
    }
  }

  if (response.status >= 400) {
    const error = new ICloudAlbumError(`iCloudからエラー応答が返りました。HTTP ${response.status}`, 502);
    error.appleStatusCode = response.status;
    error.retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    throw error;
  }

  return { status: response.status, body };
}

function createTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

function isRetryableICloudError(error) {
  return error?.retryable === true || RETRYABLE_HTTP_STATUSES.has(Number(error?.appleStatusCode));
}

function parseRetryAfterMs(value) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = new Date(value).getTime();
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function getRetryDelayMs(attempt, error) {
  if (Number.isFinite(error?.retryAfterMs)) {
    return Math.min(error.retryAfterMs, 15_000);
  }

  return Math.min(600 * 2 ** attempt, 5_000);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWebstream(baseUrl, token, env = {}) {
  const firstResponse = await postAppleJson(`${baseUrl}webstream`, { streamCtag: null }, env);
  if (firstResponse.status !== 330) {
    return { baseUrl, body: firstResponse.body };
  }

  const redirectedHost = firstResponse.body && firstResponse.body['X-Apple-MMe-Host'];
  if (!redirectedHost) {
    throw new ICloudAlbumError('iCloudのリダイレクト先を取得できませんでした。', 502);
  }

  const redirectedBaseUrl = `https://${redirectedHost}/${token}/sharedstreams/`;
  const redirectedResponse = await postAppleJson(`${redirectedBaseUrl}webstream`, { streamCtag: null }, env);
  return { baseUrl: redirectedBaseUrl, body: redirectedResponse.body };
}

async function fetchAssetUrls(baseUrl, photoGuids, env = {}) {
  const urlsByChecksum = new Map();
  const batches = [];
  const batchDelayMs = Math.max(0, getEnvNumber(env, 'ICLOUD_ASSET_BATCH_DELAY_MS', DEFAULT_ASSET_BATCH_DELAY_MS));

  for (let index = 0; index < photoGuids.length; index += ASSET_BATCH_SIZE) {
    batches.push(photoGuids.slice(index, index + ASSET_BATCH_SIZE));
  }

  await runWithConcurrency(
    batches,
    getEnvNumber(env, 'ICLOUD_ASSET_CONCURRENCY', DEFAULT_ASSET_CONCURRENCY),
    async (batch) => {
      const response = await postAppleJson(`${baseUrl}webasseturls`, { photoGuids: batch }, env);
      const items = response.body.items || {};

      for (const [checksum, item] of Object.entries(items)) {
        if (item && item.url_location && item.url_path) {
          urlsByChecksum.set(checksum, `https://${item.url_location}${item.url_path}`);
        }
      }

      if (batchDelayMs > 0) {
        await sleep(batchDelayMs);
      }
    }
  );

  return urlsByChecksum;
}

async function runWithConcurrency(items, concurrency, worker) {
  const workerCount = Math.max(1, Math.min(Number.isFinite(concurrency) ? concurrency : DEFAULT_ASSET_CONCURRENCY, items.length));
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await worker(item);
      }
    })
  );
}

function toEpoch(value) {
  if (!value) {
    return null;
  }

  const epoch = new Date(value).getTime();
  return Number.isFinite(epoch) ? epoch : null;
}

export function parseDateInfo(photo) {
  const capturedAtEpoch =
    toEpoch(photo.dateCreated) ??
    toEpoch(photo.batchDateCreated) ??
    toEpoch(photo.createdDate) ??
    toEpoch(photo.addedDate);

  return {
    capturedAt: capturedAtEpoch ? new Date(capturedAtEpoch).toISOString() : null,
    capturedAtEpoch
  };
}

function normalizeDerivative(key, derivative, urlsByChecksum) {
  const width = Number(derivative.width || 0);
  const height = Number(derivative.height || 0);
  const fileSize = Number(derivative.fileSize || 0);
  const checksum = derivative.checksum;
  const url = checksum ? urlsByChecksum.get(checksum) || null : null;
  const extension = getUrlExtension(url) || getKeyExtension(key);

  return {
    key,
    checksum,
    width,
    height,
    fileSize,
    url,
    kind: getDerivativeKind(key, extension),
    extension
  };
}

function getUrlExtension(url) {
  if (!url) {
    return '';
  }

  try {
    const pathname = new URL(url).pathname;
    const extension = pathname.split('.').pop() || '';
    return extension.toLowerCase();
  } catch {
    const cleanUrl = String(url).split('?')[0];
    return (cleanUrl.split('.').pop() || '').toLowerCase();
  }
}

function getKeyExtension(key) {
  const cleanKey = String(key || '').split('?')[0].split('#')[0];
  if (!cleanKey.includes('.')) {
    return '';
  }

  return (cleanKey.split('.').pop() || '').toLowerCase();
}

function getDerivativeKind(key, extension) {
  const normalizedKey = String(key || '').toLowerCase();
  if (normalizedKey.includes('poster') || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(extension)) {
    return 'image';
  }

  if (['mp4', 'mov', 'm4v'].includes(extension) || normalizedKey.includes('video') || normalizedKey.endsWith('p')) {
    return 'video';
  }

  return 'image';
}

function selectGridDerivative(derivatives) {
  const available = derivatives.filter((derivative) => derivative.url);
  if (available.length === 0) {
    return null;
  }

  const sorted = [...available].sort((a, b) => a.width * a.height - b.width * b.height);
  return sorted.find((derivative) => Math.max(derivative.width, derivative.height) >= 420) || sorted[sorted.length - 1];
}

function selectFullDerivative(derivatives) {
  const available = derivatives.filter((derivative) => derivative.url);
  if (available.length === 0) {
    return null;
  }

  return [...available].sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

function buildSrcSet(derivatives) {
  return derivatives
    .filter((derivative) => derivative.url && derivative.width)
    .sort((a, b) => a.width - b.width)
    .map((derivative) => `${derivative.url} ${derivative.width}w`)
    .join(', ');
}

function selectVideoDerivative(derivatives) {
  const available = derivatives.filter((derivative) => derivative.url && derivative.kind === 'video');
  if (available.length === 0) {
    return null;
  }

  return [...available].sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

export function normalizePhoto(photo, index, urlsByChecksum) {
  const derivatives = Object.entries(photo.derivatives || {})
    .map(([key, derivative]) => normalizeDerivative(key, derivative, urlsByChecksum));
  const isVideo = photo.mediaAssetType === 'video';
  const largestDerivative = selectLargestDerivative(derivatives);
  const dateInfo = parseDateInfo(photo);

  return selectPhotoAssets({
    id: photo.photoGuid || `photo-${index}`,
    index,
    caption: photo.caption || '',
    contributor: photo.contributorFullName || [photo.contributorFirstName, photo.contributorLastName].filter(Boolean).join(' '),
    width: Number(photo.width || largestDerivative?.width || 0),
    height: Number(photo.height || largestDerivative?.height || 0),
    type: isVideo ? 'video' : 'image',
    capturedAt: dateInfo.capturedAt,
    capturedAtEpoch: dateInfo.capturedAtEpoch,
    derivatives
  });
}

function selectLargestDerivative(derivatives) {
  return [...derivatives].sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
}

function selectPhotoAssets(photo) {
  const derivatives = photo.derivatives || [];
  const isVideo = photo.type === 'video';
  const imageDerivatives = derivatives.filter((derivative) => derivative.kind === 'image');
  const grid = selectGridDerivative(isVideo ? imageDerivatives : derivatives);
  const full = isVideo ? selectVideoDerivative(derivatives) : selectFullDerivative(derivatives);
  const poster = isVideo ? grid : null;

  return {
    ...photo,
    width: Number(photo.width || full?.width || grid?.width || 0),
    height: Number(photo.height || full?.height || grid?.height || 0),
    gridUrl: poster?.url || grid?.url || full?.url || null,
    fullUrl: full?.url || grid?.url || null,
    posterUrl: poster?.url || null,
    videoUrl: isVideo ? full?.url || null : null,
    srcset: buildSrcSet(isVideo ? imageDerivatives : derivatives),
    derivatives
  };
}

export function applyAssetUrlsToPhoto(photo, urlsByChecksum) {
  const derivatives = (photo.derivatives || []).map((derivative) => {
    const url = derivative.checksum ? urlsByChecksum.get(derivative.checksum) || derivative.url || null : derivative.url || null;
    const extension = getUrlExtension(url) || derivative.extension || getKeyExtension(derivative.key);

    return {
      ...derivative,
      url,
      extension,
      kind: getDerivativeKind(derivative.key, extension)
    };
  });

  return selectPhotoAssets({
    ...photo,
    derivatives
  });
}

export function sortPhotos(photos, direction = 'asc') {
  const multiplier = direction === 'desc' ? -1 : 1;

  return [...photos].sort((a, b) => {
    const aTime = a.effectiveCapturedAtEpoch ?? a.capturedAtEpoch ?? Number.MAX_SAFE_INTEGER;
    const bTime = b.effectiveCapturedAtEpoch ?? b.capturedAtEpoch ?? Number.MAX_SAFE_INTEGER;
    if (aTime !== bTime) {
      return (aTime - bTime) * multiplier;
    }

    return (a.index - b.index) * multiplier;
  });
}

export async function fetchSharedAlbumMetadata(input, env = {}) {
  const token = parsePublicToken(input);
  const initialBaseUrl = getBaseUrl(token);
  const webstream = await fetchWebstream(initialBaseUrl, token, env);
  const photos = Array.isArray(webstream.body.photos) ? webstream.body.photos : [];
  const normalizedPhotos = photos.map((photo, index) => normalizePhoto(photo, index, new Map()));
  const timeline = applyInferredDateCards(normalizedPhotos);

  return {
    baseUrl: webstream.baseUrl,
    metadata: {
      streamName: webstream.body.streamName || 'iCloud共有アルバム',
      ownerName: [webstream.body.userFirstName, webstream.body.userLastName].filter(Boolean).join(' '),
      streamCtag: webstream.body.streamCtag || null,
      itemCount: timeline.photos.length,
      dateCardCount: timeline.markers.length
    },
    photos: sortPhotos(timeline.photos, 'asc')
  };
}

export async function fetchSharedAlbumAssets(baseUrl, photos, photoIds, env = {}) {
  const requestedIds = new Set((photoIds || []).map((photoId) => String(photoId || '').trim()).filter(Boolean));
  if (!baseUrl || requestedIds.size === 0) {
    return photos;
  }

  const targetPhotos = photos.filter((photo) => requestedIds.has(photo.id));
  const photoGuids = targetPhotos.map((photo) => photo.id).filter(Boolean);
  const urlsByChecksum = await fetchAssetUrls(baseUrl, photoGuids, env);
  const updatedById = new Map(
    targetPhotos.map((photo) => [photo.id, applyAssetUrlsToPhoto(photo, urlsByChecksum)])
  );

  return photos.map((photo) => updatedById.get(photo.id) || photo);
}

function getEnvNumber(env, key, fallback) {
  const value = Number(env?.[key]);
  return Number.isFinite(value) ? value : fallback;
}
