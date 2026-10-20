import type { NetworkDrainDependencies } from "@rakazo/adapters";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { mountNetworkDrain } from "./network-drain.js";

const mocks = vi.hoisted(() => ({ status: vi.fn(), drain: vi.fn(), release: vi.fn() }));
vi.mock("@rakazo/adapters", () => ({
  networkApplyStatus: mocks.status,
  drainNetworkComputers: mocks.drain,
  releaseNetworkDrain: mocks.release,
}));
const operationId = "11111111-1111-4111-8111-111111111111";
function fixture() {
  vi.clearAllMocks();
  mocks.status.mockResolvedValue({ operationId, phase: "draining" });
  mocks.drain.mockResolvedValue(undefined);
  const app = new Hono();
  mountNetworkDrain(app, {} as NetworkDrainDependencies, "fake-internal-secret");
  const request = (action: string, token = "fake-internal-secret") =>
    app.request("/api/internal/network-drain", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operationId, action }),
    });
  return { request };
}
it("requires internal authentication and a currently confirmed draining operation", async () => {
  const { request } = fixture();
  expect((await request("begin", "wrong")).status).toBe(403);
  expect(mocks.status).not.toHaveBeenCalled();
  mocks.status.mockResolvedValue({ operationId, phase: "checking" });
  expect((await request("begin")).status).toBe(409);
  expect(mocks.drain).not.toHaveBeenCalled();
  mocks.status.mockResolvedValue({ operationId: "different", phase: "draining" });
  expect((await request("begin")).status).toBe(409);
});
it("drains once authorized and allows fenced cleanup after API restarts", async () => {
  const { request } = fixture();
  expect((await request("begin")).status).toBe(200);
  expect(mocks.drain).toHaveBeenCalledOnce();
  mocks.status.mockResolvedValue({ operationId, phase: "verifying" });
  expect((await request("release")).status).toBe(200);
  expect(mocks.release).toHaveBeenCalledOnce();
});
it("hides provider errors and never reports a failed checkpoint as a completed drain", async () => {
  const { request } = fixture();
  mocks.drain.mockRejectedValue(new Error("private provider diagnostic"));
  const response = await request("begin");
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("private provider");
});
