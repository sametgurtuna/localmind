import { useTranslation } from "react-i18next";
import type { IndexStatus } from "../hooks/useIndexStatus";

interface IndexProgressProps {
  status: IndexStatus;
}

export function IndexProgress({ status }: IndexProgressProps) {
  const { t } = useTranslation();

  if (status.status === "idle" || status.status === "complete") return null;

  if (status.status === "error") {
    return (
      <div className="px-4 py-2 text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-t border-neutral-200 dark:border-neutral-700">
        {status.error ?? "Indexing error"}
      </div>
    );
  }

  return (
    <div className="px-4 py-2 border-t border-neutral-200 dark:border-neutral-700">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {t("index.progress", { percent: Math.round(status.progress) })}
        </span>
        <span className="text-xs text-neutral-400 dark:text-neutral-500">
          {status.indexed}/{status.total}
        </span>
      </div>
      <div className="h-1 rounded-full bg-neutral-200 dark:bg-neutral-700 overflow-hidden">
        <div
          className="h-full rounded-full bg-neutral-500 dark:bg-neutral-400 transition-all duration-300"
          style={{ width: `${Math.min(status.progress, 100)}%` }}
        />
      </div>
    </div>
  );
}
