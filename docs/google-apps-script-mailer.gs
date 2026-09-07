const MAIL_SECRET = 'replace-with-your-long-random-secret';

function doPost(e) {
  try {
    const payload = JSON.parse((e.postData && e.postData.contents) || '{}');

    if (!MAIL_SECRET || payload.secret !== MAIL_SECRET) {
      return jsonResponse({ ok: false, error: 'Unauthorized' });
    }

    const to = String(payload.to || '').trim();
    const subject = String(payload.subject || '').trim();
    const text = String(payload.text || '').trim();
    const html = String(payload.html || '').trim();
    const replyTo = String(payload.replyTo || '').trim();
    const senderName = String(payload.senderName || 'iCloud Album Viewer').trim();

    if (!to || !subject || !text) {
      return jsonResponse({ ok: false, error: 'Missing required fields' });
    }

    const options = {
      name: senderName
    };

    if (html) {
      options.htmlBody = html;
    }

    if (replyTo) {
      options.replyTo = replyTo;
    }

    MailApp.sendEmail(to, subject, text, options);

    return jsonResponse({
      ok: true,
      remainingDailyQuota: MailApp.getRemainingDailyQuota()
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: String((error && error.message) || error)
    });
  }
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
