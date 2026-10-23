// AES-256-GCM for secrets that must be read back (webhook signing secrets). The key is
// WEBHOOK_ENC_KEY, 32 random bytes in base64, kept as a Fly secret.
export async function loadSecretKey(base64: string): Promise<CryptoKey> {
  const raw = Buffer.from(base64, "base64");
  if (raw.length !== 32) throw new Error("WEBHOOK_ENC_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealSecret(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return Buffer.concat([iv, new Uint8Array(sealed)]).toString("base64");
}

export async function openSecret(key: CryptoKey, sealed: string): Promise<string> {
  const bytes = Buffer.from(sealed, "base64");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
  return new TextDecoder().decode(plain);
}
