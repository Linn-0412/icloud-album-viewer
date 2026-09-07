import { AppError, parseCookies } from './http.js';

const COOKIE_NAME = 'album_viewer_session';
const PASSWORD_ITERATIONS = 100_000;
const PASSWORD_KEY_BITS = 256;
const INVITE_TTL_HOURS = 72;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

let cachedDbSessionSecret = '';

export class AccountError extends AppError {
  constructor(message, statusCode = 400) {
    super(message, statusCode);
    this.name = 'AccountError';
  }
}

export async function ensureAccountState(env) {
  getDb(env);
  await ensureBootstrapAdmin(env);
  await pruneExpiredInvitations(env);
  await pruneExpiredSessions(env);
}

export async function hasUsers(env) {
  const row = await getDb(env)
    .prepare('SELECT COUNT(*) AS count FROM users WHERE disabled_at IS NULL')
    .first();
  return Number(row?.count || 0) > 0;
}

export async function hasAdmins(env) {
  return (await countActiveAdmins(env)) > 0;
}

export async function getUserById(env, userId) {
  const row = await getDb(env)
    .prepare('SELECT * FROM users WHERE id = ? AND disabled_at IS NULL')
    .bind(String(userId || ''))
    .first();
  return rowToUser(row);
}

export async function getUserByEmail(env, email) {
  const row = await getDb(env)
    .prepare('SELECT * FROM users WHERE email = ? AND disabled_at IS NULL')
    .bind(normalizeEmail(email))
    .first();
  return rowToUser(row);
}

export async function authenticateUser(env, email, password) {
  const user = await getUserByEmail(env, email);
  if (!user?.password || !(await verifyPassword(password, user.password))) {
    return null;
  }

  const now = new Date().toISOString();
  await getDb(env)
    .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(now, user.id)
    .run();

  return { ...user, lastLoginAt: now };
}

export async function changePassword(env, userId, currentPassword, newPassword) {
  validatePassword(newPassword);

  const user = await getUserById(env, userId);
  if (!user?.password || !(await verifyPassword(currentPassword, user.password))) {
    throw new AccountError('現在のパスワードが違います。', 400);
  }

  const passwordJson = JSON.stringify(await hashPassword(newPassword));
  const now = new Date().toISOString();
  await getDb(env)
    .prepare('UPDATE users SET password_json = ?, password_changed_at = ? WHERE id = ?')
    .bind(passwordJson, now, user.id)
    .run();

  return { ...user, password: JSON.parse(passwordJson), passwordChangedAt: now };
}

