const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_STORE_PATH = path.join(DATA_DIR, 'users.json');
const PASSWORD_ITERATIONS = 310_000;
const PASSWORD_KEY_LENGTH = 32;
const INVITE_TTL_HOURS = 72;

class AccountError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'AccountError';
    this.statusCode = statusCode;
  }
}

class AccountStore {
  constructor(storePath = DEFAULT_STORE_PATH) {
    this.storePath = storePath;
    this.data = { users: [], invitations: [] };
  }

  async load() {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });

    try {
      const text = await fs.readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(text);
      this.data = {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        invitations: Array.isArray(parsed.invitations) ? parsed.invitations : []
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await this.ensureBootstrapAdmin();
    await this.pruneExpiredInvitations();
  }

  async ensureBootstrapAdmin() {
    const password = process.env.ALBUM_VIEWER_ADMIN_PASSWORD || process.env.ALBUM_VIEWER_PASSWORD || '';
    const email = normalizeEmail(process.env.ALBUM_VIEWER_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@example.local');
    const activeAdmins = this.data.users.filter((user) => user.role === 'admin' && !user.disabledAt);
    const resetRequested = isTruthy(process.env.ALBUM_VIEWER_ADMIN_RESET);

    if (activeAdmins.length > 0 && (!resetRequested || !password)) {
      return;
    }

    if (!password) {
      return;
    }

    const now = new Date().toISOString();
    const sameEmailUser = this.data.users.find((user) => user.email === email && !user.disabledAt);
    const admin = sameEmailUser || activeAdmins[0];

    if (admin) {
      admin.email = email;
      admin.role = 'admin';
      admin.password = hashPassword(password);
      admin.acceptedAt = admin.acceptedAt || now;
      admin.disabledAt = null;
      admin.lastLoginAt = admin.lastLoginAt || null;

      for (const user of this.data.users) {
        const isPreviousAdmin = resetRequested && activeAdmins.some((activeAdmin) => activeAdmin.id === user.id);
        const isDuplicateTargetEmail = user.email === email;
        if (user.id !== admin.id && !user.disabledAt && (isPreviousAdmin || isDuplicateTargetEmail)) {
          user.disabledAt = now;
        }
      }

      for (const invitation of this.data.invitations) {
        if (invitation.email === email && !invitation.usedAt) {
          invitation.usedAt = now;
        }
      }
    } else {
      this.data.users.push({
        id: crypto.randomUUID(),
        email,
        role: 'admin',
        password: hashPassword(password),
        createdAt: now,
        acceptedAt: now,
        disabledAt: null,
        lastLoginAt: null
      });
    }

    await this.save();
    console.log(`${resetRequested && activeAdmins.length > 0 ? 'Bootstrap admin reset' : 'Bootstrap admin created'}: ${email}`);
  }

  async save() {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, this.storePath);
  }

  hasUsers() {
    return this.data.users.some((user) => !user.disabledAt);
  }

  hasAdmins() {
    return this.data.users.some((user) => user.role === 'admin' && !user.disabledAt);
  }

  getUserById(userId) {
    return this.data.users.find((user) => user.id === userId && !user.disabledAt) || null;
  }

  getUserByEmail(email) {
    const normalized = normalizeEmail(email);
    return this.data.users.find((user) => user.email === normalized && !user.disabledAt) || null;
  }

  async authenticate(email, password) {
    const user = this.getUserByEmail(email);
    if (!user || !user.password || !verifyPassword(password, user.password)) {
      return null;
    }

    user.lastLoginAt = new Date().toISOString();
    await this.save();
    return user;
  }

  async changePassword(userId, currentPassword, newPassword) {
    validatePassword(newPassword);

    const user = this.getUserById(userId);
    if (!user || !user.password || !verifyPassword(currentPassword, user.password)) {
      throw new AccountError('現在のパスワードが違います。', 400);
    }

    user.password = hashPassword(newPassword);
    user.passwordChangedAt = new Date().toISOString();
    await this.save();

    return user;
  }

  async createInvitation(email, createdByUserId) {
    const normalizedEmail = normalizeEmail(email);
    validateEmail(normalizedEmail);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + getInviteTtlMs()).toISOString();
    const token = crypto.randomBytes(32).toString('base64url');
    let user = this.getUserByEmail(normalizedEmail);

    if (!user) {
      user = {
        id: crypto.randomUUID(),
        email: normalizedEmail,
        role: 'member',
        password: null,
        createdAt: now.toISOString(),
        acceptedAt: null,
        disabledAt: null,
        lastLoginAt: null
      };
      this.data.users.push(user);
    }

    this.data.invitations.push({
      id: crypto.randomUUID(),
      userId: user.id,
      email: normalizedEmail,
      tokenHash: hashToken(token),
      createdByUserId,
      createdAt: now.toISOString(),
      expiresAt,
      usedAt: null
    });

    await this.save();

    return {
      token,
      invitation: {
        email: normalizedEmail,
        expiresAt,
        userId: user.id
      },
      user
    };
  }

  findValidInvitation(token) {
    const tokenHash = hashToken(token);
    const invitation = this.data.invitations.find(
      (candidate) =>
        candidate.tokenHash === tokenHash &&
        !candidate.usedAt &&
        new Date(candidate.expiresAt).getTime() > Date.now()
    );

    if (!invitation) {
      return null;
    }

    const user = this.getUserById(invitation.userId);
    return user ? { invitation, user } : null;
  }

  async setPasswordWithToken(token, password) {
    validatePassword(password);

    const record = this.findValidInvitation(token);
    if (!record) {
      throw new AccountError('この設定リンクは無効または期限切れです。', 400);
    }

    const now = new Date().toISOString();
    record.user.password = hashPassword(password);
    record.user.acceptedAt = record.user.acceptedAt || now;
    record.invitation.usedAt = now;
    await this.save();

    return record.user;
  }

  listUsers() {
    const activeInvitationByUserId = new Map();
    const now = Date.now();
    for (const invitation of this.data.invitations) {
      if (invitation.usedAt || new Date(invitation.expiresAt).getTime() <= now) {
        continue;
      }

      const previous = activeInvitationByUserId.get(invitation.userId);
      if (!previous || new Date(previous.createdAt).getTime() < new Date(invitation.createdAt).getTime()) {
        activeInvitationByUserId.set(invitation.userId, invitation);
      }
    }

    return [...this.data.users]
      .filter((user) => !user.disabledAt)
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((user) => {
        const invitation = activeInvitationByUserId.get(user.id);
        return {
          id: user.id,
          email: user.email,
          role: user.role,
          createdAt: user.createdAt,
          acceptedAt: user.acceptedAt,
          lastLoginAt: user.lastLoginAt,
          inviteExpiresAt: invitation?.expiresAt || null,
          status: user.password ? 'active' : 'pending'
        };
      });
  }

  async deleteUser(userId, deletedByUserId) {
    const user = this.getUserById(userId);
    if (!user) {
      throw new AccountError('対象ユーザーが見つかりません。', 404);
    }

    if (user.id === deletedByUserId) {
      throw new AccountError('自分自身は削除できません。', 400);
    }

    if (user.role === 'admin') {
      const activeAdminCount = this.data.users.filter((candidate) => candidate.role === 'admin' && !candidate.disabledAt).length;
      if (activeAdminCount <= 1) {
        throw new AccountError('最後の管理者は削除できません。', 400);
      }
    }

    const now = new Date().toISOString();
    user.disabledAt = now;
    user.disabledByUserId = deletedByUserId;

    for (const invitation of this.data.invitations) {
      if (invitation.userId === user.id && !invitation.usedAt) {
        invitation.usedAt = now;
      }
    }

    await this.save();
    return user;
  }

  async pruneExpiredInvitations() {
    const now = Date.now();
    const before = this.data.invitations.length;
    this.data.invitations = this.data.invitations.filter((invitation) => {
      if (invitation.usedAt) {
        return true;
      }

      return new Date(invitation.expiresAt).getTime() > now;
    });

    if (this.data.invitations.length !== before) {
      await this.save();
    }
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AccountError('メールアドレスの形式が不正です。', 400);
  }
}

function validatePassword(password) {
  if (String(password || '').length < 8) {
    throw new AccountError('パスワードは8文字以上にしてください。', 400);
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, 'sha256').toString('hex');

  return {
    algorithm: 'pbkdf2-sha256',
    iterations: PASSWORD_ITERATIONS,
    salt,
    hash
  };
}

function verifyPassword(password, storedPassword) {
  if (!storedPassword?.salt || !storedPassword?.hash) {
    return false;
  }

  const storedHash = Buffer.from(storedPassword.hash, 'hex');
  if (storedHash.length !== PASSWORD_KEY_LENGTH) {
    return false;
  }

  const candidate = crypto
    .pbkdf2Sync(String(password || ''), storedPassword.salt, storedPassword.iterations || PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, 'sha256')
    .toString('hex');

  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), storedHash);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function getInviteTtlMs() {
  const hours = Number(process.env.INVITE_TTL_HOURS || INVITE_TTL_HOURS);
  return Math.max(1, hours) * 60 * 60 * 1000;
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

module.exports = {
  AccountError,
  AccountStore,
  normalizeEmail,
  validatePassword
};
