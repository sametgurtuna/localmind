import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Search,
  Settings,
  X,
  Clock,
  FileText,
  Star,
  Sparkles,
  Trash2,
  History,
  Columns2,
} from "lucide-react";
import { useSearch, type SearchResult, type SearchTab } from "../hooks/useSearch";
import { useIndexStatus } from "../hooks/useIndexStatus";
import { ResultsList } from "./ResultsList";
import { TabSelector } from "./TabSelector";
import { IndexProgress } from "./IndexProgress";
import { EngineStatus } from "./EngineStatus";
import { FilePreview } from "./FilePreview";
import { ActionMenu } from "./ActionMenu";
import { SplitPreviewPanel } from "./SplitPreviewPanel";
import type { RecentFile, PinnedFile, AppConfig } from "../lib/config";
import { isPinned } from "../lib/config";
import { groupResults, flattenGroups } from "../lib/grouping";

interface SearchBarProps {
  onOpenSettings: () => void;
  onOpenFile: (path: string) => void;
  onOpenFolder: (path: string) => void;
  onOpenInVscode: (path: string) => void;
  onOpenInTerminal: (path: string) => void;
  onRunAsAdmin: (path: string) => void;
  onSystemCommand: (cmd: string) => void;
  onDeleteFile: (path: string) => void;
  sidecarConnected: boolean;
  modelReady: boolean;
  sidecarLoading: boolean;
  searchHistory: string[];
  recentFiles: RecentFile[];
  pinnedFiles: PinnedFile[];
  onAddSearchHistory: (query: string) => void;
  onRemoveSearchHistory: (query: string) => void;
  onClearSearchHistory: () => void;
  onClearRecentFiles?: () => void;
  onTogglePin: (path: string, name: string) => void;
  config: AppConfig;
  sidecarPort: number | null;
  sidecarError?: string | null;
}

