import {
  getAlbumEntry,
  getAlbumUrl,
  loadAssetPhotos,
  serializeAlbumEntry
} from '../functions/_lib/album-api.js';
import { handleError, html, json, readFormBody, readJsonBody, redirect } from '../functions/_lib/http.js';
import {
  authenticateUser,
  changePassword,
  clearLoginFailures,
  createInvitation,
  createSessionCookie,
  deleteRequestSession,
  deleteUser,
  ensureAccountState,
  findValidInvitation,
  getAuthenticatedUser,
  getClientIp,
  getRequestSessionHash,
  hasUsers,
  isAdmin,
  isLoginRateLimited,
  listUsers,
  normalizeEmail,
  recordLoginFailure,
  revokeSessionsForUser,
  setPasswordWithToken,
  toPublicUser
} from '../functions/_lib/worker-auth.js';
import {
  getWorkerMailStatus,
  isWorkerMailConfigured,
  sendInvitationEmail,
  sendTestEmail
} from '../functions/_lib/worker-mailer.js';
import {
  renderAccountPage,
  renderAdminPage,
  renderErrorPage,
  renderLoginPage,
  renderSetPasswordPage
} from '../functions/_lib/worker-pages.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      await ensureAccountState(env);
      const currentUser = await getAuthenticatedUser(request, env);

      if (url.pathname === '/login' && request.method === 'GET') {
        if (currentUser) {
          return redirect(getSafeNext(url.searchParams.get('next')));
        }

        return html(renderLoginPage({
          email: url.searchParams.get('email') || '',
          error: url.searchParams.has('error'),
          rateLimited: url.searchParams.has('limited'),
          configMissing: !(await hasUsers(env)),
          next: getSafeNext(url.searchParams.get('next'), '')
        }));
      }

      if (url.pathname === '/login' && request.method === 'POST') {
        return handleLoginRequest(request, env);
      }

      if (url.pathname === '/set-password' && request.method === 'GET') {
        return handleSetPasswordPage(url, env);
      }

      if (url.pathname === '/set-password' && request.method === 'POST') {
        return handleSetPasswordRequest(request, env);
      }

      if (!currentUser) {
        if (url.pathname.startsWith('/api/')) {
          return json({ error: 'ログインが必要です。' }, 401);
        }

        return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      }

      if (url.pathname === '/logout' && request.method === 'POST') {
        return handleLogoutRequest(request, env);
      }

      if (url.pathname === '/account' && request.method === 'GET') {
        return html(renderAccountPage(currentUser));
      }

      if (url.pathname === '/account/password' && request.method === 'POST') {
        return handleAccountPasswordRequest(request, env, currentUser);
      }

      if (url.pathname === '/admin' && request.method === 'GET') {
        if (!isAdmin(currentUser)) {
          return html(renderErrorPage('アクセス権がありません。'), 403);
        }

        return renderAdminResponse(env, currentUser);
      }

      if (url.pathname === '/admin/invitations' && request.method === 'POST') {
        if (!isAdmin(currentUser)) {
          return html(renderErrorPage('アクセス権がありません。'), 403);
        }

        return handleAdminInvitationRequest(request, env, currentUser);
      }

      if (url.pathname === '/admin/users/delete' && request.method === 'POST') {
        if (!isAdmin(currentUser)) {
          return html(renderErrorPage('アクセス権がありません。'), 403);
        }

        return handleAdminDeleteUserRequest(request, env, currentUser);
      }

      if (url.pathname === '/admin/mail/test' && request.method === 'POST') {
        if (!isAdmin(currentUser)) {
          return html(renderErrorPage('アクセス権がありません。'), 403);
        }

        return handleAdminTestMailRequest(request, env, currentUser);
      }

      if (url.pathname === '/api/config' && request.method === 'GET') {
        return json({
          hasDefaultAlbum: Boolean(env.ICLOUD_SHARED_ALBUM_URL),
          authEnabled: true,
          authMode: 'local',
          mailConfigured: isWorkerMailConfigured(env),
          user: toPublicUser(currentUser)
        });
      }

      if (url.pathname === '/api/album' && request.method === 'POST') {
        const payload = await readJsonBody(request);
        const albumUrl = getAlbumUrl(payload, env);
        const { entry, cached } = await getAlbumEntry({ request, env, ctx }, albumUrl, payload.refresh === true);
        return json(serializeAlbumEntry(entry, cached));
      }

      if (url.pathname === '/api/assets' && request.method === 'POST') {
        const payload = await readJsonBody(request);
        const photos = await loadAssetPhotos({ request, env, ctx }, payload);
        return json({ photos });
      }

      if (url.pathname.startsWith('/api/')) {
        return json({ error: 'Not found' }, 404);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      if (url.pathname.startsWith('/api/')) {
        return handleError(error);
      }

      const statusCode = Number(error?.statusCode || 500);
      return html(renderErrorPage(statusCode >= 500 ? 'サーバーエラーが発生しました。' : error.message), statusCode);
    }
  }
};

