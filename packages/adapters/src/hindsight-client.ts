import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isLocalMcpHost } from "@rakazo/contracts";
import { cancelResponseBody, readBoundedJsonResponse } from "@rakazo/core";
import type { ResolveHostname } from "./network-address.js";
import { isCloudMetadataAddress, isPrivateAddress } from "./network-address.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { createPrivateNetworkFetch, createSafeRemoteFetch } from "./remote-mcp.js";
import { withAbort } from "./web-ssrf.js";

export type HindsightNetwork = RemoteTransportDependencies;
export interface HindsightConnection {
  baseUrl: string;
  apiKey: string;
  endpointTrust?: "private";
}

export class HindsightRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HindsightRequestError";
  }
}

const resolve: ResolveHostname = (host) => lookup(host, { all: true, verbatim: true });

export function normalizeHindsightUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Hindsight API URL is required and must be a valid HTTP(S) URL.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  )
    throw new Error("Hindsight API URL must use HTTP(S) without credentials, query, or fragment.");
  if (isCloudMetadataAddress(host)) throw new Error("Hindsight API URL targets a blocked address.");
  if (url.protocol === "http:" && !isLocalMcpHost(host)) {
    throw new Error("Hindsight requires HTTPS except on loopback.");
  }
  return url.href.replace(/\/+$/, "");
}

export function hindsightRequiresDeploymentOwner(settings: Record<string, string>): boolean {
  if (settings.endpointTrust === "private") return true;
  try {
    const url = new URL(normalizeHindsightUrl(settings.baseUrl ?? ""));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return (
      url.protocol === "http:" ||
      isLocalMcpHost(host) ||
      (isIP(host) !== 0 && isPrivateAddress(host))
    );
  } catch {
    return false;
  }
}

export async function classifyHindsightSettings(
  settings: Record<string, string>,
  network: HindsightNetwork = {},
): Promise<Record<string, string>> {
  const baseUrl = normalizeHindsightUrl(settings.baseUrl ?? "");
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await withAbort((network.resolveHostname ?? resolve)(host), AbortSignal.timeout(5_000));
  if (!addresses.length || addresses.some((entry) => isCloudMetadataAddress(entry.address))) {
    throw new Error("Hindsight API URL did not resolve to an allowed address.");
  }
  const result: Record<string, string> = { ...settings, baseUrl };
  if (addresses.some((entry) => isPrivateAddress(entry.address))) result.endpointTrust = "private";
  else delete result.endpointTrust;
  return result;
}

/** One bounded request, pinned DNS, no redirects or automatic write retries. */
export async function requestHindsight<T>(
  connection: HindsightConnection,
  bank: string,
  route: string,
  signal: AbortSignal,
  options: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {},
  network: HindsightNetwork = {},
): Promise<T> {
  signal.throwIfAborted();
  const baseUrl = normalizeHindsightUrl(connection.baseUrl);
  const transport = hindsightRequiresDeploymentOwner({ ...connection })
    ? createPrivateNetworkFetch(network.fetch, network.resolveHostname)
    : createSafeRemoteFetch(network.fetch, network.resolveHostname);
  try {
    const response = await transport(
      `${baseUrl}/v1/default/banks/${encodeURIComponent(bank)}/${route}`,
      {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${connection.apiKey}`,
          "Content-Type": "application/json",
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal,
      },
    );
    if (!response.ok) {
      cancelResponseBody(response);
      // Never echo an upstream error body: it may contain credentials or private memories.
      throw new HindsightRequestError(
        `Hindsight returned HTTP ${response.status}.`,
        response.status,
      );
    }
    return await readBoundedJsonResponse<T>(response, 2 * 1024 * 1024, signal);
  } finally {
    await withAbort(transport.close(), signal).catch(() => undefined);
  }
}
