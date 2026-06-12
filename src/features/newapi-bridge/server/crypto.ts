import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

// New API 用户凭据（密码 / access token）落库前的应用级加密。
// 密钥来自 APIPOOL_CREDENTIALS_SECRET，任意非空字符串经 SHA-256 派生 32 字节。
// 密文格式 v1:<iv>:<tag>:<cipher>（base64），便于将来轮换算法。

const VERSION = 'v1';

function deriveKey(secret: string) {
  return createHash('sha256').update(secret).digest();
}

function getSecret() {
  const secret = process.env.APIPOOL_CREDENTIALS_SECRET || '';
  if (!secret) {
    throw new Error('APIPOOL_CREDENTIALS_SECRET is not configured');
  }
  return secret;
}

export function encryptCredential(plaintext: string, secret = getSecret()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export function decryptCredential(payload: string, secret = getSecret()) {
  const [version, ivB64, tagB64, dataB64] = payload.split(':');
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Unsupported credential payload format');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(secret),
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
