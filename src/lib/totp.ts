import crypto from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/\s+/g, "").toUpperCase();
  let bits = "";
  for (const c of clean) {
    const val = BASE32_ALPHABET.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  // Avoid BigInt: write counter as 64-bit using two 32-bit parts
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  buf[0] = (high >>> 24) & 0xff;
  buf[1] = (high >>> 16) & 0xff;
  buf[2] = (high >>> 8) & 0xff;
  buf[3] = high & 0xff;
  buf[4] = (low >>> 24) & 0xff;
  buf[5] = (low >>> 16) & 0xff;
  buf[6] = (low >>> 8) & 0xff;
  buf[7] = low & 0xff;
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  const otp = (code % 10 ** digits).toString().padStart(digits, "0");
  return otp;
}

export function totp(secretBase32: string, timeStep = 30, digits = 6, t0 = 0): string {
  const secret = base32Decode(secretBase32);
  const counter = Math.floor((Date.now() / 1000 - t0) / timeStep);
  return hotp(secret, counter, digits);
}

export function verifyTotp(code: string, secretBase32: string, window = 1, timeStep = 30, digits = 6): boolean {
  const secret = base32Decode(secretBase32);
  const current = Math.floor(Date.now() / 1000 / timeStep);
  for (let w = -window; w <= window; w++) {
    const otp = hotp(secret, current + w, digits);
    if (otp === code) return true;
  }
  return false;
}

export function randomBase32(length = 32): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (const b of bytes) {
    out += BASE32_ALPHABET[b % 32];
  }
  return out;
}

export function otpauthURL({ secret, label, issuer }: { secret: string; label: string; issuer: string }) {
  const encLabel = encodeURIComponent(label);
  const encIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${encLabel}?secret=${secret}&issuer=${encIssuer}`;
}
