import type { ScreenProxyTarget } from "@rakazo/core/node/screen-capability";

type Session = { expires: number; cookie: Promise<string> };
const sessions = new Map<string, Session>();

/** Exchange private viewer credentials on the server; never set provider cookies on the app origin. */
export async function boxScreenAuth(
  target: ScreenProxyTarget,
  capabilityPath: string,
  request: typeof fetch = fetch,
): Promise<{ path: string; cookie?: string }> {
  if (!/\.on\.(ascii|boat)\.dev$/.test(target.hostname)) return { path: target.path };
  const capability = capabilityPath.match(/^\/novnc\/session\/(?:view|control)\/([^/]+)\//)?.[0];
  if (!capability || target.protocol !== "https:") throw new Error("Invalid private viewer target");
  const url = new URL(target.path, `https://${target.hostname}:${target.port}`);
  const key = `${target.hostname}:${target.port}:${capability}`;
  for (const [key, session] of sessions) if (session.expires < Date.now()) sessions.delete(key);
  let session = sessions.get(key);
  if (!session) {
    const token = url.searchParams.get("_token");
    if (!token) throw new Error("Private viewer authentication missing");
    if (sessions.size >= 512) sessions.delete(sessions.keys().next().value!);
    const login = new URL("/", url);
    login.searchParams.set("_token", token);
    session = {
      expires: Date.now() + 60_000,
      cookie: request(login, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).then(
        async (response) => {
          const cookies = response.headers
            .getSetCookie()
            .map((value) => value.split(";", 1)[0])
            .join("; ");
          await response.body?.cancel();
          if (
            ![200, 302, 303, 307, 308].includes(response.status) ||
            !cookies ||
            cookies.length > 16384 ||
            /[\r\n]/.test(cookies)
          ) {
            throw new Error("Private viewer authentication failed");
          }
          return cookies;
        },
      ),
    };
    sessions.set(key, session);
  }
  try {
    const cookie = await session.cookie;
    if (url.pathname !== "/websockify") url.searchParams.delete("_token");
    return { path: `${url.pathname}${url.search}`, cookie };
  } catch (error) {
    if (sessions.get(key) === session) sessions.delete(key);
    throw error;
  }
}
