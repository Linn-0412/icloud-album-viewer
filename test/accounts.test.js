const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AccountStore } = require('../src/accounts');

async function withAccountStore(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'album-accounts-'));
  const previousEmail = process.env.ALBUM_VIEWER_ADMIN_EMAIL;
  const previousPassword = process.env.ALBUM_VIEWER_ADMIN_PASSWORD;
  const previousReset = process.env.ALBUM_VIEWER_ADMIN_RESET;

  process.env.ALBUM_VIEWER_ADMIN_EMAIL = 'admin@example.local';
  process.env.ALBUM_VIEWER_ADMIN_PASSWORD = 'old-password';
  delete process.env.ALBUM_VIEWER_ADMIN_RESET;

  try {
    const store = new AccountStore(path.join(tempDir, 'users.json'));
    await store.load();
    await fn(store);
  } finally {
    if (previousEmail === undefined) {
      delete process.env.ALBUM_VIEWER_ADMIN_EMAIL;
    } else {
      process.env.ALBUM_VIEWER_ADMIN_EMAIL = previousEmail;
    }

    if (previousPassword === undefined) {
      delete process.env.ALBUM_VIEWER_ADMIN_PASSWORD;
    } else {
      process.env.ALBUM_VIEWER_ADMIN_PASSWORD = previousPassword;
    }

    if (previousReset === undefined) {
      delete process.env.ALBUM_VIEWER_ADMIN_RESET;
    } else {
      process.env.ALBUM_VIEWER_ADMIN_RESET = previousReset;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('changes a user password only when the current password is valid', async () => {
  await withAccountStore(async (store) => {
    const user = await store.authenticate('admin@example.local', 'old-password');
    assert.ok(user);

    await assert.rejects(
      () => store.changePassword(user.id, 'wrong-password', 'new-password'),
      /現在のパスワード/
    );

    await store.changePassword(user.id, 'old-password', 'new-password');

    assert.equal(await store.authenticate('admin@example.local', 'old-password'), null);
    assert.ok(await store.authenticate('admin@example.local', 'new-password'));
  });
});

test('soft deletes a member without allowing self deletion', async () => {
  await withAccountStore(async (store) => {
    const admin = await store.authenticate('admin@example.local', 'old-password');
    assert.ok(admin);

    const invitation = await store.createInvitation('member@example.local', admin.id);
    assert.ok(store.getUserByEmail('member@example.local'));

    await assert.rejects(
      () => store.deleteUser(admin.id, admin.id),
      /自分自身/
    );

    await store.deleteUser(invitation.user.id, admin.id);

    assert.equal(store.getUserByEmail('member@example.local'), null);
    assert.equal(store.listUsers().some((user) => user.email === 'member@example.local'), false);
  });
});
