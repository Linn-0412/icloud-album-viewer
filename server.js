const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

loadEnvFile();

const { fetchSharedAlbumMetadata, fetchSharedAlbumAssets, ICloudAlbumError } = require('./src/icloud');
const { AccountError, AccountStore } = require('./src/accounts');
const { isMailConfigured, sendInvitationEmail } = require('./src/mailer');
const { DEFAULT_ALBUM_URL } = require('./src/site-config');

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 60) * 1000;
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 7 * 24 * 60 * 60);
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const SESSION_SECRET = process.env.ALBUM_VIEWER_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'album_viewer_session';
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

const accountStore = new AccountStore();
const albumCache = new Map();
const sessions = new Map();
const loginFailures = new Map();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const currentUser = getAuthenticatedUser(request);

    if (request.method === 'GET' && requestUrl.pathname === '/login') {
      if (currentUser) {
        sendRedirect(response, '/');
        return;
      }

      renderLoginPage(response, {
        email: requestUrl.searchParams.get('email') || '',
        error: requestUrl.searchParams.has('error'),
        rateLimited: requestUrl.searchParams.has('limited'),
        configMissing: !accountStore.hasUsers()
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/login') {
      await handleLoginRequest(request, response);
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/set-password') {
      await handleSetPasswordPage(requestUrl, response);
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/set-password') {
      await handleSetPasswordRequest(request, response);
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/logout') {
      clearSession(request, response);
      sendRedirect(response, '/login');
      return;
    }

    if (!currentUser) {
      if (requestUrl.pathname.startsWith('/api/')) {
        sendJson(response, 401, { error: 'ログインが必要です。' });
        return;
      }

      sendRedirect(response, '/login');
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/account') {
      renderAccountPage(response, currentUser);
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/account/password') {
      await handleAccountPasswordRequest(request, response, currentUser);
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/admin') {
      if (!isAdmin(currentUser)) {
        sendHtml(response, 403, renderErrorPage('アクセス権がありません。'));
        return;
      }

      renderAdminPage(response, currentUser);
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/admin/invitations') {
      if (!isAdmin(currentUser)) {
        sendHtml(response, 403, renderErrorPage('アクセス権がありません。'));
        return;
      }

      await handleAdminInvitationRequest(request, response, currentUser);
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/admin/users/delete') {
      if (!isAdmin(currentUser)) {
        sendHtml(response, 403, renderErrorPage('アクセス権がありません。'));
        return;
      }

      await handleAdminDeleteUserRequest(request, response, currentUser);
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/config') {
      sendJson(response, 200, {
        hasDefaultAlbum: Boolean(DEFAULT_ALBUM_URL),
        authEnabled: accountStore.hasUsers(),
        mailConfigured: isMailConfigured(),
        user: toPublicUser(currentUser)
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/album') {
      await handleAlbumRequest(request, response);
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/assets') {
      await handleAssetRequest(request, response);
      return;
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      await serveStatic(requestUrl.pathname, response, request.method === 'HEAD');
      return;
    }

    sendJson(response, 405, { error: 'Method not allowed.' });
  } catch (error) {
    handleError(response, error);
  }
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  await accountStore.load();

  server.listen(PORT, () => {
    const adminState = accountStore.hasAdmins() ? 'admin ready' : 'admin not configured';
    const mailState = isMailConfigured() ? 'smtp configured' : 'smtp not configured';
    console.log(`iCloud Album Viewer running at http://localhost:${PORT} (${adminState}, ${mailState})`);
  });
}

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function handleLoginRequest(request, response) {
  if (!accountStore.hasUsers()) {
    renderLoginPage(response, { configMissing: true });
    return;
  }

  const body = await readRequestBody(request, 10_000);
  const params = new URLSearchParams(body);
  const email = String(params.get('email') || '').trim();
  const password = params.get('password') || '';
  const rateLimitKey = `${getClientIp(request)}|${email.toLowerCase()}`;

  if (isRateLimited(rateLimitKey)) {
    sendRedirect(response, `/login?limited=1&email=${encodeURIComponent(email)}`);
    return;
  }

  const user = await accountStore.authenticate(email, password);
  if (!user) {
    recordLoginFailure(rateLimitKey);
    sendRedirect(response, `/login?error=1&email=${encodeURIComponent(email)}`);
    return;
  }

  clearLoginFailures(rateLimitKey);
  createSession(request, response, user);
  sendRedirect(response, '/');
}

async function handleSetPasswordPage(requestUrl, response) {
  const token = requestUrl.searchParams.get('token') || '';
  const record = accountStore.findValidInvitation(token);

  renderSetPasswordPage(response, {
    token,
    email: record?.user.email || '',
    invalid: !record
  });
}

async function handleSetPasswordRequest(request, response) {
  const body = await readRequestBody(request, 20_000);
  const params = new URLSearchParams(body);
  const token = params.get('token') || '';
  const password = params.get('password') || '';
  const passwordConfirm = params.get('passwordConfirm') || '';
  const record = accountStore.findValidInvitation(token);

  if (password !== passwordConfirm) {
    renderSetPasswordPage(response, {
      token,
      email: record?.user.email || '',
      message: '確認用パスワードが一致しません。',
      invalid: !record
    });
    return;
  }

  try {
    const user = await accountStore.setPasswordWithToken(token, password);
    createSession(request, response, user);
    sendRedirect(response, '/');
  } catch (error) {
    renderSetPasswordPage(response, {
      token,
      email: record?.user.email || '',
      message: error.message,
      invalid: !record
    });
  }
}

async function handleAdminInvitationRequest(request, response, currentUser) {
  const body = await readRequestBody(request, 20_000);
  const params = new URLSearchParams(body);
  const email = params.get('email') || '';

  try {
    const result = await accountStore.createInvitation(email, currentUser.id);
    const inviteLink = buildAbsoluteUrl(request, `/set-password?token=${encodeURIComponent(result.token)}`);
    let mailResult;

    try {
      mailResult = await sendInvitationEmail({
        to: result.invitation.email,
        link: inviteLink,
        expiresAt: result.invitation.expiresAt
      });
    } catch (error) {
      console.error(error);
      mailResult = {
        sent: false,
        reason: `メール送信に失敗しました: ${error.message}`
      };
    }

    renderAdminPage(response, currentUser, {
      message: mailResult.sent
        ? `${result.invitation.email} に招待メールを送信しました。`
        : `${result.invitation.email} のアカウントを発行しました。`,
      inviteLink: mailResult.sent ? '' : inviteLink,
      mailNotice: mailResult.sent ? '' : mailResult.reason
    });
  } catch (error) {
    renderAdminPage(response, currentUser, {
      error: error.message
    });
  }
}

async function handleAccountPasswordRequest(request, response, currentUser) {
  const body = await readRequestBody(request, 20_000);
  const params = new URLSearchParams(body);
  const currentPassword = params.get('currentPassword') || '';
  const newPassword = params.get('newPassword') || '';
  const passwordConfirm = params.get('passwordConfirm') || '';

  if (newPassword !== passwordConfirm) {
    renderAccountPage(response, currentUser, {
      error: '確認用パスワードが一致しません。'
    });
    return;
  }

  try {
    await accountStore.changePassword(currentUser.id, currentPassword, newPassword);
    revokeSessionsForUser(currentUser.id, getRequestSessionHash(request));
    renderAccountPage(response, currentUser, {
      message: 'パスワードを変更しました。'
    });
  } catch (error) {
    renderAccountPage(response, currentUser, {
      error: error.message
    });
  }
}

async function handleAdminDeleteUserRequest(request, response, currentUser) {
  const body = await readRequestBody(request, 20_000);
  const params = new URLSearchParams(body);
  const userId = params.get('userId') || '';

  try {
    const deletedUser = await accountStore.deleteUser(userId, currentUser.id);
    revokeSessionsForUser(deletedUser.id);
    renderAdminPage(response, currentUser, {
      message: `${deletedUser.email} を削除しました。`
    });
  } catch (error) {
    renderAdminPage(response, currentUser, {
      error: error.message
    });
  }
}

async function handleAlbumRequest(request, response) {
  const payload = await readJsonBody(request);
  const albumUrl = getAlbumUrl(payload);
  const { entry, cached } = await getAlbumEntry(albumUrl, payload.refresh === true);
  sendJson(response, 200, serializeAlbumEntry(entry, cached));
}

async function handleAssetRequest(request, response) {
  const payload = await readJsonBody(request);
  const albumUrl = getAlbumUrl(payload);
  const requestedIds = Array.isArray(payload.ids)
    ? [...new Set(payload.ids.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 120)
    : [];

  if (requestedIds.length === 0) {
    sendJson(response, 200, { photos: [] });
    return;
  }

  const { entry } = await getAlbumEntry(albumUrl, false);
  const photosById = new Map(entry.photos.map((photo) => [photo.id, photo]));
  const missingIds = requestedIds.filter((id) => {
    const photo = photosById.get(id);
    return photo && !hasPhotoAssetUrls(photo);
  });

  if (missingIds.length > 0) {
    entry.photos = await fetchSharedAlbumAssets(entry.baseUrl, entry.photos, missingIds);
    entry.expiresAt = Date.now() + CACHE_TTL_MS;
  }

  const updatedPhotosById = new Map(entry.photos.map((photo) => [photo.id, photo]));
  sendJson(response, 200, {
    photos: requestedIds
      .map((id) => updatedPhotosById.get(id))
      .filter(Boolean)
      .map(toPublicPhoto)
  });
}

function getAlbumUrl(payload = {}) {
  const albumUrl = String(payload.url || DEFAULT_ALBUM_URL || '').trim();
  if (!albumUrl) {
    throw new ICloudAlbumError('iCloud共有アルバムのURLが設定されていません。', 400);
  }

  return albumUrl;
}

async function getAlbumEntry(albumUrl, refresh) {
  const cached = albumCache.get(albumUrl);
  if (!refresh && cached && cached.expiresAt > Date.now()) {
    return { entry: cached, cached: true };
  }

  const album = await fetchSharedAlbumMetadata(albumUrl);
  const entry = {
    baseUrl: album.baseUrl,
    metadata: album.metadata,
    photos: album.photos,
    expiresAt: Date.now() + CACHE_TTL_MS,
    fetchedAt: new Date().toISOString()
  };

  albumCache.set(albumUrl, entry);
  return { entry, cached: false };
}

function serializeAlbumEntry(entry, cached) {
  return {
    metadata: entry.metadata,
    photos: entry.photos.map(toPublicPhoto),
    cached,
    fetchedAt: entry.fetchedAt
  };
}

function toPublicPhoto(photo) {
  const { derivatives, ...publicPhoto } = photo;
  return publicPhoto;
}

function hasPhotoAssetUrls(photo) {
  return Boolean(photo?.gridUrl || photo?.fullUrl || photo?.videoUrl);
}

function toPublicUser(user) {
  return {
    email: user.email,
    role: user.role,
    isAdmin: isAdmin(user)
  };
}

function isAdmin(user) {
  return user?.role === 'admin';
}

function createSession(request, response, user) {
  pruneExpiredSessions();

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(token);
  sessions.set(tokenHash, {
    userId: user.id,
    expiresAt: Date.now() + SESSION_TTL_MS
  });

  response.setHeader('Set-Cookie', buildSessionCookie(request, token, SESSION_TTL_SECONDS));
}

function clearSession(request, response) {
  const tokenHash = getRequestSessionHash(request);
  if (tokenHash) {
    sessions.delete(tokenHash);
  }

  response.setHeader('Set-Cookie', buildSessionCookie(request, '', 0));
}

function getAuthenticatedUser(request) {
  pruneExpiredSessions();

  const tokenHash = getRequestSessionHash(request);
  if (!tokenHash) {
    return null;
  }

  const session = sessions.get(tokenHash);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(tokenHash);
    return null;
  }

  const user = accountStore.getUserById(session.userId);
  if (!user) {
    sessions.delete(tokenHash);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return user;
}

function getRequestSessionHash(request) {
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
  return token ? hashSessionToken(token) : null;
}

function revokeSessionsForUser(userId, exceptTokenHash = null) {
  for (const [tokenHash, session] of sessions) {
    if (session.userId === userId && tokenHash !== exceptTokenHash) {
      sessions.delete(tokenHash);
    }
  }
}

function hashSessionToken(token) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(token || '')).digest('hex');
}

function buildSessionCookie(request, token, maxAgeSeconds) {
  const secure = shouldUseSecureCookie(request) ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function shouldUseSecureCookie(request) {
  return process.env.COOKIE_SECURE === 'true' || request.headers['x-forwarded-proto'] === 'https';
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [tokenHash, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(tokenHash);
    }
  }
}

function getClientIp(request) {
  const forwardedFor = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwardedFor || request.socket.remoteAddress || 'unknown';
}

function isRateLimited(key) {
  const failure = loginFailures.get(key);
  if (!failure) {
    return false;
  }

  if (Date.now() - failure.firstFailedAt > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }

  return failure.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const current = loginFailures.get(key);
  if (!current || now - current.firstFailedAt > LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstFailedAt: now });
    return;
  }

  current.count += 1;
}

