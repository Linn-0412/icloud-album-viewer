import { ICloudAlbumError } from './icloud.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-4.1-mini';
const DEFAULT_BATCH_SIZE = 8;
const MAX_IMAGES = 600;

export function extractResponseText(payload) {
  if (typeof payload.output_text === 'string') {
    return payload.output_text;
  }

  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') {
        chunks.push(content.text);
      } else if (typeof content.output_text === 'string') {
        chunks.push(content.output_text);
      }
    }
  }

  return chunks.join('\n');
}

export function parseJsonArray(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : parsed.results || [];
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) {
      throw new ICloudAlbumError('画像認識の応答をJSONとして読めませんでした。', 502);
    }

    return JSON.parse(match[0]);
  }
}

export function normalizeMarkerResult(result, allowedPhotoIds) {
  const photoId = String(result.photoId || result.id || '').trim();
  if (!allowedPhotoIds.has(photoId)) {
    return null;
  }

  const date = typeof result.date === 'string' ? result.date.trim() : null;
  const confidence = Math.max(0, Math.min(1, Number(result.confidence || 0)));

  return {
    photoId,
    isDateMarker: result.isDateMarker === true,
    date: date || null,
    confidence,
    text: typeof result.text === 'string' ? result.text.slice(0, 120) : ''
  };
}

async function requestVisionBatch(batch, env, model) {
  const content = [
    {
      type: 'input_text',
      text:
        'You are reading date separator images in a Japanese photo album. ' +
        'For each image, decide whether it is a date card or calendar page used as a separator. ' +
        'Read visible text only and ignore file metadata. ' +
        'Examples like "2026 year 9 month 6 Sunday" or Japanese "2026-nen 9-gatsu 6-nichi" must become "2026-09-06". ' +
        'Return only JSON: [{"photoId":"...","isDateMarker":true,"date":"YYYY-MM-DD","confidence":0.0,"text":"visible date text"}]. ' +
        'If an image is not clearly a single date separator, use isDateMarker:false and date:null.'
    }
  ];

  for (const photo of batch) {
    content.push({
      type: 'input_text',
      text: `Photo ID: ${photo.id}`
    });
    content.push({
      type: 'input_image',
      image_url: photo.url,
      detail: 'low'
    });
  }

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 1600,
      input: [
        {
          role: 'user',
          content
        }
      ]
    }),
    signal: AbortSignal.timeout(90_000)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error?.message || `OpenAI API returned HTTP ${response.status}`;
    throw new ICloudAlbumError(`画像認識に失敗しました: ${message}`, 502);
  }

  const text = extractResponseText(payload);
  const allowedPhotoIds = new Set(batch.map((photo) => photo.id));
  return parseJsonArray(text)
    .map((result) => normalizeMarkerResult(result, allowedPhotoIds))
    .filter(Boolean);
}

export async function recognizeDateMarkers(photos, env, options = {}) {
  if (!env.OPENAI_API_KEY) {
    throw new ICloudAlbumError('OPENAI_API_KEY が設定されていません。', 400);
  }

  const model = options.model || env.OPENAI_VISION_MODEL || DEFAULT_MODEL;
  const batchSize = Number(options.batchSize || env.OPENAI_MARKER_BATCH_SIZE || DEFAULT_BATCH_SIZE);
  const narrowedPhotos = photos.some((photo) => photo.isDateMarker) ? photos.filter((photo) => photo.isDateMarker) : photos;
  const candidates = narrowedPhotos
    .map((photo) => ({
      id: String(photo.id || '').trim(),
      url: photo.posterUrl || photo.gridUrl || photo.fullUrl || photo.url
    }))
    .filter((photo) => photo.id && photo.url)
    .slice(0, MAX_IMAGES);
  const results = [];

  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize);
    results.push(...(await requestVisionBatch(batch, env, model)));
  }

  return {
    model,
    scannedCount: candidates.length,
    markers: results
  };
}
