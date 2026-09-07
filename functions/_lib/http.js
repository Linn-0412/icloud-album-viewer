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

export function html(content, statusCode = 200, headers = {}) {
  return new Response(content, {
    status: statusCode,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

export function redirect(location, statusCode = 303, headers = {}) {
  return new Response(null, {
    status: statusCode,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

export async function readJsonBody(request, maxBytes = 1024 * 1024) {
  const text = await readTextBody(request, maxBytes);
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('JSONの形式が正しくありません。', 400);
  }
}

export async function readFormBody(request, maxBytes = 20 * 1024) {
  return new URLSearchParams(await readTextBody(request, maxBytes));
}

export async function readTextBody(request, maxBytes = 1024 * 1024) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    throw new AppError('リクエストが大きすぎます。', 413);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new AppError('リクエストが大きすぎます。', 413);
  }

  return text;
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

export function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }

  return cookies;
}

export function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