function clearLoginFailures(key) {
  loginFailures.delete(key);
}

function parseCookies(cookieHeader) {
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

function readJsonBody(request, maxBytes) {
  return readRequestBody(request, maxBytes).then((body) => {
    if (!body.trim()) {
      return {};
    }

    try {
      return JSON.parse(body);
    } catch {
      throw new ICloudAlbumError('JSONの形式が不正です。', 400);
    }
  });
}

function readRequestBody(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let settled = false;

    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (settled) {
        return;
      }

      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        settled = true;
        reject(new ICloudAlbumError('リクエストが大きすぎます。', 413));
        request.destroy();
        return;
      }

      body += chunk;
    });
    request.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(body);
      }
    });
    request.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

async function serveStatic(pathname, response, headOnly = false) {
  const filePath = resolvePublicFile(pathname);
  if (!filePath) {
    sendNotFound(response);
    return;
  }

  let stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch {
    sendNotFound(response);
    return;
  }

  if (stats.isDirectory()) {
    sendNotFound(response);
    return;
  }

  const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stats.size,
    'Cache-Control': 'no-store'
  });

  if (headOnly) {
    response.end();
    return;
  }

  fs.createReadStream(filePath).pipe(response);
}

function resolvePublicFile(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const requestPath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, requestPath);
  const relativePath = path.relative(PUBLIC_DIR, filePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  return filePath;
}

