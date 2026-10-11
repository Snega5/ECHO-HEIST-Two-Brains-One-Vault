export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomCode(alphabet: string, len: number): string {
  const n = alphabet.length, limit = 256 - (256 % n);
  let out = "";
  while (out.length < len) {
    const bytes = crypto.getRandomValues(new Uint8Array(len * 2));
    for (const b of bytes) { if (b < limit && out.length < len) out += alphabet[b % n]; }
  }
  return out;
}
