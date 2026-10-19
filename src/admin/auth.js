import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const validHash = value => typeof value === 'string' && /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value);
export const token = () => randomBytes(32).toString('hex');
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('A senha deve ter entre 12 e 256 caracteres.');
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v1$${salt}$${(await derive(password, salt, 64)).toString('hex')}`;
}
export async function verifyPassword(password, hash) {
  if (!validHash(hash) || typeof password !== 'string' || password.length > 256) return false;
  const [, salt, expected] = hash.split('$');
  return equal((await derive(password, salt, 64)).toString('hex'), expected);
}