function buildAbsoluteUrl(request, pathname) {
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (request.socket.encrypted ? 'https' : 'http');
  const host = request.headers['x-forwarded-host'] || request.headers.host || `localhost:${PORT}`;
  return new URL(pathname, `${protocol}://${host}`).toString();
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(html);
}

function sendRedirect(response, location) {
  response.writeHead(303, {
    Location: location,
    'Cache-Control': 'no-store'
  });
  response.end();
}

function sendNotFound(response) {
  response.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end('Not found');
}

function handleError(response, error) {
  const statusCode = error instanceof ICloudAlbumError || error instanceof AccountError
    ? error.statusCode
    : Number(error?.statusCode || 500);
  const message = statusCode >= 500 && !(error instanceof ICloudAlbumError) && !(error instanceof AccountError)
    ? 'サーバーエラーが発生しました。'
    : error.message;

  if (statusCode >= 500) {
    console.error(error);
  }

  sendJson(response, statusCode, { error: message });
}

function renderLoginPage(response, state = {}) {
  const message = state.configMissing
    ? '管理者アカウントが未作成です。ALBUM_VIEWER_ADMIN_PASSWORD を設定してサーバーを再起動してください。'
    : state.rateLimited
      ? 'ログイン試行が多すぎます。少し時間をおいてから再度お試しください。'
      : state.error
        ? 'メールアドレスまたはパスワードが違います。'
        : '';

  sendHtml(response, 200, `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>iCloud Album Viewer Login</title>
    ${renderAuthStyles()}
  </head>
  <body>
    <main class="auth-shell">
      <div>
        <h1>iCloud Album Viewer</h1>
        <p>共有アルバムを見るにはログインしてください。</p>
      </div>
      <form method="post" action="/login">
        <label>
          メールアドレス
          <input name="email" type="email" autocomplete="username" value="${escapeHtml(state.email || '')}" required ${state.configMissing ? 'disabled' : ''}>
        </label>
        <label>
          パスワード
          <input name="password" type="password" autocomplete="current-password" required ${state.configMissing ? 'disabled' : ''}>
        </label>
        <button type="submit" ${state.configMissing ? 'disabled' : ''}>ログイン</button>
        <div class="message" role="status">${escapeHtml(message)}</div>
      </form>
    </main>
  </body>
</html>`);
}

