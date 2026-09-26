import bcrypt from 'bcryptjs'

/**
 * Mirrors internal/auth/password.go exactly: the stored hash is
 * bcrypt(base64(HMAC-SHA256(pepper, password))). Same pepper, same bytes, so
 * every hash Postgres holds verifies here unchanged.
 */
async function prepare(pepper: string, password: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(password))
  return btoa(String.fromCharCode(...new Uint8Array(mac)))
}

export async function verifyPassword(pepper: string, hash: string, password: string): Promise<boolean> {
  return bcrypt.compare(await prepare(pepper, password), hash)
}

export async function hashPassword(pepper: string, password: string): Promise<string> {
  return bcrypt.hash(await prepare(pepper, password), 10)
}

/** Burns the same time as a real verify so a missing account is not faster than a wrong password. */
export const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8i8Y6h6ZxMvwq6O8y3z1n3kq0Zu7Vi'
