import { AppError, escapeHtml } from './http.js';

export function isWorkerMailConfigured(env) {
  return getWorkerMailStatus(env).configured;
}

export function getWorkerMailStatus(env) {
  const googleWebhook = getGoogleWebhookConfig(env);
  if (googleWebhook.hasAnySetting) {
    return {
      configured: googleWebhook.configured,
      provider: 'Google Apps Script',
      from: googleWebhook.from
    };
  }

  const resend = getResendConfig(env);

  return {
    configured: resend.configured,
    provider: resend.hasAnySetting ? 'Resend' : '',
    from: resend.from
  };
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

  return sendEmail(env, { to, subject, text, html });
}

export async function sendTestEmail(env, { to }) {
  if (!isWorkerMailConfigured(env)) {
    return {
      sent: false,
      reason: 'メールAPI未設定のため、テストメールは送信できません。'
    };
  }

  return sendEmail(env, {
    to,
    subject: 'iCloud Album Viewer テストメール',
    text: [
      'iCloud Album Viewer からのテストメールです。',
      '',
      'このメールが届いていれば、招待メールの自動送信設定は有効です。'
    ].join('\n'),
    html: `
      <p>iCloud Album Viewer からのテストメールです。</p>
      <p>このメールが届いていれば、招待メールの自動送信設定は有効です。</p>
    `
  });
}

async function sendEmail(env, { to, subject, text, html }) {
  const googleWebhook = getGoogleWebhookConfig(env);
  if (googleWebhook.configured) {
    return sendGoogleWebhookEmail(env, googleWebhook, { to, subject, text, html });
  }

  const resend = getResendConfig(env);
  if (!resend.configured) {
    return {
      sent: false,
      reason: 'メールAPI未設定のため、メールは送信できません。'
    };
  }

  return sendResendEmail(env, resend, { to, subject, text, html });
}

async function sendGoogleWebhookEmail(env, config, { to, subject, text, html }) {
  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      secret: config.secret,
      to,
      subject,
      text,
      html,
      replyTo: env.MAIL_REPLY_TO || env.ALBUM_VIEWER_ADMIN_EMAIL || '',
      senderName: env.MAIL_SENDER_NAME || 'iCloud Album Viewer'
    })
  });

  const responseText = await response.text();
  const payload = parseJsonResponse(responseText);

  if (!response.ok || payload.ok === false) {
    const message = payload.error || response.statusText || responseText || 'Unknown error';
    throw new AppError(`メール送信に失敗しました: ${message}`, 502);
  }

  return { sent: true, provider: 'Google Apps Script' };
}

async function sendResendEmail(env, config, { to, subject, text, html }) {
  const payload = {
    from: config.from,
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
      Authorization: `Bearer ${config.apiKey}`,
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

function parseJsonResponse(value) {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
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

function getGoogleWebhookConfig(env) {
  const url = env.GOOGLE_MAIL_WEBHOOK_URL || env.GOOGLE_APPS_SCRIPT_WEBHOOK_URL || '';
  const secret = env.GOOGLE_MAIL_WEBHOOK_SECRET || env.GOOGLE_APPS_SCRIPT_SECRET || '';
  const from = env.GMAIL_FROM || env.MAIL_REPLY_TO || env.ALBUM_VIEWER_ADMIN_EMAIL || '';

  return {
    url,
    secret,
    from,
    configured: Boolean(url && secret),
    hasAnySetting: Boolean(url || secret || env.GMAIL_FROM)
  };
}

function getResendConfig(env) {
  const from = env.MAIL_FROM || env.RESEND_FROM || '';
  const apiKey = env.RESEND_API_KEY || '';

  return {
    apiKey,
    from,
    configured: Boolean(apiKey && from),
    hasAnySetting: Boolean(apiKey || from)
  };
}
