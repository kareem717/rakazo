import { Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { ChevronRight } from "lucide-react";

/** Only the summary the provider exposes, never internal model state. */
export function Reasoning({ text }: { text: string }) {
  return (
    <details open className="group text-muted-foreground" data-testid="reasoning">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs">
        <ChevronRight size={14} className="transition-transform group-open:rotate-90" />
        <Trans>Thinking</Trans>
      </summary>
      <div className="mt-2 text-sm">
        <ChatMarkdown streaming>{text}</ChatMarkdown>
      </div>
    </details>
  );
}
