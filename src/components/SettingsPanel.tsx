import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Folder,
  FolderPlus,
  Trash2,
  RefreshCw,
  Monitor,
  Globe,
  Plus,
  X,
  BarChart3,
} from "lucide-react";
import { clsx } from "clsx";
import { ThemeToggle } from "./ThemeToggle";
import { ShortcutInput } from "./ShortcutInput";
import { getSidecarPort } from "../lib/api";

interface SettingsPanelProps {
  theme: "dark" | "light";
  onToggleTheme: () => void;
  shortcut: string;
  onShortcutChange: (shortcut: string) => void;
  folders: string[];
  onAddFolder: () => void;
  onRemoveFolder: (folder: string) => void;
  onRebuildIndex: () => void;
  autostart: boolean;
  onAutostartChange: (enabled: boolean) => void;
  maxFileSize: number;
  onMaxFileSizeChange: (size: number) => void;
  language: string;
  onLanguageChange: (lang: string) => void;
  excludePatterns: string[];
  onAddExcludePattern: (pattern: string) => void;
  onRemoveExcludePattern: (pattern: string) => void;
  onBack: () => void;
}

interface IndexStats {
  total_files: number;
  total_chunks: number;
  total_size: number;
  last_indexed: number;
  file_types: Record<string, number>;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatDate(ts: number): string {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString();
}

export function SettingsPanel({
  theme,
  onToggleTheme,
  shortcut,
  onShortcutChange,
  folders,
  onAddFolder,
  onRemoveFolder,
  onRebuildIndex,
  autostart,
  onAutostartChange,
  maxFileSize,
  onMaxFileSizeChange,
  language,
  onLanguageChange,
  excludePatterns,
  onAddExcludePattern,
  onRemoveExcludePattern,
  onBack,
}: SettingsPanelProps) {
  const { t } = useTranslation();
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [newPattern, setNewPattern] = useState("");
  const [stats, setStats] = useState<IndexStats | null>(null);

  useEffect(() => {
    const port = getSidecarPort();
    if (!port) return;
    fetch(`http://127.0.0.1:${port}/index/stats`)
      .then((r) => r.json())
      .then((d) => setStats(d))
      .catch(() => {});
  }, []);

  const handleAddPattern = () => {
    const p = newPattern.trim();
    if (p && !excludePatterns.includes(p)) {
      onAddExcludePattern(p);
      setNewPattern("");
    }
  };

  return (
    <div
      className={clsx(
        "w-full max-w-[680px] mx-auto flex flex-col",
        "bg-white dark:bg-neutral-900",
        "rounded-2xl shadow-2xl shadow-black/30 dark:shadow-black/70",
        "border border-neutral-200 dark:border-neutral-700",
        "overflow-hidden animate-fade-in",
        "max-h-[460px]",
      )}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-800 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-1 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400 transition-colors"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
            {t("settings.title")}
          </h2>
        </div>
        {!confirmRebuild ? (
          <button
            onClick={() => setConfirmRebuild(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-neutral-800 dark:bg-neutral-200 text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 transition-colors font-medium"
          >
            <RefreshCw size={13} />
            {t("settings.rebuildIndex")}
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {t("settings.rebuildConfirm")}
            </span>
            <button
              onClick={() => {
                onRebuildIndex();
                setConfirmRebuild(false);
              }}
              className="px-2.5 py-1 text-xs rounded-md bg-red-500 text-white hover:bg-red-600 transition-colors font-medium"
            >
              {t("settings.save")}
            </button>
            <button
              onClick={() => setConfirmRebuild(false)}
              className="px-2.5 py-1 text-xs rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
            >
              {t("settings.cancel")}
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Shortcut */}
        <section>
          <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-2">
            {t("settings.shortcut")}
          </label>
          <ShortcutInput value={shortcut} onChange={onShortcutChange} />
          <p className="mt-1 text-[10px] text-neutral-400 dark:text-neutral-600">
            {t("settings.shortcutDesc")}
          </p>
        </section>

        {/* Theme */}
        <section>
          <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-2">
            {t("settings.theme")}
          </label>
          <ThemeToggle
            theme={theme}
            onToggle={onToggleTheme}
            labels={{ dark: t("settings.themeDark"), light: t("settings.themeLight") }}
          />
        </section>

        {/* Language */}
        <section>
          <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-2">
            <Globe size={12} className="inline mr-1" />
            {t("settings.language")}
          </label>
          <div className="flex gap-2">
            {[
              { id: "en", label: "English" },
              { id: "tr", label: "Turkce" },
            ].map((lang) => (
              <button
                key={lang.id}
                onClick={() => onLanguageChange(lang.id)}
                className={clsx(
                  "px-3 py-1.5 text-xs rounded-lg border transition-colors",
                  language === lang.id
                    ? "bg-neutral-800 dark:bg-neutral-200 text-white dark:text-neutral-900 border-transparent"
                    : "border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800",
                )}
              >
                {lang.label}
              </button>
            ))}
          </div>
        </section>

        {/* Autostart */}
        <section className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Monitor size={14} className="text-neutral-500 dark:text-neutral-400" />
            <span className="text-xs text-neutral-700 dark:text-neutral-300">
              {t("settings.autostart")}
            </span>
          </div>
          <button
            onClick={() => onAutostartChange(!autostart)}
            className={clsx(
              "relative w-9 h-5 rounded-full transition-colors",
              autostart ? "bg-neutral-700 dark:bg-neutral-300" : "bg-neutral-300 dark:bg-neutral-700",
            )}
          >
            <div
              className={clsx(
                "absolute top-0.5 w-4 h-4 rounded-full bg-white dark:bg-neutral-900 shadow transition-transform",
                autostart ? "translate-x-4" : "translate-x-0.5",
              )}
            />
          </button>
        </section>

        {/* Max File Size */}
        <section>
          <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-2">
            {t("settings.maxFileSize")}
          </label>
          <input
            type="number"
            min={1}
            max={500}
            value={maxFileSize}
            onChange={(e) => onMaxFileSizeChange(Number(e.target.value))}
            className={clsx(
              "w-24 px-3 py-1.5 text-sm rounded-lg",
              "bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700",
              "text-neutral-800 dark:text-neutral-200 outline-none",
              "focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600",
            )}
          />
        </section>

        {/* Indexed Folders */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
              {t("settings.indexedFolders")}
            </label>
            <button
              onClick={onAddFolder}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-neutral-800 dark:bg-neutral-200 text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 transition-colors font-medium"
            >
              <FolderPlus size={13} />
              {t("settings.addFolder")}
            </button>
          </div>
          <div className="space-y-1.5">
            {folders.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-6 border border-dashed border-neutral-200 dark:border-neutral-700 rounded-lg">
                <FolderPlus size={24} className="text-neutral-300 dark:text-neutral-600" />
                <p className="text-xs text-neutral-400 dark:text-neutral-600 text-center px-4">
                  {t("settings.noFolders")}
                </p>
              </div>
            ) : (
              folders.map((folder) => (
                <div
                  key={folder}
                  className="flex items-center justify-between px-3 py-2 rounded-lg bg-neutral-50 dark:bg-neutral-800/50 group"
                >
                  <div className="flex items-center gap-2 min-w-0 mr-2">
                    <Folder size={14} className="text-neutral-400 dark:text-neutral-500 shrink-0" />
                    <span className="text-xs text-neutral-700 dark:text-neutral-300 truncate" title={folder}>
                      {folder}
                    </span>
                  </div>
                  <button
                    onClick={() => onRemoveFolder(folder)}
                    className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-neutral-400 hover:text-red-500 transition-colors shrink-0 opacity-50 group-hover:opacity-100"
                    title={t("settings.removeFolder")}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Exclude Patterns */}
        <section>
          <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-2">
            {t("settings.excludePatterns")}
          </label>
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddPattern(); }}
              placeholder={t("settings.patternPlaceholder")}
              className={clsx(
                "flex-1 px-3 py-1.5 text-xs rounded-lg",
                "bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700",
                "text-neutral-800 dark:text-neutral-200 outline-none",
                "focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600",
                "placeholder:text-neutral-400 dark:placeholder:text-neutral-600",
              )}
            />
            <button
              onClick={handleAddPattern}
              className="p-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-400 transition-colors"
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {excludePatterns.map((pattern) => (
              <span
                key={pattern}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 font-mono"
              >
                {pattern}
                <button
                  onClick={() => onRemoveExcludePattern(pattern)}
                  className="hover:text-red-500 transition-colors"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        </section>

        {/* Index Statistics */}
        {stats && stats.total_files > 0 && (
          <section>
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-2">
              <BarChart3 size={12} />
              {t("settings.stats")}
            </label>
            <div className="grid grid-cols-2 gap-2">
              <div className="px-3 py-2 rounded-lg bg-neutral-50 dark:bg-neutral-800/50">
                <div className="text-[10px] text-neutral-400 dark:text-neutral-500">{t("settings.totalFiles")}</div>
                <div className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">{stats.total_files.toLocaleString()}</div>
              </div>
              <div className="px-3 py-2 rounded-lg bg-neutral-50 dark:bg-neutral-800/50">
                <div className="text-[10px] text-neutral-400 dark:text-neutral-500">{t("settings.totalChunks")}</div>
                <div className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">{stats.total_chunks.toLocaleString()}</div>
              </div>
              <div className="px-3 py-2 rounded-lg bg-neutral-50 dark:bg-neutral-800/50">
                <div className="text-[10px] text-neutral-400 dark:text-neutral-500">{t("settings.totalSize")}</div>
                <div className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">{formatBytes(stats.total_size)}</div>
              </div>
              <div className="px-3 py-2 rounded-lg bg-neutral-50 dark:bg-neutral-800/50">
                <div className="text-[10px] text-neutral-400 dark:text-neutral-500">{t("settings.lastIndexed")}</div>
                <div className="text-[11px] font-medium text-neutral-800 dark:text-neutral-200">{formatDate(stats.last_indexed)}</div>
              </div>
            </div>
            {/* File type distribution */}
            {Object.keys(stats.file_types).length > 0 && (
              <div className="mt-2">
                <div className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-1">{t("settings.fileTypes")}</div>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(stats.file_types)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 12)
                    .map(([ext, count]) => (
                      <span
                        key={ext}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 font-mono"
                      >
                        {ext} <span className="text-neutral-400 dark:text-neutral-500">{count}</span>
                      </span>
                    ))}
                </div>
              </div>
            )}
          </section>
        )}

      </div>
    </div>
  );
}
