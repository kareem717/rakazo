import { describe, expect, it } from "vitest";
import { generateTotp } from "./totp.js";

function base32(value: string) {
  let bits = "";
  for (const byte of Buffer.from(value)) bits += byte.toString(2).padStart(8, "0");
  return (bits.match(/.{1,5}/g) ?? [])
    .map((part) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Number.parseInt(part.padEnd(5, "0"), 2)])
    .join("");
}

describe("TOTP RFC 6238 test vectors", () => {
  const secrets = [
    "12345678901234567890",
    "12345678901234567890123456789012",
    "1234567890123456789012345678901234567890123456789012345678901234",
  ];
  const vectors = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ] as const;
  for (const [seconds, ...expected] of vectors) {
    for (const [index, algorithm] of ["SHA1", "SHA256", "SHA512"].entries()) {
      it(`${algorithm} at ${seconds}`, () => {
        const uri = `otpauth://totp/Test?secret=${base32(secrets[index]!)}&algorithm=${algorithm}&digits=8`;
        expect(generateTotp(uri, seconds * 1000)).toBe(expected[index]);
      });
    }
  }
  it("defaults to six digits and rotates on the time-step boundary", () => {
    const secret = base32(secrets[0]!);
    expect(generateTotp(secret, 59000)).toBe("287082");
    expect(generateTotp(secret, 59999)).toBe("287082");
    expect(generateTotp(secret, 60000)).not.toBe("287082");
  });
  it.each([
    "",
    "123456",
    "not a setup secret",
    "otpauth://hotp/Test?secret=GEZDGNBVGY3TQOJQ",
    "otpauth://totp/Test?secret=GEZDGNBVGY3TQOJQ&algorithm=MD5",
    "otpauth://totp/Test?secret=GEZDGNBVGY3TQOJQ&secret=GEZDGNBVGY3TQOJQ",
    "otpauth://totp/Test?secret=GEZDGNBVGY3TQOJQ&period=0",
  ])("rejects invalid configuration without echoing it", (value) => {
    expect(() => generateTotp(value, 59000)).toThrow("Invalid MFA secret.");
  });
});
