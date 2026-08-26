import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import { Keyboard, RotateCcw } from "lucide-react";

interface ShortcutInputProps {
  value: string;
  onChange: (shortcut: string) => void;
}

function formatKeyCombo(e: KeyboardEvent): { combo?: string; isCancel?: boolean } | null {
  if (e.key === "Escape") {
    return { isCancel: true };
  }

  const parts: string[] = [];

  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");

  const key = e.key;
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) {
    return null;
  }

  let mainKey = "";
  if (e.code === "Space" || key === " ") {
    mainKey = "Space";
  } else if (/^F([1-9]|1[0-2])$/i.test(key)) {
    mainKey = key.toUpperCase();
  } else if (key.length === 1) {
    mainKey = key.toUpperCase();
  } else if (["Tab", "Enter", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown"].includes(key)) {
    mainKey = key;
  } else {
    return null;
  }

  // Require at least one modifier key unless it's a Function key (F1-F12)
  const isFunctionKey = /^F([1-9]|1[0-2])$/i.test(mainKey);
  if (parts.length === 0 && !isFunctionKey) {
    return null;
  }

  parts.push(mainKey);
  return { combo: parts.join("+") };
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

      const result = formatKeyCombo(e.nativeEvent);
      if (!result) return;

      if (result.isCancel) {
        setRecording(false);
        return;
      }

      if (result.combo) {
        onChange(result.combo);
        setRecording(false);
      }
    },
    [recording, onChange],
  );

  const startRecording = useCallback(() => {
    setRecording(true);
    inputRef.current?.focus();
  }, []);

  const handleReset = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onChange("Ctrl+Space");
      setRecording(false);
    },
    [onChange],
  );

  const keys = (value || "Ctrl+Space").split("+");

  return (
    <div className="flex items-center gap-2">
      <div
        ref={inputRef}
        tabIndex={0}
        role="button"
        onClick={startRecording}
        onKeyDown={handleKeyDown}
        onBlur={() => setRecording(false)}
        className={clsx(
          "flex-1 flex items-center justify-between gap-2 px-3 py-2 rounded-lg cursor-pointer outline-none transition-all",
          "border select-none",
          recording
            ? "border-neutral-500 dark:border-neutral-400 bg-neutral-50 dark:bg-neutral-800 ring-2 ring-neutral-300 dark:ring-neutral-600"
            : "border-neutral-200 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800/80 hover:border-neutral-300 dark:hover:border-neutral-600",
        )}
      >
        <div className="flex items-center gap-2">
          <Keyboard size={15} className="text-neutral-500 dark:text-neutral-400 shrink-0" />
          {recording ? (
            <span className="text-xs text-neutral-600 dark:text-neutral-300 font-medium animate-pulse">
              {t("settings.pressKeys")}
            </span>
          ) : (
            <div className="flex items-center gap-1">
              {keys.map((k, i) => (
                <span key={i} className="flex items-center gap-1">
                  <kbd className="px-2 py-0.5 text-xs font-semibold font-mono rounded bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 border border-neutral-200 dark:border-neutral-700 shadow-2xs">
                    {k}
                  </kbd>
                  {i < keys.length - 1 && (
                    <span className="text-xs text-neutral-400 dark:text-neutral-500 font-medium">+</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>

        <span className="text-[11px] text-neutral-400 dark:text-neutral-500 font-medium">
          {recording ? "Esc: ✕" : t("settings.shortcutDesc")}
        </span>
      </div>

      {value !== "Ctrl+Space" && (
        <button
          type="button"
          onClick={handleReset}
          title={t("settings.shortcutReset")}
          className="p-2 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors cursor-pointer"
        >
          <RotateCcw size={14} />
        </button>
      )}
    </div>
  );
}
