import { afterEach, expect, it, vi } from "vitest";
import { createScreenRecovery, screenConnectionState } from "./screen-recovery.js";

afterEach(() => vi.useRealTimers());

it("coalesces failed connection signals and backs off when renewal fails", async () => {
  vi.useFakeTimers();
  const reconnect = vi.fn().mockRejectedValue(new Error("offline"));
  const recovery = createScreenRecovery(reconnect);
  recovery.state("disconnected");
  recovery.state("disconnected");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(reconnect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_999);
  expect(reconnect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(reconnect).toHaveBeenCalledTimes(2);
  recovery.dispose();
});

it("stops retrying after connection and recovers again after a later disconnect", async () => {
  vi.useFakeTimers();
  const reconnect = vi.fn(async () => {});
  const recovery = createScreenRecovery(reconnect);
  recovery.state("disconnected");
  await vi.advanceTimersByTimeAsync(1_000);
  recovery.state("connected");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(reconnect).toHaveBeenCalledTimes(1);
  recovery.state("disconnected");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(reconnect).toHaveBeenCalledTimes(2);
  recovery.dispose();
});

it("keeps backing off when a transport opens and immediately closes", async () => {
  vi.useFakeTimers();
  const reconnect = vi.fn(async () => {});
  const recovery = createScreenRecovery(reconnect);
  recovery.state("disconnected");
  await vi.advanceTimersByTimeAsync(1_000);
  recovery.state("connected");
  recovery.state("disconnected");
  await vi.advanceTimersByTimeAsync(1_999);
  expect(reconnect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(reconnect).toHaveBeenCalledTimes(2);
  recovery.dispose();
});

it("renews the displayed capability before its expiry and never overlaps slow requests", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  let finish!: () => void;
  const reconnect = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const recovery = createScreenRecovery(reconnect);
  recovery.url(`https://app.example/novnc/session/view/${Date.now() + 600_000}.fake/vnc.html`);
  recovery.state("connected");
  await vi.advanceTimersByTimeAsync(301_000);
  expect(reconnect).toHaveBeenCalledTimes(1);
  recovery.state("disconnected");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconnect).toHaveBeenCalledTimes(1);
  recovery.dispose();
  finish();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(reconnect).toHaveBeenCalledTimes(1);
});

it("recovers a stalled handshake but does not time out healthy viewers", async () => {
  vi.useFakeTimers();
  const reconnect = vi.fn(async () => {});
  const recovery = createScreenRecovery(reconnect);
  recovery.state("connecting");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(reconnect).toHaveBeenCalledTimes(1);
  recovery.state("connected");
  recovery.state("connecting");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconnect).toHaveBeenCalledTimes(1);
  recovery.dispose();
});

it("accepts only the narrow viewer event protocol", () => {
  expect(screenConnectionState({ source: "rakazo.screen", state: "connected" })).toBe("connected");
  for (const input of [
    null,
    {},
    "connected",
    { source: "other", state: "disconnected" },
    { source: "rakazo.screen", state: "takeover" },
  ]) {
    expect(screenConnectionState(input)).toBeNull();
  }
});