function renderSetPasswordPage(response, state = {}) {
  const message = state.invalid
    ? 'この設定リンクは無効または期限切れです。管理者に再発行を依頼してください。'
    : state.message || '';

  sendHtml(response, 200, `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>パスワード設定</title>
    ${renderAuthStyles()}
  </head>
  <body>
    <main class="auth-shell">
      <div>
        <h1>パスワード設定</h1>
        <p>${state.email ? `${escapeHtml(state.email)} のパスワードを設定します。` : '招待リンクを確認しています。'}</p>
      </div>
      <form method="post" action="/set-password">
        <input name="token" type="hidden" value="${escapeHtml(state.token || '')}">
        <label>
          新しいパスワード
          <input name="password" type="password" autocomplete="new-password" minlength="8" required ${state.invalid ? 'disabled' : ''}>
        </label>
        <label>
          新しいパスワード 確認
          <input name="passwordConfirm" type="password" autocomplete="new-password" minlength="8" required ${state.invalid ? 'disabled' : ''}>
        </label>
        <button type="submit" ${state.invalid ? 'disabled' : ''}>設定してログイン</button>
        <div class="message" role="status">${escapeHtml(message)}</div>
      </form>
    </main>
  </body>
</html>`);
}

function renderAccountPage(response, currentUser, state = {}) {
  sendHtml(response, 200, `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>アカウント設定</title>
    ${renderAuthStyles()}
  </head>
  <body>
    <main class="auth-shell">
      <div>
        <h1>アカウント設定</h1>
        <p>${escapeHtml(currentUser.email)} でログイン中</p>
      </div>
      <form method="post" action="/account/password">
        <label>
          現在のパスワード
          <input name="currentPassword" type="password" autocomplete="current-password" required>
        </label>
        <label>
          新しいパスワード
          <input name="newPassword" type="password" autocomplete="new-password" minlength="8" required>
        </label>
        <label>
          新しいパスワード 確認
          <input name="passwordConfirm" type="password" autocomplete="new-password" minlength="8" required>
        </label>
        <button type="submit">パスワード変更</button>
        ${state.message ? `<div class="message success" role="status">${escapeHtml(state.message)}</div>` : ''}
        ${state.error ? `<div class="message" role="status">${escapeHtml(state.error)}</div>` : ''}
      </form>
      <div class="auth-actions">
        <a class="button-link secondary" href="/">アルバム</a>
        ${isAdmin(currentUser) ? '<a class="button-link secondary" href="/admin">管理</a>' : ''}
      </div>
    </main>
  </body>
</html>`);
}

