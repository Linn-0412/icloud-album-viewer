import { getAccessUser } from '../_lib/album-api.js';
import { json } from '../_lib/http.js';

export function onRequestGet({ request, env }) {
  return json({
    hasDefaultAlbum: Boolean(env.ICLOUD_SHARED_ALBUM_URL),
    authEnabled: true,
    authMode: 'cloudflare-access',
    mailConfigured: false,
    user: getAccessUser(request)
  });
}
