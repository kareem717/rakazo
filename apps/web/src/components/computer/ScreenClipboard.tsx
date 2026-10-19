import { useLingui } from "@lingui/react/macro";
import type { ScreenControlCommand } from "@rakazo/core";
import { Button, Popover, PopoverContent, PopoverTrigger, Switch, Textarea } from "@rakazo/ui-web";
import { Clipboard, Copy, CornerUpLeft, CornerUpRight, Scissors, TextSelect } from "lucide-react";
import { useRef, useState } from "react";

/** Clipboard permissions stay in the app window, never in the sandboxed viewer. */
export function ScreenClipboard({
  text,
  sync,
  onSync,
  onCommand,
}: {
  text: string;
  sync: boolean;
  onSync: (enabled: boolean) => void;
  onCommand: (command: ScreenControlCommand) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const value = draft ?? text;
  const shortcut = (key: "a" | "c" | "x" | "z" | "y") => onCommand({ request: "shortcut", key });
  return (
    <div className="absolute right-3 bottom-3 z-20">
      <Popover
        onOpenChange={(open) => {
          if (open) {
            setDraft(null);
            setFailed(false);
            onCommand({ request: "clipboard" });
          }
        }}
      >
        <PopoverTrigger
          render={<Button variant="outline" size="icon-sm" aria-label={t`Clipboard`} />}
        >
          <Clipboard size={16} />
        </PopoverTrigger>
        <PopoverContent side="top" align="end">
          <div className="flex gap-1">
            {[
              { key: "a", label: t`Select all`, icon: <TextSelect size={16} /> },
              { key: "x", label: t`Cut`, icon: <Scissors size={16} /> },
              { key: "c", label: t`Copy selection`, icon: <Copy size={16} /> },
              { key: "z", label: t`Undo`, icon: <CornerUpLeft size={16} /> },
              { key: "y", label: t`Redo`, icon: <CornerUpRight size={16} /> },
            ].map((action) => (
              <Button
                key={action.key}
                variant="ghost"
                size="icon-sm"
                aria-label={action.label}
                title={action.label}
                onClick={() => shortcut(action.key as "a" | "c" | "x" | "z" | "y")}
              >
                {action.icon}
              </Button>
            ))}
          </div>
          <Textarea
            ref={field}
            aria-label={t`Clipboard text`}
            placeholder={t`Paste text`}
            value={value}
            maxLength={1_048_576}
            onChange={(event) => setDraft(event.target.value)}
            className="max-h-48 min-h-20"
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(value).catch(() => {
                  field.current?.focus();
                  field.current?.select();
                  setFailed(true);
                });
              }}
            >
              {t`Copy`}
            </Button>
            <Button
              size="sm"
              disabled={!value}
              onClick={() => onCommand({ request: "paste", text: value })}
            >
              {t`Paste`}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void navigator.clipboard.readText().then(
                  (text) => {
                    setDraft(text);
                    onCommand({ request: "paste", text });
                  },
                  () => {
                    field.current?.focus();
                    setFailed(true);
                  },
                );
              }}
            >
              {t`From device`}
            </Button>
          </div>
          {failed ? (
            <p className="text-xs text-muted-foreground">{t`Use the text field to copy or paste.`}</p>
          ) : null}
          <label className="flex items-center justify-between gap-3 text-xs">
            {t`Sync clipboard`}
            <Switch size="sm" checked={sync} onCheckedChange={onSync} />
          </label>
        </PopoverContent>
      </Popover>
    </div>
  );
}
