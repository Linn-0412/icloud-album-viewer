import { escapeHtml } from './http.js';
import { isAdmin } from './worker-auth.js';

export function renderLoginPage(state = {}) {
  const message = state.configMissing
    ? '管理者アカウントがまだありません。Cloudflare のシークレットに管理者メールアドレスと初期パスワードを設定してください。'
    : state.rateLimited
      ? 'ログイン試行が多すぎます。少し時間をおいてから再度お試しください。'
      : state.error
        ? 'メールアドレスまたはパスワードが違います。'
        : '';

  return renderAuthDocument({
    title: 'ログイン',
    heading: 'iCloud Album Viewer',
    lead: '共有アルバムを見るにはログインしてください。',
    body: `
      <form method="post" action="/login">
        ${state.next ? `<input name="next" type="hidden" value="${escapeHtml(state.next)}">` : ''}
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
    `
  });
}

export function renderSetPasswordPage(state = {}) {
  const message = state.invalid
    ? 'この設定リンクは無効、または期限切れです。管理者に再発行を依頼してください。'
    : state.message || '';

  return renderAuthDocument({
    title: 'パスワード設定',
    heading: 'パスワード設定',
    lead: state.email
      ? `${state.email} のパスワードを設定します。`
      : '招待リンクを確認しています。',
    body: `
      <form method="post" action="/set-password">
        <input name="token" type="hidden" value="${escapeHtml(state.token || '')}">
        <label>
          新しいパスワード
          <input name="password" type="password" autocomplete="new-password" minlength="8" required ${state.invalid ? 'disabled' : ''}>
        </label>
        <label>
          新しいパスワード確認
          <input name="passwordConfirm" type="password" autocomplete="new-password" minlength="8" required ${state.invalid ? 'disabled' : ''}>
        </label>
        <button type="submit" ${state.invalid ? 'disabled' : ''}>設定してログイン</button>
        <div class="message" role="status">${escapeHtml(message)}</div>
      </form>
    `
  });
}

export function renderAccountPage(currentUser, state = {}) {
  return renderAuthDocument({
    title: 'アカウント設定',
    heading: 'アカウント設定',
    lead: `${currentUser.email} でログイン中`,
    body: `
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
          新しいパスワード確認
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
    `
  });
}

export function renderAdminPage(currentUser, users, state = {}) {
  const rows = users.map((user) => `
    <tr>
      <td data-label="メール">${escapeHtml(user.email)}</td>
      <td data-label="権限">${escapeHtml(user.role === 'admin' ? '管理者' : 'メンバー')}</td>
      <td data-label="状態">${escapeHtml(user.status === 'active' ? '有効' : '招待中')}</td>
      <td data-label="日時">${escapeHtml(formatJapanDateTime(user.acceptedAt || user.inviteExpiresAt || user.createdAt))}</td>
      <td data-label="操作">
        ${user.id === currentUser.id
          ? '<span class="muted">本人</span>'
          : `<form class="inline-form" method="post" action="/admin/users/delete" onsubmit="return confirm('このユーザーを削除しますか？');">
              <input name="userId" type="hidden" value="${escapeHtml(user.id)}">
              <button class="danger" type="submit">削除</button>
            </form>`}
      </td>
    </tr>
  `).join('');

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>アカウント管理</title>
    ${renderAdminStyles()}
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
          <h2>新規アカウント発行</h2>
          <p>${state.mailConfigured ? 'メールAPI設定済みです。発行すると招待メールを送信します。' : 'メールAPI未設定です。発行すると招待リンクをこの画面に表示します。'}</p>
        </div>
        ${state.message ? `<div class="notice">${escapeHtml(state.message)}</div>` : ''}
        ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
        ${state.mailNotice ? `<div class="notice">${escapeHtml(state.mailNotice)}</div>` : ''}
        ${state.inviteLink ? `
          <label class="invite-link">
            招待リンク
            <input readonly value="${escapeHtml(state.inviteLink)}" onclick="this.select()">
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
          <h2>ユーザー</h2>
          <p>${users.length.toLocaleString('ja-JP')}件</p>
        </div>
        <div class="table-wrap">
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
        </div>
      </section>
    </main>
  </body>
</html>`;
}

export function renderErrorPage(message) {
  return renderAuthDocument({
    title: 'エラー',
    heading: 'エラー',
    lead: message,
    body: `
      <div class="auth-actions">
        <a class="button-link" href="/">アルバムへ戻る</a>
      </div>
    `
  });
}

export function formatJapanDateTime(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function renderAuthDocument({ title, heading, lead, body }) {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} - iCloud Album Viewer</title>
    ${renderAuthStyles()}
  </head>
  <body>
    <main class="auth-shell">
      <div>
        <h1>${escapeHtml(heading)}</h1>
        <p>${escapeHtml(lead)}</p>
      </div>
      ${body}
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
        padding: 0 14px;
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

function renderAdminStyles() {
  return `<style>
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

      h1,
      h2 {
        margin: 0;
        line-height: 1.25;
      }

      h1 {
        font-size: 22px;
      }

      h2 {
        font-size: 18px;
      }

      p {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
      }

      nav {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }

      nav form {
        margin: 0;
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
        white-space: nowrap;
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

      .table-wrap {
        width: 100%;
        overflow-x: auto;
      }

      table {
        width: 100%;
        min-width: 680px;
        border-collapse: collapse;
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
        vertical-align: middle;
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

        .table-wrap {
          overflow-x: visible;
        }

        table,
        tbody,
        tr,
        td {
          display: block;
        }

        table {
          min-width: 0;
          border: 0;
          background: transparent;
        }

        thead {
          display: none;
        }

        tr {
          padding: 10px 0;
          border: 1px solid var(--line);
          border-radius: 8px;
          background: #fff;
        }

        tr + tr {
          margin-top: 8px;
        }

        td {
          display: grid;
          grid-template-columns: 72px minmax(0, 1fr);
          gap: 10px;
          align-items: center;
          padding: 7px 10px;
          border-bottom: 0;
          overflow-wrap: anywhere;
        }

        td::before {
          content: attr(data-label);
          color: var(--muted);
          font-weight: 900;
        }
      }
    </style>`;
}
