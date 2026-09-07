const nodemailer = require('nodemailer');

function isMailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

async function sendInvitationEmail({ to, link, expiresAt }) {
  if (!isMailConfigured()) {
    console.log(`Invite link for ${to}: ${link}`);
    return {
      sent: false,
      reason: 'SMTP未設定のためメール送信はスキップしました。'
    };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: getSmtpPassword()
        }
      : undefined
  });

  const subject = 'iCloud Album Viewer アカウント設定';
  const formattedExpiresAt = formatJapanTime(expiresAt);
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

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    text,
    html
  });

  return { sent: true };
}

function getSmtpPassword() {
  const password = process.env.SMTP_PASS || '';
  const host = String(process.env.SMTP_HOST || '').toLowerCase();

  if (host === 'smtp.gmail.com') {
    return password.replace(/\s+/g, '');
  }

  return password;
}

function formatJapanTime(value) {
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  isMailConfigured,
  getSmtpPassword,
  formatJapanTime,
  sendInvitationEmail
};
