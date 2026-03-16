import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Search,
  Settings,
  X,
  Loader2,
  Cpu,
  Clock,
  FileText,
  Star,
} from "lucide-react";
import { clsx } from "clsx";
import { useSearch } from "../hooks/useSearch";
import { useIndexStatus } from "../hooks/useIndexStatus";
import { ResultsList } from "./ResultsList";
import { TabSelector } from "./TabSelector";
import { IndexProgress } from "./IndexProgress";
import { FilePreview } from "./FilePreview";
import type { RecentFile, PinnedFile, AppConfig } from "../lib/config";
import { isPinned } from "../lib/config";

interface SearchBarProps {
  onOpenSettings: () => void;
  onOpenFile: (path: string) => void;
  onOpenFolder: (path: string) => void;
  sidecarConnected: boolean;
  modelReady: boolean;
  sidecarLoading: boolean;
  searchHistory: string[];
  recentFiles: RecentFile[];
  pinnedFiles: PinnedFile[];
  onAddSearchHistory: (query: string) => void;
  onRemoveSearchHistory: (query: string) => void;
  onClearSearchHistory: () => void;
  onTogglePin: (path: string, name: string) => void;
  config: AppConfig;
  sidecarPort: number | null;
  sidecarError?: string | null;
}

export function SearchBar({
  onOpenSettings,
  onOpenFile,
  onOpenFolder,
  sidecarConnected,
  modelReady,
  sidecarLoading,
  searchHistory,
  recentFiles,
  pinnedFiles,
  onAddSearchHistory,
  onRemoveSearchHistory,
  onClearSearchHistory,
  onTogglePin,
  config,
  sidecarPort,
  sidecarError,
}: SearchBarProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputValue, setInputValue] = useState("");
  const [previewFile, setPreviewFile] = useState<{ path: string; name: string; line?: number } | null>(null);
  const { results, loading, error, activeTab, search, searchSimilar, setActiveTab, clearSearch } =
    useSearch();
  const { indexStatus } = useIndexStatus();

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [showReadyBanner, setShowReadyBanner] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (sidecarConnected && modelReady && indexStatus.status === "complete") {
      setShowReadyBanner(true);
    }
  }, [sidecarConnected, modelReady, indexStatus.status]);

  const triggerSearch = useCallback(
    (value: string) => {
      clearTimeout(debounceRef.current);
      if (!value.trim()) {
        search(value);
        return;
      }
      debounceRef.current = setTimeout(() => {
        search(value);
      }, 300);
    },
    [search],
  );

  const handleInput = useCallback(
    (value: string) => {
      setInputValue(value);
      triggerSearch(value);
    },
    [triggerSearch],
  );

  const handleClear = useCallback(() => {
    setInputValue("");
    clearSearch();
    inputRef.current?.focus();
  }, [clearSearch]);

  const handleSearchSubmit = useCallback(() => {
    if (results[selectedIndex]) {
      onOpenFile(results[selectedIndex].filePath);
    }
    if (inputValue.trim()) {
      onAddSearchHistory(inputValue.trim());
    }
  }, [results, selectedIndex, inputValue, onOpenFile, onAddSearchHistory]);

  const handleHistoryClick = useCallback(
    (query: string) => {
      setInputValue(query);
      search(query);
    },
    [search],
  );

  const handleCopyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      /* noop */
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Ctrl+1..9: open Nth result directly
      if (e.ctrlKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        if (results[idx]) {
          onOpenFile(results[idx].filePath);
          if (inputValue.trim()) onAddSearchHistory(inputValue.trim());
        }
        return;
      }

      // Ctrl+P: toggle preview
      if (e.ctrlKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (results[selectedIndex]) {
          const r = results[selectedIndex];
          setPreviewFile((prev) =>
            prev?.path === r.filePath ? null : { path: r.filePath, name: r.fileName, line: r.lineStart },
          );
        }
        return;
      }

      // Ctrl+Shift+C: copy selected result path
      if (e.ctrlKey && e.shiftKey && e.key === "C") {
        e.preventDefault();
        if (results[selectedIndex]) {
          handleCopyPath(results[selectedIndex].filePath);
        }
        return;
      }

      // Ctrl+Enter: open folder of selected result
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        if (results[selectedIndex]) {
          onOpenFolder(results[selectedIndex].filePath);
        }
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          handleSearchSubmit();
          break;
        case "Tab": {
          e.preventDefault();
          const tabs: Array<"files" | "semantic" | "apps"> = ["files", "semantic", "apps"];
          const nextIdx = (tabs.indexOf(activeTab) + 1) % tabs.length;
          const nextTab = tabs[nextIdx];
          setActiveTab(nextTab);
          if (inputValue.trim()) {
            search(inputValue, nextTab);
          }
          break;
        }
        case "Escape":
          e.preventDefault();
          if (inputValue) {
            handleClear();
          }
          break;
      }
    },
    [results, selectedIndex, activeTab, inputValue, onOpenFile, onOpenFolder, setActiveTab, search, handleClear, handleSearchSubmit, handleCopyPath, onAddSearchHistory],
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  const showStatus = !sidecarConnected || !modelReady || !!sidecarError;
  const showIdleContent = !inputValue.trim();
  const hasPinned = pinnedFiles.length > 0;
  const hasHistory = searchHistory.length > 0;
  const hasRecent = recentFiles.length > 0;
  const showIdlePanel = showIdleContent && (hasPinned || hasHistory || hasRecent);

  return (
    <div
      className={clsx(
        "w-full max-w-[680px] mx-auto",
        "bg-white dark:bg-neutral-900",
        "rounded-2xl shadow-2xl shadow-black/30 dark:shadow-black/70",
        "border border-neutral-200 dark:border-neutral-700",
        "overflow-hidden",
        "animate-fade-in",
      )}
    >
      {showStatus && (
        <div className="flex flex-col gap-1 px-4 py-2 bg-neutral-50 dark:bg-neutral-800/50 border-b border-neutral-100 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            {sidecarLoading ? (
              <Loader2 size={14} className="animate-spin text-neutral-400" />
            ) : (
              <Cpu size={14} className="text-amber-500 animate-pulse" />
            )}
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {sidecarError
                ? t("search.sidecarError")
                : !sidecarConnected
                  ? t("search.connecting")
                  : !modelReady
                    ? t("search.loadingModel")
                    : t("search.buildingIndex")}
            </span>
          </div>
          {sidecarError && (
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-red-500 dark:text-red-400 truncate max-w-[70%]">
                {sidecarError}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.location.reload()}
                  className="px-2 py-1 text-[11px] rounded-md bg-neutral-800 dark:bg-neutral-200 text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 transition-colors"
                >
                  {t("search.retry")}
                </button>
                <button
                  onClick={async () => {
                    try {
                      const { invoke } = await import("@tauri-apps/api/core");
                      await invoke("open_logs");
                    } catch {
                      // noop
                    }
                  }}
                  className="px-2 py-1 text-[11px] rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                >
                  {t("search.showLogs")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 px-4 py-3">
        {loading ? (
          <Loader2 size={20} className="animate-spin text-neutral-400 dark:text-neutral-500 shrink-0" />
        ) : (
          <Search size={20} className="text-neutral-400 dark:text-neutral-500 shrink-0" />
        )}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            !sidecarConnected || !modelReady
              ? t("search.setupPlaceholder")
              : t("search.placeholder")
          }
          className={clsx(
            "flex-1 bg-transparent outline-none",
            "text-sm text-neutral-800 dark:text-neutral-200",
            "placeholder:text-neutral-400 dark:placeholder:text-neutral-500",
          )}
          spellCheck={false}
          autoComplete="off"
          disabled={!sidecarConnected}
        />

        <div className="flex items-center gap-1.5 shrink-0">
          {inputValue && (
            <button
              onClick={handleClear}
              className="p-1 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-400 dark:text-neutral-500 transition-colors"
            >
              <X size={16} />
            </button>
          )}
          <TabSelector activeTab={activeTab} onTabChange={(tab) => {
            setActiveTab(tab);
            if (inputValue.trim()) search(inputValue, tab);
          }} />
          <button
            onClick={onOpenSettings}
            className="p-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-400 dark:text-neutral-500 transition-colors"
            title={t("settings.title")}
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {/* Divider when content below */}
      {(inputValue || showIdlePanel || indexStatus.status === "indexing" || showReadyBanner) && (
        <div className="border-t border-neutral-100 dark:border-neutral-800" />
      )}

      {showReadyBanner && (
        <div className="px-4 py-2 flex items-center justify-between text-[11px] text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20">
          <span>{t("search.ready")}</span>
          <button
            onClick={() => setShowReadyBanner(false)}
            className="text-[11px] text-emerald-700 dark:text-emerald-300 hover:underline"
          >
            {t("search.dismiss")}
          </button>
        </div>
      )}

      {/* Search results when typing */}
      {!showIdleContent && (
        <ResultsList
          results={results}
          loading={loading}
          error={error}
          query={inputValue}
          selectedIndex={selectedIndex}
          onOpenFile={(path) => {
            onOpenFile(path);
            if (inputValue.trim()) onAddSearchHistory(inputValue.trim());
          }}
          onOpenFolder={onOpenFolder}
          onTogglePin={onTogglePin}
          onCopyPath={handleCopyPath}
          onSearchSimilar={(filePath) => {
            searchSimilar(filePath);
            setInputValue(`Similar: ${filePath.split(/[\\/]/).pop()}`);
          }}
          config={config}
        />
      )}

      {/* Idle content: pinned, history, recent */}
      {showIdlePanel && (
        <div className="max-h-[340px] overflow-y-auto">
          {/* Pinned files */}
          {hasPinned && (
            <div className="px-4 pt-2 pb-1">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Star size={12} className="text-amber-500" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                  {t("search.pinnedFiles")}
                </span>
              </div>
              {pinnedFiles.map((file) => (
                <div
                  key={file.path}
                  className="group flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors animate-slide-fade-in"
                  onClick={() => onOpenFile(file.path)}
                >
                  <FileText size={14} className="text-neutral-400 shrink-0" />
                  <span className="text-xs text-neutral-700 dark:text-neutral-300 truncate flex-1">
                    {file.name}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); onTogglePin(file.path, file.name); }}
                    className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-amber-500 transition-all"
                  >
                    <Star size={12} fill="currentColor" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Search history */}
          {hasHistory && (
            <div className="px-4 pt-2 pb-1">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5">
                  <Clock size={12} className="text-neutral-400" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                    {t("search.recentSearches")}
                  </span>
                </div>
                <button
                  onClick={onClearSearchHistory}
                  className="text-[10px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
                >
                  {t("search.clearHistory")}
                </button>
              </div>
              {searchHistory.slice(0, 8).map((query, i) => (
                <div
                  key={`${query}-${i}`}
                  className="group flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors animate-slide-fade-in"
                  style={{ animationDelay: `${i * 20}ms` }}
                  onClick={() => handleHistoryClick(query)}
                >
                  <Search size={12} className="text-neutral-300 dark:text-neutral-600 shrink-0" />
                  <span className="text-xs text-neutral-600 dark:text-neutral-400 truncate flex-1">
                    {query}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); onRemoveSearchHistory(query); }}
                    className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-400 transition-all"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Recent files */}
          {hasRecent && (
            <div className="px-4 pt-2 pb-2">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Clock size={12} className="text-neutral-400" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                  {t("search.recentFiles")}
                </span>
              </div>
              {recentFiles.slice(0, 8).map((file, i) => (
                <div
                  key={file.path}
                  className="group flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors animate-slide-fade-in"
                  style={{ animationDelay: `${i * 20}ms` }}
                  onClick={() => onOpenFile(file.path)}
                >
                  <FileText size={14} className="text-neutral-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-neutral-700 dark:text-neutral-300 truncate block">
                      {file.name}
                    </span>
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-600 truncate block">
                      {file.path}
                    </span>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); onTogglePin(file.path, file.name); }}
                    className={clsx(
                      "p-0.5 rounded transition-all",
                      isPinned(config, file.path)
                        ? "text-amber-500 opacity-100"
                        : "text-neutral-400 opacity-0 group-hover:opacity-100 hover:bg-neutral-200 dark:hover:bg-neutral-700",
                    )}
                  >
                    <Star size={12} fill={isPinned(config, file.path) ? "currentColor" : "none"} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <IndexProgress status={indexStatus} />

      {/* File Preview */}
      {previewFile && (
        <FilePreview
          filePath={previewFile.path}
          fileName={previewFile.name}
          lineStart={previewFile.line}
          sidecarPort={sidecarPort}
          onClose={() => setPreviewFile(null)}
          onOpenFile={onOpenFile}
        />
      )}

      {/* Footer shortcuts */}
      {!inputValue && !showIdlePanel && (
        <div className="px-4 py-2 flex items-center justify-between text-[10px] text-neutral-400 dark:text-neutral-600 border-t border-neutral-100 dark:border-neutral-800/50">
          <span>
            <kbd className="px-1 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-500 font-mono">
              Tab
            </kbd>{" "}
            {t("search.tabFiles")}/{t("search.tabSemantic")}
          </span>
          <span>
            <kbd className="px-1 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-500 font-mono">
              Enter
            </kbd>{" "}
            {t("results.openFile")}
          </span>
          <span>
            <kbd className="px-1 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-500 font-mono">
              Esc
            </kbd>{" "}
            {t("settings.cancel")}
          </span>
        </div>
      )}
    </div>
  );
}
