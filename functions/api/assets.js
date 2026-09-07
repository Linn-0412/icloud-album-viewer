import { loadAssetPhotos } from '../_lib/album-api.js';
import { handleError, json, readJsonBody } from '../_lib/http.js';

export async function onRequestPost(context) {
  try {
    const payload = await readJsonBody(context.request);
    const photos = await loadAssetPhotos(context, payload);
    return json({ photos });
  } catch (error) {
    return handleError(error);
  }
}
