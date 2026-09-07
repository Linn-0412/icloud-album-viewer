const test = require('node:test');
const assert = require('node:assert/strict');
const { formatJapanTime } = require('../src/mailer');

test('formats invitation expiration in Japan time', () => {
  assert.equal(
    formatJapanTime('2026-09-06T16:45:00.000Z'),
    '2026/09/07(月) 01:45（日本時間）'
  );
});
