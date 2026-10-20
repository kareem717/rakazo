import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("checks live page browser protocol failure handling offline", () => {
  for (const name of ["test_page_browser.py", "test_patchright_browser.py"]) {
    const tests = fileURLToPath(new URL(`../../computer/${name}`, import.meta.url));
    expect(() =>
      execFileSync("python3", [tests], { timeout: 10_000, stdio: "pipe" }),
    ).not.toThrow();
  }
});
