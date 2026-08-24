import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Loader2, Square } from "lucide-react";
import { clsx } from "clsx";
import type { IndexStatus } from "../hooks/useIndexStatus";

interface IndexProgressProps {
  status: IndexStatus;
  onStop?: () => void;
}

function formatEta(seconds: number): string {
  if (!seconds || seconds < 1) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Show "up to date" briefly after a run finishes, then fade the bar away. */
function useTransientComplete(status: IndexStatus["status"]): boolean {
  const [visible, setVisible] = useState(false);
  const wasIndexing = useRef(false);

  useEffect(() => {
    if (status === "indexing") {
      wasIndexing.current = true;
      setVisible(false);
      return;
    }
    if (status === "complete" && wasIndexing.current) {
      wasIndexing.current = false;
      setVisible(true);
      const timer = setTimeout(() => setVisible(false), 4000);
      return () => clearTimeout(timer);
    }
  }, [status]);

  return visible;
}

export function IndexProgress({ status, onStop }: IndexProgressProps) {
  const { t } = useTranslation();
  const showComplete = useTransientComplete(status.status);

  if (status.status === "error") {
    return (
      <div className="flex items-start gap-2 px-4 py-2 border-t border-black/5 dark:border-white/5 bg-red-50/70 dark:bg-red-950/25">
        <AlertTriangle size={13} className="text-red-500 shrink-0 mt-0.5" />
        <span className="text-[11px] leading-relaxed text-red-600 dark:text-red-400 break-all">
          {status.error ?? t("index.error", "Indexing failed")}
        </span>
      </div>
    );
  }

  if (showComplete) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 border-t border-black/5 dark:border-white/5 animate-slide-fade-in">
        <Check size={13} className="text-emerald-500 shrink-0" />
        <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
          {t("index.complete", "Index up to date")}
        </span>
        <span className="text-[11px] text-neutral-400 dark:text-neutral-600 ml-auto tabular-nums">
          {t("index.filesCount", "{{count}} files", { count: status.total })}
        </span>
      </div>
    );
  }

  if (status.status !== "indexing") return null;

  const percent = Math.min(Math.max(status.progress, 0), 100);
  const eta = formatEta(status.etaSeconds);
  // A file already up to date costs nothing to "index", so say so — otherwise a
  // run that races to 90% and then crawls looks broken.
  const fresh = Math.max(status.indexed - status.skipped, 0);

  return (
    <div className="px-4 py-2 border-t border-black/5 dark:border-white/5 animate-slide-fade-in">
      <div className="flex items-center gap-2 mb-1.5">
        <Loader2 size={12} className="text-blue-500 shrink-0 animate-spin" />
        <span className="text-[11px] font-medium text-neutral-600 dark:text-neutral-300 shrink-0">
          {t("index.indexing", "Indexing")}
        </span>

        <span
          className="text-[11px] text-neutral-400 dark:text-neutral-500 truncate min-w-0 flex-1 font-mono"
          title={status.current}
        >
          {status.current}
        </span>

        {eta && (
          <span className="text-[11px] text-neutral-400 dark:text-neutral-500 shrink-0 tabular-nums">
            {t("index.remaining", "{{eta}} left", { eta })}
          </span>
        )}

        <span className="text-[11px] text-neutral-500 dark:text-neutral-400 shrink-0 tabular-nums font-medium">
          {status.indexed.toLocaleString()}/{status.total.toLocaleString()}
        </span>

        {onStop && (
          <button
            onClick={onStop}
            title={t("index.stop", "Stop indexing")}
            className="p-1 -mr-1 rounded text-neutral-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/25 transition-colors shrink-0"
          >
            <Square size={11} className="fill-current" />
          </button>
        )}
      </div>

      <div className="h-1 rounded-full bg-neutral-200 dark:bg-neutral-700/70 overflow-hidden">
        <div
          className={clsx(
            "h-full rounded-full bg-blue-500 dark:bg-blue-400",
            "transition-[width] duration-500 ease-out",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>

      {status.skipped > 0 && (
        <div className="mt-1 text-[10px] text-neutral-400 dark:text-neutral-600 tabular-nums">
          {t("index.breakdown", "{{fresh}} read · {{skipped}} already up to date", {
            fresh: fresh.toLocaleString(),
            skipped: status.skipped.toLocaleString(),
          })}
        </div>
      )}
    </div>
  );
}
