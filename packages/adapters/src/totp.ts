import { createHmac } from "node:crypto";
import { parseTotpSecret } from "@rakazo/contracts";

/** RFC 6238: generated only in the backend, immediately before a protected page fill. */
export function generateTotp(secret: string, now = Date.now()): string {
  const { key, algorithm, digits, period } = parseTotpSecret(secret);
  if (!Number.isFinite(now) || now < 0) throw new Error("Invalid MFA clock");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
  const hash = createHmac(algorithm, key).update(counter).digest();
  const offset = hash[hash.length - 1]! & 15;
  const binary = hash.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}
