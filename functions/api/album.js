import { getAlbumEntry, getAlbumUrl, serializeAlbumEntry } from '../_lib/album-api.js';
import { handleError, json, readJsonBody } from '../_lib/http.js';

export async function onRequestPost(context) {
  try {
    const payload = await readJsonBody(context.request);
    const albumUrl = getAlbumUrl(payload, context.env);
    const { entry, cached } = await getAlbumEntry(context, albumUrl, payload.refresh === true);
    return json(serializeAlbumEntry(entry, cached));
  } catch (error) {
    return handleError(error);
  }
}
