import { Trans, useLingui } from "@lingui/react/macro";
import type { RunDetails } from "@rakazo/contracts";
import { humanizeToolName, isActive, normalizeRunError } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { LoadingState } from "../components/ai/primitives";
import { desktopBridge } from "../lib/desktop";
import { rosterWorkStatusLabel } from "../lib/roster-status";
import { rpc } from "../lib/rpc";
import { translateRunError } from "../lib/run-error";
import { statusLabel, statusTone } from "./ActivityList";
import { WindowChrome } from "./WindowChrome";

export function RunDetailsPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useLingui();
  const [details, setDetails] = useState<RunDetails | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    setDetails(null);
    async function load() {
      try {
        const result = await rpc.runs.get({ runId: runId! });
        if (cancelled) return;
        setDetails(result);
        setFailed(false);
        if (isActive(result.run.status)) timer = window.setTimeout(() => void load(), 3_000);
      } catch {
        if (!cancelled) {
          setFailed(true);
          timer = window.setTimeout(() => void load(), 5_000);
        }
      }
    }
    if (runId) void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [runId, revision]);
  const run = details?.run;
  const chatTo = run
    ? `${run.groupId ? `/app/g/${encodeURIComponent(run.groupId)}` : `/app/${encodeURIComponent(run.botId)}`}${details?.messageId ? `?m=${encodeURIComponent(details.messageId)}` : ""}`
    : "/app";
  function time(at: string) {
    return new Date(at).toLocaleTimeString(i18n.locale || "en", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  }
  return (
    <main
      className="h-full overflow-y-auto bg-background text-foreground"
      data-testid="run-details"
    >
      <div className="mx-auto max-w-3xl space-y-6 px-5 py-6">
        <header className="app-drag flex items-center gap-3">
          {desktopBridge() ? <WindowChrome /> : null}
          <Button
            className="app-no-drag"
            variant="ghost"
            size="icon"
            aria-label={t`Back`}
            onClick={() => navigate(-1)}
          >
            <ArrowLeft size={18} />
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-lg font-medium">
            {details?.routineName ?? run?.botName ?? t`Run activity`}
          </h1>
          {run ? (
            <Button className="app-no-drag" variant="outline" render={<Link to={chatTo} />}>
              <Trans>Open chat</Trans>
            </Button>
          ) : null}
        </header>
        {failed ? (
          <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
            <Trans>Could not load run</Trans>
            <Button variant="ghost" onClick={() => setRevision((value) => value + 1)}>
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : null}
        {!details && !failed ? <LoadingState label={t`Loading…`} /> : null}
        {details && run ? (
          <>
            <div className="space-y-2">
              <p className={`text-sm ${statusTone(run.status)}`} role="status">
                {rosterWorkStatusLabel(run.status, run.retry) ?? statusLabel(run.status)}
              </p>
              {run.retry ? (
                <p className="text-sm text-muted-foreground">
                  <Trans>Retry at {time(run.retry.at)}</Trans>
                </p>
              ) : null}
              {details.error ? (
                <div className="text-sm text-destructive">
                  <p>
                    {run.retry
                      ? t`Could not start`
                      : normalizeRunError(details.error, translateRunError, i18n.locale || "en")
                          .summary}
                  </p>
                  <details className="mt-2">
                    <summary className="cursor-pointer">
                      <Trans>Details</Trans>
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
                      {details.error}
                    </pre>
                  </details>
                </div>
              ) : null}
            </div>
            <section aria-label={t`Recent activity`}>
              <h2 className="mb-3 text-sm font-medium">
                <Trans>Recent activity</Trans>
              </h2>
              {details.tools.length ? (
                <ol className="divide-y divide-border">
                  {details.tools.map((tool) => (
                    <li key={tool.id} className="py-3" data-testid="run-tool-step">
                      <div className="flex items-baseline gap-3 text-sm">
                        <time
                          dateTime={tool.startedAt}
                          className="shrink-0 text-xs text-muted-foreground"
                        >
                          {time(tool.startedAt)}
                        </time>
                        <span className="min-w-0 flex-1 break-words">
                          {humanizeToolName(tool.name)}
                        </span>
                        <span
                          className={
                            tool.status === "failed" ? "text-destructive" : "text-muted-foreground"
                          }
                        >
                          {tool.status === "running"
                            ? t`Working…`
                            : tool.status === "succeeded"
                              ? t`Done`
                              : tool.status === "failed"
                                ? t`Failed`
                                : tool.status === "paused"
                                  ? t`Needs input`
                                  : t`Interrupted`}
                        </span>
                      </div>
                      {tool.error ? (
                        <p className="mt-1 break-words text-sm text-destructive">{tool.error}</p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">
                  <Trans>No tool activity recorded</Trans>
                </p>
              )}
            </section>
            {details.attempts.length ? (
              <details className="text-sm">
                <summary className="w-fit cursor-pointer text-muted-foreground">
                  <Trans>Attempts</Trans> · {details.attempts.length}
                </summary>
                <ol className="mt-3 divide-y divide-border">
                  {details.attempts.map((attempt) => (
                    <li key={attempt.number} className="space-y-1 py-3">
                      <p>
                        {attempt.number} · {time(attempt.startedAt)} ·{" "}
                        {attempt.status === "setup_failed" || attempt.status === "failed"
                          ? t`Failed`
                          : attempt.status === "completed"
                            ? t`Done`
                            : attempt.status === "running"
                              ? t`Working…`
                              : t`Interrupted`}
                      </p>
                      {attempt.error ? (
                        <p className="break-words text-destructive">{attempt.error}</p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </>
        ) : null}
      </div>
    </main>
  );
}
