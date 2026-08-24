import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2 } from "lucide-react";

interface EngineStatusProps {
  connected: boolean;
  modelReady: boolean;
  loading: boolean;
  error?: string | null;
}

/**
 * Startup feedback for the local engine.
 *
 * The embedding model takes several seconds to load on a cold start; without
 * this strip the first launch just looks like search is broken.
 */
export function EngineStatus({ connected, modelReady, loading, error }: EngineStatusProps) {
  const { t } = useTranslation();

  if (error) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 border-t border-black/5 dark:border-white/5 bg-red-50/70 dark:bg-red-950/25">
        <AlertTriangle size={13} className="text-red-500 shrink-0" />
        <span className="text-[11px] text-red-600 dark:text-red-400 truncate">
          {t("search.sidecarError", "Failed to start the AI engine.")}
        </span>
      </div>
    );
  }

  if (modelReady) return null;

  const message = !connected || loading
    ? t("search.connecting", "Connecting to AI engine...")
    : t("search.loadingModel", "Loading local AI model...");

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-t border-black/5 dark:border-white/5">
      <Loader2 size={12} className="text-neutral-400 shrink-0 animate-spin" />
      <span className="text-[11px] text-neutral-500 dark:text-neutral-400">{message}</span>
      <span className="text-[11px] text-neutral-400 dark:text-neutral-600 ml-auto truncate">
        {t("search.partialReady", "File and app search already work")}
      </span>
    </div>
  );
}