function renderAdminPage(response, currentUser, state = {}) {
  const users = accountStore.listUsers();
  const rows = users.map((user) => `
    <tr>
      <td>${escapeHtml(user.email)}</td>
      <td>${escapeHtml(user.role === 'admin' ? '管理者' : 'メンバー')}</td>
      <td>${escapeHtml(user.status === 'active' ? '有効' : '招待中')}</td>
      <td>${escapeHtml(formatDateTime(user.acceptedAt || user.inviteExpiresAt || user.createdAt))}</td>
      <td>
        ${user.id === currentUser.id
          ? '<span class="muted">本人</span>'
          : `<form class="inline-form" method="post" action="/admin/users/delete" onsubmit="return confirm('このユーザーを削除します。');">
              <input name="userId" type="hidden" value="${escapeHtml(user.id)}">
              <button class="danger" type="submit">削除</button>
            </form>`}
      </td>
    </tr>
  `).join('');

  sendHtml(response, 200, `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>アカウント管理</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f8fb;
        --surface: #ffffff;
        --surface-strong: #eef3f6;
        --text: #182029;
        --muted: #657180;
        --line: #d8e0e7;
        --primary: #0f6f6e;
        --primary-dark: #0a504f;
        --accent: #c65536;
        --danger: #b8422f;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
      }

      main {
        width: min(980px, calc(100% - 32px));
        margin: 0 auto;
        padding: 24px 0 40px;
        display: grid;
        gap: 16px;
      }

      header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }

      h1 {
        margin: 0;
        font-size: 22px;
      }

      p {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 13px;
      }

      nav {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      a,
      button {
        min-height: 40px;
        display: inline-grid;
        place-items: center;
        padding: 0 12px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: #fff;
        color: var(--primary-dark);
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        font-weight: 800;
        text-decoration: none;
      }

      button.primary {
        border-color: transparent;
        background: var(--primary);
        color: #fff;
      }

      button.primary:hover {
        background: var(--primary-dark);
      }

      button.danger {
        border-color: rgba(184, 66, 47, 0.32);
        color: var(--danger);
      }

      button.danger:hover {
        background: #fff0ec;
      }

      section {
        display: grid;
        gap: 12px;
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
      }

      form.issue-form {
        display: grid;
        grid-template-columns: minmax(220px, 1fr) auto;
        gap: 10px;
        align-items: end;
      }

      form.inline-form {
        margin: 0;
      }

      label {
        display: grid;
        gap: 7px;
        color: var(--muted);
        font-size: 13px;
        font-weight: 800;
      }

      input {
        width: 100%;
        min-height: 42px;
        padding: 0 12px;
        border: 1px solid var(--line);
        border-radius: 6px;
        color: var(--text);
        font: inherit;
      }

      .notice,
      .error {
        padding: 10px 12px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 800;
      }

      .notice {
        background: #edf8f5;
        color: var(--primary-dark);
      }

      .error {
        background: #fff0ec;
        color: var(--danger);
      }

      .invite-link {
        display: grid;
        gap: 8px;
      }

      .muted {
        color: var(--muted);
        font-size: 13px;
        font-weight: 800;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fff;
      }

      th,
      td {
        padding: 11px 12px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        font-size: 13px;
      }

      th {
        background: var(--surface-strong);
        color: var(--muted);
        font-weight: 900;
      }

      tr:last-child td {
        border-bottom: 0;
      }

      @media (max-width: 680px) {
        header,
        form.issue-form {
          grid-template-columns: 1fr;
          display: grid;
        }

        nav {
          justify-content: start;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>アカウント管理</h1>
          <p>${escapeHtml(currentUser.email)} でログイン中</p>
        </div>
        <nav>
          <a href="/">アルバム</a>
          <a href="/account">アカウント</a>
          <form method="post" action="/logout">
            <button type="submit">ログアウト</button>
          </form>
        </nav>
      </header>

      <section>
        <div>
          <h1>新規アカウント発行</h1>
          <p>${isMailConfigured() ? 'SMTP設定済みです。発行すると招待メールを送信します。' : 'SMTP未設定です。発行すると招待リンクを画面とサーバーログに表示します。'}</p>
        </div>
        ${state.message ? `<div class="notice">${escapeHtml(state.message)}</div>` : ''}
        ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
        ${state.mailNotice ? `<div class="notice">${escapeHtml(state.mailNotice)}</div>` : ''}
        ${state.inviteLink ? `
          <label class="invite-link">
            招待リンク
            <input readonly value="${escapeHtml(state.inviteLink)}">
          </label>
        ` : ''}
        <form class="issue-form" method="post" action="/admin/invitations">
          <label>
            メールアドレス
            <input name="email" type="email" autocomplete="email" required>
          </label>
          <button class="primary" type="submit">アカウント発行</button>
        </form>
      </section>

      <section>
        <div>
          <h1>ユーザー</h1>
          <p>${users.length.toLocaleString('ja-JP')}件</p>
        </div>
        <table>
          <thead>
            <tr>
              <th>メールアドレス</th>
              <th>権限</th>
              <th>状態</th>
              <th>日時</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="5">ユーザーがありません</td></tr>'}
          </tbody>
        </table>
      </section>
    </main>
  </body>
</html>`);
}