async function handleLoginRequest(request, env) {
  if (!(await hasUsers(env))) {
    return html(renderLoginPage({ configMissing: true }));
  }

  const params = await readFormBody(request);
  const email = String(params.get('email') || '').trim();
  const password = params.get('password') || '';
  const next = getSafeNext(params.get('next'));
  const rateLimitKey = `${getClientIp(request)}|${normalizeEmail(email)}`;

  if (await isLoginRateLimited(env, rateLimitKey)) {
    return redirect(`/login?limited=1&email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
  }

  const user = await authenticateUser(env, email, password);
  if (!user) {
    await recordLoginFailure(env, rateLimitKey);
    return redirect(`/login?error=1&email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
  }

  await clearLoginFailures(env, rateLimitKey);
  const sessionCookie = await createSessionCookie(request, env, user);
  return redirect(next, 303, { 'Set-Cookie': sessionCookie });
}

async function handleSetPasswordPage(url, env) {
  const token = url.searchParams.get('token') || '';
  const record = await findValidInvitation(env, token);

  return html(renderSetPasswordPage({
    token,
    email: record?.user.email || '',
    invalid: !record
  }));
}

async function handleSetPasswordRequest(request, env) {
  const params = await readFormBody(request);
  const token = params.get('token') || '';
  const password = params.get('password') || '';
  const passwordConfirm = params.get('passwordConfirm') || '';
  const record = await findValidInvitation(env, token);

  if (password !== passwordConfirm) {
    return html(renderSetPasswordPage({
      token,
      email: record?.user.email || '',
      message: '確認用パスワードが一致しません。',
      invalid: !record
    }));
  }

  try {
    const user = await setPasswordWithToken(env, token, password);
    const sessionCookie = await createSessionCookie(request, env, user);
    return redirect('/', 303, { 'Set-Cookie': sessionCookie });
  } catch (error) {
    return html(renderSetPasswordPage({
      token,
      email: record?.user.email || '',
      message: error.message,
      invalid: !record
    }));
  }
}

async function handleLogoutRequest(request, env) {
  const sessionCookie = await deleteRequestSession(request, env);
  return redirect('/login', 303, { 'Set-Cookie': sessionCookie });
}

async function handleAccountPasswordRequest(request, env, currentUser) {
  const params = await readFormBody(request);
  const currentPassword = params.get('currentPassword') || '';
  const newPassword = params.get('newPassword') || '';
  const passwordConfirm = params.get('passwordConfirm') || '';

  if (newPassword !== passwordConfirm) {
    return html(renderAccountPage(currentUser, {
      error: '確認用パスワードが一致しません。'
    }));
  }

  try {
    await changePassword(env, currentUser.id, currentPassword, newPassword);
    const currentTokenHash = await getRequestSessionHash(request, env);
    await revokeSessionsForUser(env, currentUser.id, currentTokenHash);

    return html(renderAccountPage(currentUser, {
      message: 'パスワードを変更しました。'
    }));
  } catch (error) {
    return html(renderAccountPage(currentUser, {
      error: error.message
    }));
  }
}

async function handleAdminInvitationRequest(request, env, currentUser) {
  const params = await readFormBody(request);
  const email = params.get('email') || '';

  try {
    const result = await createInvitation(env, email, currentUser.id);
    const inviteLink = buildAbsoluteUrl(request, `/set-password?token=${encodeURIComponent(result.token)}`);
    let mailResult;

    try {
      mailResult = await sendInvitationEmail(env, {
        to: result.invitation.email,
        link: inviteLink,
        expiresAt: result.invitation.expiresAt
      });
    } catch (error) {
      console.error(error);
      mailResult = {
        sent: false,
        reason: error.message
      };
    }

    return renderAdminResponse(env, currentUser, {
      message: mailResult.sent
        ? `${result.invitation.email} に招待メールを送信しました。`
        : `${result.invitation.email} のアカウントを発行しました。`,
      inviteLink: mailResult.sent ? '' : inviteLink,
      mailNotice: mailResult.sent ? '' : mailResult.reason
    });
  } catch (error) {
    return renderAdminResponse(env, currentUser, {
      error: error.message
    });
  }
}

async function handleAdminDeleteUserRequest(request, env, currentUser) {
  const params = await readFormBody(request);
  const userId = params.get('userId') || '';

  try {
    const deletedUser = await deleteUser(env, userId, currentUser.id);
    return renderAdminResponse(env, currentUser, {
      message: `${deletedUser.email} を削除しました。`
    });
  } catch (error) {
    return renderAdminResponse(env, currentUser, {
      error: error.message
    });
  }
}

async function handleAdminTestMailRequest(request, env, currentUser) {
  const params = await readFormBody(request);
  const email = params.get('email') || currentUser.email;

  try {
    const result = await sendTestEmail(env, { to: email });
    return renderAdminResponse(env, currentUser, {
      message: result.sent ? `${email} にテストメールを送信しました。` : '',
      mailNotice: result.sent ? '' : result.reason
    });
  } catch (error) {
    return renderAdminResponse(env, currentUser, {
      error: error.message
    });
  }
}

async function renderAdminResponse(env, currentUser, state = {}) {
  const users = await listUsers(env);
  return html(renderAdminPage(currentUser, users, {
    ...state,
    mailConfigured: isWorkerMailConfigured(env),
    mailStatus: getWorkerMailStatus(env)
  }));
}

function buildAbsoluteUrl(request, pathname) {
  return new URL(pathname, request.url).toString();
}

function getSafeNext(value, fallback = '/') {
  const next = String(value || '').trim();
  if (!next || !next.startsWith('/') || next.startsWith('//')) {
    return fallback;
  }

  return next;
}
