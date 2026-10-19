import { describe, expect, it, vi } from "vitest";
import { boxScreenAuth } from "./box-screen-auth.js";

const target = {
  interactive: false,
  protocol: "https:",
  hostname: "viewer.on.ascii.dev",
  port: 443,
  path: "/vnc.html?_token=fake-provider-token&resize=scale",
} as const;
describe("private viewer authentication", () => {
  it("keeps provider cookies server-side and scoped to the authorized screen", async () => {
    const request = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { "set-cookie": "viewer=fake-session; Secure; HttpOnly; Path=/", location: "/" },
        }),
    ) as unknown as typeof fetch;
    const capability = "/novnc/session/view/fake-capability/vnc.html";
    const auth = await boxScreenAuth(target, capability, request);
    expect(auth).toEqual({ path: "/vnc.html?resize=scale", cookie: "viewer=fake-session" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(request).mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(
      await boxScreenAuth(
        { ...target, path: "/app/ui.js" },
        "/novnc/session/view/fake-capability/app/ui.js",
        request,
      ),
    ).toEqual({ path: "/app/ui.js", cookie: "viewer=fake-session" });
    expect(
      await boxScreenAuth(
        { ...target, path: "/websockify?_token=fake-provider-token&token=fake-vnc-token" },
        "/novnc/session/view/fake-capability/websockify",
        request,
      ),
    ).toEqual({
      path: "/websockify?_token=fake-provider-token&token=fake-vnc-token",
      cookie: "viewer=fake-session",
    });
    await expect(
      boxScreenAuth(
        { ...target, path: "/app/ui.js" },
        "/novnc/session/view/other-capability/app/ui.js",
        request,
      ),
    ).rejects.toThrow("authentication missing");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("fails closed when the provider rejects login", async () => {
    const request = vi.fn(
      async () => new Response(null, { status: 403 }),
    ) as unknown as typeof fetch;
    await expect(
      boxScreenAuth(target, "/novnc/session/view/rejected/vnc.html", request),
    ).rejects.toThrow("authentication failed");
  });
  it("leaves other providers unchanged", async () => {
    const request = vi.fn() as unknown as typeof fetch;
    const other = { ...target, hostname: "desktop.example.test" };
    expect(await boxScreenAuth(other, "/novnc/session/view/another/vnc.html", request)).toEqual({
      path: target.path,
    });
    expect(request).not.toHaveBeenCalled();
  });
});