export function SearchBar({
  onOpenSettings,
  onOpenFile,
  onOpenFolder,
  onOpenInVscode,
  onOpenInTerminal,
  onRunAsAdmin,
  onSystemCommand,
  onDeleteFile,
  sidecarConnected,
  modelReady,
  sidecarLoading,
  searchHistory,
  recentFiles,
  pinnedFiles,
  onAddSearchHistory,
  onRemoveSearchHistory,
  onClearSearchHistory,
  onClearRecentFiles,
  onTogglePin,
  config,
  sidecarPort,
  sidecarError,
}: SearchBarProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputValue, setInputValue] = useState("");
  const [previewFile, setPreviewFile] = useState<{
    path: string;
    name: string;
    line?: number;
    icon?: string;
    category?: string;
  } | null>(null);
  const [actionMenuTarget, setActionMenuTarget] = useState<SearchResult | null>(null);
  const [viewMode, setViewMode] = useState<"compact" | "split">(() => {
    try {
      return (localStorage.getItem("localmind_view_mode") as "compact" | "split") || "compact";
    } catch {
      return "compact";
    }
  });

  const handleToggleViewMode = useCallback(async (newMode?: "compact" | "split") => {
    const target = newMode ?? (viewMode === "compact" ? "split" : "compact");
    setViewMode(target);
    try {
      localStorage.setItem("localmind_view_mode", target);
      const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if (target === "split") {
        await win.setSize(new LogicalSize(960, 580));
      } else {
        await win.setSize(new LogicalSize(680, 560));
      }
    } catch (err) {
      console.warn("Window resize error:", err);
    }
  }, [viewMode]);

  useEffect(() => {
    if (viewMode === "split") {
      handleToggleViewMode("split");
    }
  }, []);

  const { results, loading, error, activeTab, search, searchSimilar, setActiveTab, clearSearch } =
    useSearch(sidecarPort);
  const { indexStatus, stopIndexing } = useIndexStatus(sidecarPort);

  // Results are shown in sections; keyboard navigation walks the same order,
  // so `ordered` — not the raw response — is what the arrow keys index into.
  const groups = useMemo(() => groupResults(results, activeTab), [results, activeTab]);
  const ordered = useMemo(() => flattenGroups(groups), [groups]);

  // A shrinking result set must never leave the cursor pointing past the end.
  useEffect(() => {
    setSelectedIndex((prev) => (prev >= ordered.length ? Math.max(ordered.length - 1, 0) : prev));
  }, [ordered.length]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Focus input on initial mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Re-focus input every time the window is shown (Ctrl+Space toggle)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        win.onFocusChanged(({ payload: focused }) => {
          if (focused) {
            // Small delay to ensure the window is fully visible
            setTimeout(() => {
              inputRef.current?.focus();
            }, 50);
          }
        }).then((fn) => { unlisten = fn; });
      })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  const triggerSearch = useCallback(
    (value: string, tab?: SearchTab) => {
      clearTimeout(debounceRef.current);
      if (!value.trim()) {
        clearSearch();
        return;
      }
      search(value, tab);
    },
    [search, clearSearch],
  );

  const handleInput = useCallback(
    (value: string) => {
      setInputValue(value);
      setSelectedIndex(0);
      triggerSearch(value);
    },
    [triggerSearch],
  );

  const handleTabChange = useCallback(
    (tab: SearchTab) => {
      setActiveTab(tab);
      setSelectedIndex(0);
      if (inputValue.trim()) {
        triggerSearch(inputValue, tab);
      }
    },
    [setActiveTab, inputValue, triggerSearch],
  );

  const handleClear = useCallback(() => {
    setInputValue("");
    clearSearch();
    inputRef.current?.focus();
  }, [clearSearch]);

  const handleCopyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      /* noop */
    }
  }, []);

  const handleExecuteResult = useCallback(
    (result: SearchResult) => {
      if (result.category === "calc" || result.category === "converter" || result.action === "copy") {
        handleCopyPath(result.filePath);
      } else if (result.category === "action" && result.action === "system_command") {
        onSystemCommand(result.filePath);
      } else {
        onOpenFile(result.filePath);
      }

      if (inputValue.trim()) {
        onAddSearchHistory(inputValue.trim());
      }
    },
    [handleCopyPath, onSystemCommand, onOpenFile, inputValue, onAddSearchHistory],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (actionMenuTarget) {
        return;
      }

      // Ctrl+K / Alt+K: Toggle Action Menu
      if ((e.ctrlKey || e.altKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (ordered[selectedIndex]) {
          setActionMenuTarget(ordered[selectedIndex]);
        }
        return;
      }

      // Ctrl+1..9: open Nth result directly
      if (e.ctrlKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        if (ordered[idx]) {
          handleExecuteResult(ordered[idx]);
        }
        return;
      }

      // Ctrl+P / Cmd+P: toggle PowerToys Peek preview
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "p" || e.code === "KeyP")) {
        e.preventDefault();
        e.stopPropagation();
        if (ordered[selectedIndex]) {
          const r = ordered[selectedIndex];
          setPreviewFile((prev) =>
            prev?.path === r.filePath
              ? null
              : {
                  path: r.filePath,
                  name: r.fileName,
                  line: r.lineStart,
                  icon: r.icon,
                  category: r.category,
                },
          );
        }
        return;
      }

      // Ctrl+Shift+C: copy selected result path
      if (e.ctrlKey && (e.key === "c" || e.key === "C") && e.shiftKey) {
        e.preventDefault();
        if (ordered[selectedIndex]) {
          handleCopyPath(ordered[selectedIndex].filePath);
        }
        return;
      }

      // Ctrl+Enter: open folder of selected result
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        if (ordered[selectedIndex]) {
          onOpenFolder(ordered[selectedIndex].filePath);
        }
        return;
      }

      // Ctrl+B / Alt+S / Ctrl+\: toggle Compact vs Split View
      if (
        ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "b" || e.code === "KeyB")) ||
        (e.altKey && (e.key.toLowerCase() === "s" || e.code === "KeyS")) ||
        ((e.ctrlKey || e.metaKey) && e.key === "\\")
      ) {
        e.preventDefault();
        e.stopPropagation();
        handleToggleViewMode();
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, ordered.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Home":
          e.preventDefault();
          setSelectedIndex(0);
          break;
        case "End":
          e.preventDefault();
          setSelectedIndex(Math.max(ordered.length - 1, 0));
          break;
        case "PageDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 5, ordered.length - 1));
          break;
        case "PageUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 5, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (ordered[selectedIndex]) {
            handleExecuteResult(ordered[selectedIndex]);
          }
          break;
        case "Tab": {
          e.preventDefault();
          const tabs: SearchTab[] = ["all", "apps", "files", "content"];
          const curIdx = tabs.indexOf(activeTab);
          const nextIdx = e.shiftKey
            ? (curIdx - 1 + tabs.length) % tabs.length
            : (curIdx + 1) % tabs.length;
          handleTabChange(tabs[nextIdx]);
          break;
        }
        case "Escape":
          e.preventDefault();
          if (previewFile) {
            setPreviewFile(null);
          } else if (inputValue) {
            handleClear();
          } else {
            // Input is already empty — hide the window
            import("@tauri-apps/api/window")
              .then(({ getCurrentWindow }) => getCurrentWindow().hide())
              .catch(() => {});
          }
          break;
      }
    },
    [actionMenuTarget, ordered, selectedIndex, handleExecuteResult, previewFile, inputValue, handleCopyPath, onOpenFolder, activeTab, handleTabChange, handleClear, handleToggleViewMode],
  );

  return (
    <div
      className={`w-full rounded-2xl bg-white/90 dark:bg-neutral-900/90 backdrop-blur-2xl border border-black/10 dark:border-white/10 shadow-2xl overflow-hidden flex flex-col transition-all duration-200 ${
        viewMode === "split" ? "max-w-5xl" : "max-w-2xl"
      }`}
    >
      {/* Search Input Bar */}
      <div className="relative flex items-center gap-3 px-4 py-3.5 border-b border-black/5 dark:border-white/5">
        <Search size={18} className="text-blue-500 shrink-0" />

        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("search.placeholder", "Search apps, files, content, math...")}
          className="flex-1 bg-transparent text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 text-sm font-medium focus:outline-none"
          autoFocus
        />

        {inputValue && (
          <button
            onClick={handleClear}
            className="p-1 rounded-full text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors"
          >
            <X size={14} />
          </button>
        )}

        <TabSelector activeTab={activeTab} onTabChange={handleTabChange} />

        {/* View Mode Toggle Button */}
        <button
          onClick={() => handleToggleViewMode()}
          className={`p-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all ${
            viewMode === "split"
              ? "bg-blue-500/15 text-blue-600 dark:text-blue-400 font-semibold"
              : "text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          }`}
          title={viewMode === "split" ? t("search.switchToCompact", "Switch to Compact Mode (Ctrl+B)") : t("search.switchToSplit", "Switch to Split View (Ctrl+B)")}
        >
          <Columns2 size={16} />
          <span className="text-[11px] hidden sm:inline">{viewMode === "split" ? t("search.split", "Split") : t("search.compact", "Compact")}</span>
        </button>

        <button
          onClick={onOpenSettings}
          className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          title={t("settings.title", "Settings")}
        >
          <Settings size={16} />
        </button>
      </div>

      {/* Engine startup, then indexing progress */}
      <EngineStatus
        connected={sidecarConnected}
        modelReady={modelReady}
        loading={sidecarLoading}
        error={sidecarError}
      />
      <IndexProgress status={indexStatus} onStop={stopIndexing} />

      {/* Main Results or Empty State */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Column: Results or Empty State */}
        <div
          className={`flex-1 min-w-0 flex flex-col overflow-y-auto ${
            viewMode === "split" ? "border-r border-black/5 dark:border-white/5" : ""
          }`}
        >
          {inputValue.trim() ? (
            <ResultsList
              groups={groups}
              loading={loading}
              error={error}
              query={inputValue}
              selectedIndex={selectedIndex}
              activeTab={activeTab}
              onSelectIndex={setSelectedIndex}
              onOpenResult={handleExecuteResult}
              onOpenActionMenu={(res) => setActionMenuTarget(res)}
              onOpenPreview={(res) =>
                setPreviewFile({
                  path: res.filePath,
                  name: res.fileName,
                  line: res.lineStart,
                  icon: res.icon,
                  category: res.category,
                })
              }
              config={config}
            />
          ) : (
            /* Empty State: Quick Access, Pinned, Recent Searches & Recent Files */
            <div className="p-4 space-y-4 max-h-[380px] overflow-y-auto">
              {/* Pinned Files */}
              {pinnedFiles.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-2">
                    <Star size={12} className="text-amber-400 fill-amber-400" />
                    <span>{t("search.pinnedFiles", "Pinned")}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {pinnedFiles.map((pf) => (
                      <div
                        key={pf.path}
                        onClick={() => onOpenFile(pf.path)}
                        className="flex items-center gap-2 px-3 py-2 rounded-xl bg-neutral-50 dark:bg-neutral-800/40 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer border border-black/5 dark:border-white/5 transition-all text-xs text-neutral-800 dark:text-neutral-200 font-medium truncate"
                      >
                        <FileText size={14} className="text-blue-500 shrink-0" />
                        <span className="truncate">{pf.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent Searches */}
              {searchHistory && searchHistory.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">
                      <History size={12} />
                      <span>{t("search.recentSearches", "Recent Searches")}</span>
                    </div>
                    <button
                      onClick={onClearSearchHistory}
                      className="text-[11px] text-neutral-400 hover:text-rose-500 dark:hover:text-rose-400 flex items-center gap-1 transition-colors px-1.5 py-0.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
                      title={t("search.clearHistory", "Clear")}
                    >
                      <Trash2 size={11} />
                      <span>{t("search.clearHistory", "Clear")}</span>
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {searchHistory.slice(0, 8).map((queryText) => (
                      <div
                        key={queryText}
                        onClick={() => {
                          setInputValue(queryText);
                          triggerSearch(queryText);
                        }}
                        className="group flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-neutral-100/80 dark:bg-neutral-800/60 hover:bg-neutral-200/80 dark:hover:bg-neutral-700/60 cursor-pointer transition-all text-xs text-neutral-700 dark:text-neutral-300 font-medium"
                      >
                        <span>{queryText}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveSearchHistory?.(queryText);
                          }}
                          className="opacity-0 group-hover:opacity-100 hover:text-rose-500 p-0.5 rounded transition-opacity"
                          title="Remove"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent Files */}
              {recentFiles.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">
                      <Clock size={12} />
                      <span>{t("search.recentFiles", "Recent Files")}</span>
                    </div>
                    {onClearRecentFiles && (
                      <button
                        onClick={onClearRecentFiles}
                        className="text-[11px] text-neutral-400 hover:text-rose-500 dark:hover:text-rose-400 flex items-center gap-1 transition-colors px-1.5 py-0.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
                        title={t("search.clearHistory", "Clear")}
                      >
                        <Trash2 size={11} />
                        <span>{t("search.clearHistory", "Clear")}</span>
                      </button>
                    )}
                  </div>
                  <div className="space-y-1">
                    {recentFiles.slice(0, 5).map((rf) => (
                      <div
                        key={rf.path}
                        onClick={() => onOpenFile(rf.path)}
                        className="flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-neutral-100/70 dark:hover:bg-neutral-800/50 cursor-pointer transition-colors text-xs text-neutral-700 dark:text-neutral-300"
                      >
                        <div className="flex items-center gap-2 truncate">
                          <FileText size={13} className="text-neutral-400 shrink-0" />
                          <span className="truncate font-medium">{rf.name}</span>
                        </div>
                        <span className="text-[10px] text-neutral-400 truncate max-w-[180px] ml-2">
                          {rf.path}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Quick Tips */}
              <div className="pt-2 border-t border-black/5 dark:border-white/5 flex items-center gap-1.5 text-[11px] text-neutral-400 dark:text-neutral-500">
                <Sparkles size={12} className="text-amber-500 shrink-0" />
                <span>
                  {t("search.tipMath", "Type math like {{math}}, or an app name like {{app}}", {
                    math: "150 * 4",
                    app: "calc",
                    interpolation: { escapeValue: false },
                  })}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Live Split Preview Panel (Only in Split View) */}
        {viewMode === "split" && (
          <div className="w-[380px] shrink-0 hidden sm:flex flex-col min-h-0">
            <SplitPreviewPanel
              result={ordered[selectedIndex] ?? null}
              onOpenFile={onOpenFile}
              onOpenFolder={onOpenFolder}
              onOpenInVscode={onOpenInVscode}
              onOpenInTerminal={onOpenInTerminal}
              onRunAsAdmin={onRunAsAdmin}
              onCopyPath={handleCopyPath}
            />
          </div>
        )}
      </div>

      {/* PowerToys Peek Modal Preview */}
      {previewFile && (
        <FilePreview
          filePath={previewFile.path}
          fileName={previewFile.name}
          lineStart={previewFile.line}
          icon={previewFile.icon}
          category={previewFile.category}
          onClose={() => setPreviewFile(null)}
          onOpenFile={() => onOpenFile(previewFile.path)}
          onOpenFolder={onOpenFolder}
        />
      )}

      {/* Raycast Action Menu Modal */}
      {actionMenuTarget && (
        <ActionMenu
          isOpen={true}
          onClose={() => setActionMenuTarget(null)}
          result={actionMenuTarget}
          onOpenFile={onOpenFile}
          onOpenFolder={onOpenFolder}
          onOpenInVscode={onOpenInVscode}
          onOpenInTerminal={onOpenInTerminal}
          onRunAsAdmin={onRunAsAdmin}
          onCopyPath={handleCopyPath}
          onTogglePreview={() => {
            setPreviewFile({
              path: actionMenuTarget.filePath,
              name: actionMenuTarget.fileName,
              line: actionMenuTarget.lineStart,
              icon: actionMenuTarget.icon,
              category: actionMenuTarget.category,
            });
          }}
          onTogglePin={onTogglePin}
          onSearchSimilar={searchSimilar}
          onDeleteFile={onDeleteFile}
          isPinned={isPinned(config, actionMenuTarget.filePath)}
        />
      )}

      {/* Raycast-style Status Footer */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-black/5 dark:border-white/5 bg-neutral-50/50 dark:bg-neutral-900/50 text-[11px] text-neutral-400 dark:text-neutral-500 select-none">
        <div className="flex items-center gap-3 min-w-0 overflow-hidden">
          {[
            { keys: "↵", label: t("results.hintOpen", "Open") },
            { keys: "Ctrl+↵", label: t("results.hintFolder", "Folder") },
            { keys: "Ctrl+P", label: t("results.hintPreview", "Preview") },
            { keys: "Ctrl+B", label: viewMode === "split" ? t("search.compact", "Compact") : t("search.split", "Split") },
            { keys: "Tab", label: t("results.hintFilter", "Filter") },
          ].map((hint) => (
            <span key={hint.keys} className="flex items-center gap-1 shrink-0">
              <kbd className="px-1 py-0.5 rounded bg-neutral-200/60 dark:bg-neutral-800 font-mono text-[10px]">
                {hint.keys}
              </kbd>
              <span>{hint.label}</span>
            </span>
          ))}
        </div>

        <button
          onClick={() => {
            if (ordered[selectedIndex]) setActionMenuTarget(ordered[selectedIndex]);
          }}
          className="flex items-center gap-1 shrink-0 ml-3 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors cursor-pointer"
        >
          <span>{t("results.actions", "Actions")}</span>
          <kbd className="px-1 py-0.5 rounded bg-neutral-200/60 dark:bg-neutral-800 font-mono text-[10px]">
            Ctrl+K
          </kbd>
        </button>
      </div>
    </div>
  );
}
