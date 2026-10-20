import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
) as {
  productName?: string;
  build?: {
    productName?: string;
    mac?: { entitlements?: string; entitlementsInherit?: string };
  };
};

describe("desktop package metadata", () => {
  it("shares the customer-facing name between Electron and electron-builder", () => {
    expect(packageJson.productName).toBe("Rakazo");
    expect(packageJson.build?.productName).toBeUndefined();
  });

  it("grants microphone access to both the hardened app and its helpers", () => {
    const mac = packageJson.build?.mac;
    expect(mac?.entitlements).toBe("assets/entitlements.mac.plist");
    expect(mac?.entitlementsInherit).toBe(mac?.entitlements);
    const entitlements = readFileSync(
      path.resolve(import.meta.dirname, "..", mac!.entitlements!),
      "utf8",
    );
    expect(entitlements).toMatch(
      /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/,
    );
    expect(entitlements).not.toContain("com.apple.security.device.camera");
  });
});
