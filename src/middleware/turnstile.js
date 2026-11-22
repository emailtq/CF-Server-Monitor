import { debug } from '../utils/settings.js';

async function getEncryptionKey(env, sys) {
  let secret = (sys && sys.jwt_secret) || env.TURNSTILE_SECRET_KEY || 'default_secret_key_for_turnstile_encryption';
  secret += '_turnstile';
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', new Uint8Array(hash).slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptTurnstileData(data, env, sys) {
  const key = await getEncryptionKey(env, sys);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptTurnstileData(encoded, env, sys) {
  try {
    const key = await getEncryptionKey(env, sys);
    const decoded = new Uint8Array(atob(encoded).split('').map(c => c.charCodeAt(0)));
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decoded.slice(0, 12) }, key, decoded.slice(12));
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (e) {
    debug('Cookie decryption error:', e);
    return null;
  }
}

export async function isTurnstileVerified(request, env, sys) {
  const verifiedHeader = request.headers.get('X-Turnstile-Verified');
  if (!verifiedHeader) return false;
  const decrypted = await decryptTurnstileData(verifiedHeader, env, sys);
  return decrypted && decrypted.expires && Date.now() < decrypted.expires * 1000;
}