function renderErrorPage(message) {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>エラー</title>
    ${renderAuthStyles()}
  </head>
  <body>
    <main class="auth-shell">
      <div>
        <h1>エラー</h1>
        <p>${escapeHtml(message)}</p>
      </div>
      <form>
        <a class="button-link" href="/">アルバムへ戻る</a>
      </form>
    </main>
  </body>
</html>`;
}

function renderAuthStyles() {
  return `<style>
      :root {
        color-scheme: light;
        --bg: #f6f8fb;
        --surface: #ffffff;
        --text: #182029;
        --muted: #657180;
        --line: #d8e0e7;
        --primary: #0f6f6e;
        --primary-dark: #0a504f;
        --danger: #b8422f;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: var(--bg);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
      }

      .auth-shell {
        width: min(100%, 420px);
        display: grid;
        gap: 18px;
      }

      h1 {
        margin: 0;
        font-size: 22px;
        line-height: 1.25;
      }

      p {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.6;
      }

      form {
        display: grid;
        gap: 12px;
        padding: 20px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        box-shadow: 0 16px 40px rgba(25, 32, 41, 0.09);
      }

      label {
        display: grid;
        gap: 7px;
        color: var(--muted);
        font-size: 13px;
        font-weight: 800;
      }

      input {
        width: 100%;
        min-height: 44px;
        padding: 0 12px;
        border: 1px solid var(--line);
        border-radius: 6px;
        color: var(--text);
        font: inherit;
        outline: none;
      }

      input:focus {
        border-color: var(--primary);
        box-shadow: 0 0 0 3px rgba(15, 111, 110, 0.15);
      }

      button,
      .button-link {
        min-height: 44px;
        display: inline-grid;
        place-items: center;
        border: 0;
        border-radius: 6px;
        background: var(--primary);
        color: #fff;
        cursor: pointer;
        font: inherit;
        font-weight: 800;
        text-decoration: none;
      }

      button:hover:not(:disabled),
      .button-link:hover {
        background: var(--primary-dark);
      }

      .button-link.secondary {
        border: 1px solid var(--line);
        background: #fff;
        color: var(--primary-dark);
      }

      .button-link.secondary:hover {
        background: #edf8f5;
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }

      .auth-actions {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 10px;
      }

      .message {
        min-height: 20px;
        color: var(--danger);
        font-size: 13px;
        font-weight: 800;
      }

      .message.success {
        color: var(--primary-dark);
      }
    </style>`;
}

function formatDateTime(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
