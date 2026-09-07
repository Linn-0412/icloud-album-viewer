import { recognizeDateMarkers } from '../_lib/vision.js';
import { applyDateMarkers } from '../_lib/timeline.js';
import { handleError, json, readJsonBody } from '../_lib/http.js';

export async function onRequestPost(context) {
  try {
    const payload = await readJsonBody(context.request, 8 * 1024 * 1024);
    const photos = Array.isArray(payload.photos) ? payload.photos : [];
    const result = await recognizeDateMarkers(photos, context.env);

    return json({
      ...result,
      photos: applyDateMarkers(photos, result.markers, { mode: 'previous' })
    });
  } catch (error) {
    return handleError(error);
  }
}
