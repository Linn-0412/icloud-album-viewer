import { AppError, escapeHtml } from './http.js';

export function isWorkerMailConfigured(env) {
  return Boolean(env.RESEND_API_KEY && getMailFrom(env));
}

export async function sendInvitationEmail(env, { to, link, expiresAt }) {
  if (!isWorkerMailConfigured(env)) {
    return {
      sent: false,
      reason: 'メールAPI未設定のため、招待メールは送信せずリンクを表示しました。'
    };
  }

  const formattedExpiresAt = formatJapanTime(expiresAt);
  const subject = 'iCloud Album Viewer アカウント設定';
  const text = [
    'iCloud Album Viewer のアカウントが発行されました。',
    '',
    '以下のリンクを開いてパスワードを設定してください。',
    link,
    '',
    `有効期限: ${formattedExpiresAt}`
  ].join('\n');
  const html = `
    <p>iCloud Album Viewer のアカウントが発行されました。</p>
    <p>以下のリンクを開いてパスワードを設定してください。</p>
    <p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
    <p>有効期限: ${escapeHtml(formattedExpiresAt)}</p>
  `;

  const payload = {
    from: getMailFrom(env),
    to: [to],
    subject,
    text,
    html
  };

  if (env.MAIL_REPLY_TO) {
    payload.reply_to = env.MAIL_REPLY_TO;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    const message = errorPayload.message || errorPayload.error || response.statusText;
    throw new AppError(`メール送信に失敗しました: ${message}`, 502);
  }

  return { sent: true };
}

export function formatJapanTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return String(value || '');
  }

  return `${new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date)}（日本時間）`;
}

function getMailFrom(env) {
  return env.MAIL_FROM || env.RESEND_FROM || '';
}
