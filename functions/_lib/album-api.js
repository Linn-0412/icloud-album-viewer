import { ICloudAlbumError, fetchSharedAlbumAssets, fetchSharedAlbumMetadata } from './icloud.js';

const DEFAULT_CACHE_TTL_SECONDS = 600;
const MAX_ASSET_IDS = 120;

export function getAlbumUrl(payload = {}, env = {}) {
  const albumUrl = String(payload.url || env.ICLOUD_SHARED_ALBUM_URL || '').trim();
  if (!albumUrl) {
    throw new ICloudAlbumError('iCloud共有アルバムのURLが設定されていません。', 400);
  }

  return albumUrl;
}

export function getAccessUser(request) {
  const email = request.headers.get('cf-access-authenticated-user-email') || '';
  const jwt = request.headers.get('cf-access-jwt-assertion') || '';

  return email || jwt
    ? {
        email: email || 'Cloudflare Access user',
        role: 'member',
        isAdmin: false
      }
    : null;
}

export async function getAlbumEntry(context, albumUrl, refresh = false) {
  const ttlSeconds = getCacheTtlSeconds(context.env);

  if (!refresh) {
    const cached = await readAlbumCache(albumUrl);
    if (cached) {
      return { entry: cached, cached: true };
    }
  }

  const album = await fetchSharedAlbumMetadata(albumUrl, context.env);
  const entry = {
    baseUrl: album.baseUrl,
    metadata: album.metadata,
    photos: album.photos,
    expiresAt: Date.now() + ttlSeconds * 1000,
    fetchedAt: new Date().toISOString()
  };

  await writeAlbumCache(albumUrl, entry, ttlSeconds);
  return { entry, cached: false };
}

export async function loadAssetPhotos(context, payload) {
  const albumUrl = getAlbumUrl(payload, context.env);
  const requestedIds = Array.isArray(payload.ids)
    ? [...new Set(payload.ids.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, MAX_ASSET_IDS)
    : [];

  if (requestedIds.length === 0) {
    return [];
  }

  const { entry } = await getAlbumEntry(context, albumUrl, false);
  const photosById = new Map(entry.photos.map((photo) => [photo.id, photo]));
  const missingIds = requestedIds.filter((id) => {
    const photo = photosById.get(id);
    return photo && !hasPhotoAssetUrls(photo);
  });

  if (missingIds.length > 0) {
    entry.photos = await fetchSharedAlbumAssets(entry.baseUrl, entry.photos, missingIds, context.env);
    entry.expiresAt = Date.now() + getCacheTtlSeconds(context.env) * 1000;
    await writeAlbumCache(albumUrl, entry, getCacheTtlSeconds(context.env));
  }

  const updatedPhotosById = new Map(entry.photos.map((photo) => [photo.id, photo]));
  return requestedIds
    .map((id) => updatedPhotosById.get(id))
    .filter(Boolean)
    .map(toPublicPhoto);
}

export function serializeAlbumEntry(entry, cached) {
  return {
    metadata: entry.metadata,
    photos: entry.photos.map(toPublicPhoto),
    cached,
    fetchedAt: entry.fetchedAt
  };
}

export function toPublicPhoto(photo) {
  const { derivatives, ...publicPhoto } = photo;
  return publicPhoto;
}

function hasPhotoAssetUrls(photo) {
  return Boolean(photo?.gridUrl || photo?.fullUrl || photo?.videoUrl);
}

function getCacheTtlSeconds(env = {}) {
  const value = Number(env.CACHE_TTL_SECONDS || DEFAULT_CACHE_TTL_SECONDS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_CACHE_TTL_SECONDS;
}

async function readAlbumCache(albumUrl) {
  if (!globalThis.caches?.default) {
    return null;
  }

  const response = await caches.default.match(getAlbumCacheRequest(albumUrl));
  if (!response) {
    return null;
  }

  const entry = await response.json().catch(() => null);
  if (!entry || !Array.isArray(entry.photos) || Number(entry.expiresAt || 0) <= Date.now()) {
    return null;
  }

  return entry;
}

async function writeAlbumCache(albumUrl, entry, ttlSeconds) {
  if (!globalThis.caches?.default) {
    return;
  }

  const response = new Response(JSON.stringify(entry), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${ttlSeconds}`
    }
  });
  await caches.default.put(getAlbumCacheRequest(albumUrl), response);
}

function getAlbumCacheRequest(albumUrl) {
  return new Request(`https://icloud-album-viewer.local/cache/album?url=${encodeURIComponent(albumUrl)}`);
}
