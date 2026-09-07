export class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
  }
}

export function json(payload, statusCode = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

export async function readJsonBody(request, maxBytes = 1024 * 1024) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    throw new AppError('リクエストが大きすぎます。', 413);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new AppError('リクエストが大きすぎます。', 413);
  }

  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('JSONの形式が不正です。', 400);
  }
}

export function handleError(error) {
  const statusCode = Number(error?.statusCode || 500);
  const safeStatusCode = statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
  const message = safeStatusCode >= 500
    ? 'サーバーエラーが発生しました。'
    : error.message || 'リクエストを処理できませんでした。';

  if (safeStatusCode >= 500) {
    console.error(error);
  }

  return json({ error: message }, safeStatusCode);
}
