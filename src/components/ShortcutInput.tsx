import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import { Keyboard } from "lucide-react";

interface ShortcutInputProps {
  value: string;
  onChange: (shortcut: string) => void;
}

function formatKeyCombo(e: KeyboardEvent): string | null {
  const parts: string[] = [];

  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");

  const key = e.key;
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null;

  if (key === " ") parts.push("Space");
  else if (key.length === 1) parts.push(key.toUpperCase());
  else parts.push(key);

  return parts.join("+");
}

export function ShortcutInput({ value, onChange }: ShortcutInputProps) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const inputRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      const combo = formatKeyCombo(e.nativeEvent);
      if (combo) {
        onChange(combo);
        setRecording(false);
      }
    },
    [recording, onChange],
  );

  const startRecording = useCallback(() => {
    setRecording(true);
    inputRef.current?.focus();
  }, []);

  return (
    <div
      ref={inputRef}
      tabIndex={0}
      role="button"
      onClick={startRecording}
      onKeyDown={handleKeyDown}
      onBlur={() => setRecording(false)}
      className={clsx(
        "flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer outline-none transition-all",
        "border",
        recording
          ? "border-neutral-500 dark:border-neutral-400 bg-neutral-50 dark:bg-neutral-800 ring-2 ring-neutral-300 dark:ring-neutral-600"
          : "border-neutral-200 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-600",
      )}
    >
      <Keyboard size={16} className="text-neutral-500 dark:text-neutral-400 shrink-0" />
      <span
        className={clsx(
          "text-sm",
          recording
            ? "text-neutral-500 dark:text-neutral-400 animate-pulse"
            : "text-neutral-800 dark:text-neutral-200 font-mono",
        )}
      >
        {recording ? t("settings.pressKeys") : value}
      </span>
    </div>
  );
}
