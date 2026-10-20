import { describe, expect, it, vi } from "vitest";
import { PipedreamConnector } from "./pipedream-connector.js";

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./tool-egress.js", () => ({ connectorFetch: network.fetch }));

describe("managed connector egress defaults", () => {
  it("uses the connector transport for OAuth tokens and API calls without a per-bot override", async () => {
    network.fetch.mockReset();
    network.fetch.mockImplementation(async (input: string) =>
      input.endsWith("/oauth/token")
        ? Response.json({ access_token: "fake-token", expires_in: 3600 })
        : Response.json({ data: [] }),
    );
    const direct = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected direct request"));
    try {
      const connector = new PipedreamConnector({
        clientId: "fake-client",
        clientSecret: "fake-secret",
        projectId: "fake-project",
        environment: "development",
        identitySecret: "fake-identity",
      });
      expect(
        await connector.listConnectedExternalIds({
          operationId: "test",
          traceId: "test",
          spaceId: "space",
          userId: "user",
          signal: new AbortController().signal,
        }),
      ).toEqual([]);
      expect(network.fetch).toHaveBeenCalledTimes(2);
      expect(network.fetch.mock.calls[0]?.[0]).toContain("/oauth/token");
      expect(network.fetch.mock.calls[1]?.[0]).toContain("/accounts?");
      expect(direct).not.toHaveBeenCalled();
    } finally {
      direct.mockRestore();
    }
  });
});