export async function createInvitation(env, email, createdByUserId) {
  const normalizedEmail = normalizeEmail(email);
  validateEmail(normalizedEmail);

  const db = getDb(env);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + getInviteTtlMs(env)).toISOString();
  let user = await getAnyUserByEmail(env, normalizedEmail);

  if (!user) {
    user = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      role: 'member',
      password: null,
      createdAt: nowIso,
      acceptedAt: null,
      disabledAt: null,
      lastLoginAt: null
    };

    await db
      .prepare(
        `INSERT INTO users (
          id, email, role, password_json, created_at, accepted_at,
          disabled_at, disabled_by_user_id, last_login_at, password_changed_at
        ) VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL)`
      )
      .bind(user.id, user.email, user.role, user.createdAt)
      .run();
  } else if (user.disabledAt) {
    await db
      .prepare(
        `UPDATE users
          SET role = 'member',
              password_json = NULL,
              accepted_at = NULL,
              disabled_at = NULL,
              disabled_by_user_id = NULL,
              last_login_at = NULL,
              password_changed_at = NULL
          WHERE id = ?`
      )
      .bind(user.id)
      .run();

    user = {
      ...user,
      role: 'member',
      password: null,
      acceptedAt: null,
      disabledAt: null,
      disabledByUserId: null,
      lastLoginAt: null,
      passwordChangedAt: null
    };
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const invitationId = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO invitations (
        id, user_id, email, token_hash, created_by_user_id,
        created_at, expires_at, used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .bind(invitationId, user.id, normalizedEmail, tokenHash, createdByUserId, nowIso, expiresAt)
    .run();

  return {
    token,
    invitation: {
      id: invitationId,
      email: normalizedEmail,
      expiresAt,
      userId: user.id
    },
    user
  };
}

export async function findValidInvitation(env, token) {
  const tokenHash = await sha256Hex(token);
  const nowIso = new Date().toISOString();
  const row = await getDb(env)
    .prepare(
      `SELECT
        i.id AS invitation_id,
        i.user_id AS invitation_user_id,
        i.email AS invitation_email,
        i.created_by_user_id AS invitation_created_by_user_id,
        i.created_at AS invitation_created_at,
        i.expires_at AS invitation_expires_at,
        i.used_at AS invitation_used_at,
        u.*
      FROM invitations i
      JOIN users u ON u.id = i.user_id
      WHERE i.token_hash = ?
        AND i.used_at IS NULL
        AND i.expires_at > ?
        AND u.disabled_at IS NULL`
    )
    .bind(tokenHash, nowIso)
    .first();

  if (!row) {
    return null;
  }

  return {
    invitation: {
      id: row.invitation_id,
      userId: row.invitation_user_id,
      email: row.invitation_email,
      createdByUserId: row.invitation_created_by_user_id,
      createdAt: row.invitation_created_at,
      expiresAt: row.invitation_expires_at,
      usedAt: row.invitation_used_at
    },
    user: rowToUser(row)
  };
}

export async function setPasswordWithToken(env, token, password) {
  validatePassword(password);

  const record = await findValidInvitation(env, token);
  if (!record) {
    throw new AccountError('この設定リンクは無効、または期限切れです。', 400);
  }

  const passwordJson = JSON.stringify(await hashPassword(password));
  const now = new Date().toISOString();
  const db = getDb(env);
  await db.batch([
    db
      .prepare('UPDATE users SET password_json = ?, accepted_at = COALESCE(accepted_at, ?) WHERE id = ?')
      .bind(passwordJson, now, record.user.id),
    db
      .prepare('UPDATE invitations SET used_at = ? WHERE id = ?')
      .bind(now, record.invitation.id)
  ]);

  return {
    ...record.user,
    password: JSON.parse(passwordJson),
    acceptedAt: record.user.acceptedAt || now
  };
}

export async function listUsers(env) {
  const nowIso = new Date().toISOString();
  const result = await getDb(env)
    .prepare(
      `SELECT
        u.*,
        (
          SELECT i.expires_at
          FROM invitations i
          WHERE i.user_id = u.id
            AND i.used_at IS NULL
            AND i.expires_at > ?
          ORDER BY i.created_at DESC
          LIMIT 1
        ) AS invite_expires_at
      FROM users u
      WHERE u.disabled_at IS NULL
      ORDER BY u.email ASC`
    )
    .bind(nowIso)
    .all();

  return (result.results || []).map((row) => {
    const user = rowToUser(row);
    return {
      ...toPublicUser(user),
      id: user.id,
      createdAt: user.createdAt,
      acceptedAt: user.acceptedAt,
      lastLoginAt: user.lastLoginAt,
      inviteExpiresAt: row.invite_expires_at || null,
      status: user.password ? 'active' : 'pending'
    };
  });
}

export async function deleteUser(env, userId, deletedByUserId) {
  const user = await getUserById(env, userId);
  if (!user) {
    throw new AccountError('対象ユーザーが見つかりません。', 404);
  }

  if (user.id === deletedByUserId) {
    throw new AccountError('自分自身は削除できません。', 400);
  }

  if (isAdmin(user) && (await countActiveAdmins(env)) <= 1) {
    throw new AccountError('最後の管理者は削除できません。', 400);
  }

  const now = new Date().toISOString();
  const db = getDb(env);
  await db.batch([
    db
      .prepare('UPDATE users SET disabled_at = ?, disabled_by_user_id = ? WHERE id = ?')
      .bind(now, deletedByUserId, user.id),
    db
      .prepare('UPDATE invitations SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
      .bind(now, user.id),
    db
      .prepare('DELETE FROM sessions WHERE user_id = ?')
      .bind(user.id)
  ]);

  return user;
}

export async function getAuthenticatedUser(request, env) {
  const tokenHash = await getRequestSessionHash(request, env);
  if (!tokenHash) {
    return null;
  }

  const row = await getDb(env)
    .prepare(
      `SELECT
        s.expires_at AS session_expires_at,
        u.*
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
        AND u.disabled_at IS NULL`
    )
    .bind(tokenHash)
    .first();

  if (!row) {
    return null;
  }

  if (new Date(row.session_expires_at).getTime() <= Date.now()) {
    await getDb(env)
      .prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(tokenHash)
      .run();
    return null;
  }

  const expiresAt = new Date(Date.now() + getSessionTtlSeconds(env) * 1000).toISOString();
  await getDb(env)
    .prepare('UPDATE sessions SET updated_at = ?, expires_at = ? WHERE token_hash = ?')
    .bind(new Date().toISOString(), expiresAt, tokenHash)
    .run();

  return rowToUser(row);
}

export async function createSessionCookie(request, env, user) {
  const token = randomToken();
  const tokenHash = await hashSessionToken(env, token);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + getSessionTtlSeconds(env) * 1000).toISOString();

  await getDb(env)
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?)`
    )
    .bind(tokenHash, user.id, now, now, expiresAt)
    .run();

  return buildSessionCookie(request, token, getSessionTtlSeconds(env));
}

export async function deleteRequestSession(request, env) {
  const tokenHash = await getRequestSessionHash(request, env);
  if (tokenHash) {
    await getDb(env)
      .prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(tokenHash)
      .run();
  }

  return buildSessionCookie(request, '', 0);
}

export async function getRequestSessionHash(request, env) {
  const token = parseCookies(request.headers.get('Cookie'))[COOKIE_NAME];
  return token ? hashSessionToken(env, token) : null;
}

export async function revokeSessionsForUser(env, userId, exceptTokenHash = null) {
  if (exceptTokenHash) {
    await getDb(env)
      .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
      .bind(userId, exceptTokenHash)
      .run();
    return;
  }

  await getDb(env)
    .prepare('DELETE FROM sessions WHERE user_id = ?')
    .bind(userId)
    .run();
}

export async function isLoginRateLimited(env, key) {
  const row = await getDb(env)
    .prepare('SELECT count, first_failed_at FROM login_failures WHERE key = ?')
    .bind(key)
    .first();

  if (!row) {
    return false;
  }

  if (Date.now() - new Date(row.first_failed_at).getTime() > LOGIN_WINDOW_MS) {
    await getDb(env)
      .prepare('DELETE FROM login_failures WHERE key = ?')
      .bind(key)
      .run();
    return false;
  }

  return Number(row.count || 0) >= LOGIN_MAX_FAILURES;
}

export async function recordLoginFailure(env, key) {
  const db = getDb(env);
  const nowIso = new Date().toISOString();
  const row = await db
    .prepare('SELECT count, first_failed_at FROM login_failures WHERE key = ?')
    .bind(key)
    .first();

  if (!row || Date.now() - new Date(row.first_failed_at).getTime() > LOGIN_WINDOW_MS) {
    await db
      .prepare('INSERT OR REPLACE INTO login_failures (key, count, first_failed_at) VALUES (?, 1, ?)')
      .bind(key, nowIso)
      .run();
    return;
  }

  await db
    .prepare('UPDATE login_failures SET count = ? WHERE key = ?')
    .bind(Number(row.count || 0) + 1, key)
    .run();
}

export async function clearLoginFailures(env, key) {
  await getDb(env)
    .prepare('DELETE FROM login_failures WHERE key = ?')
    .bind(key)
    .run();
}

export function getClientIp(request) {
  const forwardedFor = String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return request.headers.get('cf-connecting-ip') || forwardedFor || 'unknown';
}

export function isAdmin(user) {
  return user?.role === 'admin';
}

export function toPublicUser(user) {
  return user
    ? {
        email: user.email,
        role: user.role,
        isAdmin: isAdmin(user)
      }
    : null;
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function validateEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AccountError('メールアドレスの形式が正しくありません。', 400);
  }
}

export function validatePassword(password) {
  if (String(password || '').length < 8) {
    throw new AccountError('パスワードは8文字以上にしてください。', 400);
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PASSWORD_ITERATIONS);

  return {
    algorithm: 'pbkdf2-sha256',
    iterations: PASSWORD_ITERATIONS,
    salt: bytesToBase64Url(salt),
    hash: bytesToBase64Url(hash)
  };
}

export async function verifyPassword(password, storedPassword) {
  if (!storedPassword?.salt || !storedPassword?.hash) {
    return false;
  }

  const salt = base64UrlToBytes(storedPassword.salt);
  const expectedHash = base64UrlToBytes(storedPassword.hash);
  const actualHash = await pbkdf2(
    password,
    salt,
    Number(storedPassword.iterations || PASSWORD_ITERATIONS)
  );

  return constantTimeEqual(actualHash, expectedHash);
}

async function ensureBootstrapAdmin(env) {
  const activeAdminCount = await countActiveAdmins(env);
  const resetRequested = isTruthy(env.ALBUM_VIEWER_ADMIN_RESET);
  const password = String(env.ALBUM_VIEWER_ADMIN_PASSWORD || env.ALBUM_VIEWER_PASSWORD || '');

  if (activeAdminCount > 0 && (!resetRequested || !password)) {
    return;
  }

  if (!password) {
    return;
  }

  const db = getDb(env);
  const email = normalizeEmail(env.ALBUM_VIEWER_ADMIN_EMAIL || env.ADMIN_EMAIL || 'admin@example.local');
  const now = new Date().toISOString();
  const passwordJson = JSON.stringify(await hashPassword(password));
  const targetByEmail = await getAnyUserByEmail(env, email);
  const targetAdmin = targetByEmail || (resetRequested ? await getFirstActiveAdmin(env) : null);

  if (targetAdmin) {
    await db
      .prepare(
        `UPDATE users
          SET email = ?,
              role = 'admin',
              password_json = ?,
              accepted_at = COALESCE(accepted_at, ?),
              disabled_at = NULL,
              disabled_by_user_id = NULL
          WHERE id = ?`
      )
      .bind(email, passwordJson, now, targetAdmin.id)
      .run();

    if (resetRequested) {
      await db
        .prepare(
          `UPDATE users
            SET disabled_at = ?, disabled_by_user_id = ?
            WHERE role = 'admin' AND disabled_at IS NULL AND id <> ?`
        )
        .bind(now, targetAdmin.id, targetAdmin.id)
        .run();
    }
  } else {
    await db
      .prepare(
        `INSERT INTO users (
          id, email, role, password_json, created_at, accepted_at,
          disabled_at, disabled_by_user_id, last_login_at, password_changed_at
        ) VALUES (?, ?, 'admin', ?, ?, ?, NULL, NULL, NULL, NULL)`
      )
      .bind(crypto.randomUUID(), email, passwordJson, now, now)
      .run();
  }

  await db
    .prepare('UPDATE invitations SET used_at = ? WHERE email = ? AND used_at IS NULL')
    .bind(now, email)
    .run();
}

async function countActiveAdmins(env) {
  const row = await getDb(env)
    .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled_at IS NULL")
    .first();
  return Number(row?.count || 0);
}

async function getAnyUserByEmail(env, email) {
  const row = await getDb(env)
    .prepare('SELECT * FROM users WHERE email = ?')
    .bind(normalizeEmail(email))
    .first();
  return rowToUser(row);
}

async function getFirstActiveAdmin(env) {
  const row = await getDb(env)
    .prepare("SELECT * FROM users WHERE role = 'admin' AND disabled_at IS NULL ORDER BY created_at ASC LIMIT 1")
    .first();
  return rowToUser(row);
}

async function pruneExpiredInvitations(env) {
  await getDb(env)
    .prepare('DELETE FROM invitations WHERE used_at IS NULL AND expires_at <= ?')
    .bind(new Date().toISOString())
    .run();
}

async function pruneExpiredSessions(env) {
  await getDb(env)
    .prepare('DELETE FROM sessions WHERE expires_at <= ?')
    .bind(new Date().toISOString())
    .run();
}

function rowToUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    role: row.role,
    password: parsePassword(row.password_json),
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    disabledAt: row.disabled_at,
    disabledByUserId: row.disabled_by_user_id,
    lastLoginAt: row.last_login_at,
    passwordChangedAt: row.password_changed_at
  };
}

function parsePassword(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getDb(env) {
  if (!env?.DB) {
    throw new AccountError('D1データベースが設定されていません。', 500);
  }

  return env.DB;
}

async function hashSessionToken(env, token) {
  const secret = await getSessionSecret(env);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(token || '')));
  return bytesToHex(new Uint8Array(signature));
}

async function getSessionSecret(env) {
  if (env.ALBUM_VIEWER_SESSION_SECRET) {
    return String(env.ALBUM_VIEWER_SESSION_SECRET);
  }

  if (cachedDbSessionSecret) {
    return cachedDbSessionSecret;
  }

  const db = getDb(env);
  const existing = await db
    .prepare("SELECT value FROM app_settings WHERE key = 'session_secret'")
    .first();
  if (existing?.value) {
    cachedDbSessionSecret = existing.value;
    return cachedDbSessionSecret;
  }

  const generated = randomToken(48);
  const now = new Date().toISOString();
  await db
    .prepare('INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .bind('session_secret', generated, now)
    .run();

  const stored = await db
    .prepare("SELECT value FROM app_settings WHERE key = 'session_secret'")
    .first();
  cachedDbSessionSecret = stored?.value || generated;
  return cachedDbSessionSecret;
}

function buildSessionCookie(request, token, maxAgeSeconds) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

async function pbkdf2(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password || '')),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations
    },
    keyMaterial,
    PASSWORD_KEY_BITS
  );

  return new Uint8Array(bits);
}

function getInviteTtlMs(env) {
  const hours = Number(env.INVITE_TTL_HOURS || INVITE_TTL_HOURS);
  return Math.max(1, hours) * 60 * 60 * 1000;
}

function getSessionTtlSeconds(env) {
  const seconds = Number(env.SESSION_TTL_SECONDS || SESSION_TTL_SECONDS);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : SESSION_TTL_SECONDS;
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function randomToken(size = 32) {
  return bytesToBase64Url(randomBytes(size));
}

function randomBytes(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function sha256Hex(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return bytesToHex(new Uint8Array(hash));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}
