// crypto.randomUUID only exists in secure contexts (https:// and http://localhost).
// The Studio Web UI is commonly opened at http://<LAN-IP>:81, which is NOT a secure
// context — unguarded calls throw TypeError on click and the button appears dead.
// Every caller uses the id as a uniqueness/idempotency key, not a secret, so a
// non-cryptographic fallback is safe.
export function clientUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`
}
