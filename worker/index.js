import {
  getAlbumEntry,
  getAlbumUrl,
  loadAssetPhotos,
  serializeAlbumEntry
} from '../functions/_lib/album-api.js';
import { handleError, json, readJsonBody } from '../functions/_lib/http.js';
import { applyDateMarkers } from '../functions/_lib/timeline.js';
import { recognizeDateMarkers } from '../functions/_lib/vision.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json({
        hasDefaultAlbum: Boolean(env.ICLOUD_SHARED_ALBUM_URL),
        visionEnabled: Boolean(env.OPENAI_API_KEY),
        authEnabled: true,
        authMode: 'cloudflare-access',
        mailConfigured: false,
        user: await getAccessUser(request, ctx)
      });
    }

    if (url.pathname === '/api/album' && request.method === 'POST') {
      try {
        const payload = await readJsonBody(request);
        const albumUrl = getAlbumUrl(payload, env);
        const { entry, cached } = await getAlbumEntry({ request, env, ctx }, albumUrl, payload.refresh === true);
        return json(serializeAlbumEntry(entry, cached));
      } catch (error) {
        return handleError(error);
      }
    }

    if (url.pathname === '/api/assets' && request.method === 'POST') {
      try {
        const payload = await readJsonBody(request);
        const photos = await loadAssetPhotos({ request, env, ctx }, payload);
        return json({ photos });
      } catch (error) {
        return handleError(error);
      }
    }

    if (url.pathname === '/api/date-markers' && request.method === 'POST') {
      try {
        const payload = await readJsonBody(request, 8 * 1024 * 1024);
        const photos = Array.isArray(payload.photos) ? payload.photos : [];
        const result = await recognizeDateMarkers(photos, env);

        return json({
          ...result,
          photos: applyDateMarkers(photos, result.markers, { mode: 'previous' })
        });
      } catch (error) {
        return handleError(error);
      }
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};

async function getAccessUser(request, ctx) {
  if (ctx?.access) {
    const identity = await ctx.access.getIdentity().catch(() => null);
    if (identity?.email) {
      return {
        email: identity.email,
        role: 'member',
        isAdmin: false
      };
    }
  }

  const email = request.headers.get('cf-access-authenticated-user-email') || '';
  return email
    ? {
        email,
        role: 'member',
        isAdmin: false
      }
    : null;
}
