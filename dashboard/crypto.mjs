// Passcode encryption for the cloud copy of the dashboard data. The repo and site are public,
// so everything published there is AES-256-GCM encrypted; the phone app decrypts it with
// WebCrypto using the same scheme (PBKDF2-SHA256 key, ciphertext with the tag appended).
import crypto from 'node:crypto';

const ITER = 200_000;
const key = (pass, salt) => crypto.pbkdf2Sync(pass, salt, ITER, 32, 'sha256');

export function encrypt(obj, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(pass, salt), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj)), c.final(), c.getAuthTag()]);
  return JSON.stringify({ v: 1, iter: ITER, salt: salt.toString('base64'), iv: iv.toString('base64'), data: body.toString('base64') });
}

export function decrypt(text, pass) {
  const { salt, iv, data } = JSON.parse(text);
  const buf = Buffer.from(data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(pass, Buffer.from(salt, 'base64')), Buffer.from(iv, 'base64'));
  d.setAuthTag(buf.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, -16)), d.final()]).toString());
}
