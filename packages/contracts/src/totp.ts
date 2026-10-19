/** Parse an authenticator setup key without fetching URLs or exposing it in validation errors. */
export function parseTotpSecret(input: string): {
  key: Uint8Array;
  algorithm: "sha1" | "sha256" | "sha512";
  digits: number;
  period: number;
} {
  const invalid = () =>
    new Error("Invalid MFA secret. Use a Base32 setup key or a TOTP otpauth URI.");
  if (input.length > 2048) throw invalid();
  let secret = input.trim();
  let algorithm: "sha1" | "sha256" | "sha512" = "sha1";
  let digits = 6;
  let period = 30;
  if (secret.toLowerCase().startsWith("otpauth:")) {
    let url: URL;
    try {
      url = new URL(secret);
    } catch {
      throw invalid();
    }
    if (
      url.protocol !== "otpauth:" ||
      url.hostname !== "totp" ||
      url.username ||
      url.password ||
      url.hash
    )
      throw invalid();
    for (const name of ["secret", "algorithm", "digits", "period"])
      if (url.searchParams.getAll(name).length > 1) throw invalid();
    secret = url.searchParams.get("secret") ?? "";
    const hash = (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase();
    if (hash !== "sha1" && hash !== "sha256" && hash !== "sha512") throw invalid();
    algorithm = hash;
    const digitValue = url.searchParams.get("digits") ?? "6";
    const periodValue = url.searchParams.get("period") ?? "30";
    if (!/^[678]$/.test(digitValue) || !/^\d{1,3}$/.test(periodValue)) throw invalid();
    digits = Number(digitValue);
    period = Number(periodValue);
    if (period < 1 || period > 300) throw invalid();
  }
  secret = secret.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z2-7]{16,1024}={0,6}$/.test(secret)) throw invalid();
  const unpadded = secret.replace(/=+$/, "");
  const padding = secret.length - unpadded.length;
  if (padding && (secret.length % 8 !== 0 || padding !== (8 - (unpadded.length % 8)) % 8))
    throw invalid();
  secret = unpadded;
  if (![0, 2, 4, 5, 7].includes(secret.length % 8)) throw invalid();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  if (value !== 0) throw invalid();
  return { key: Uint8Array.from(bytes), algorithm, digits, period };
}
