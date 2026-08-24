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
  Gauge,
  Keyboard,
  ScanText,
  Zap,
  AlertTriangle,
  SunMoon,
  HardDrive,
} from "lucide-react";
import { clsx } from "clsx";
import { ThemeToggle } from "./ThemeToggle";
import { ShortcutInput } from "./ShortcutInput";
import { Toggle } from "./Toggle";
import { getSidecarPort, subscribeSidecarPort } from "../lib/api";
import type { EngineSettings, EngineSettingsState } from "../hooks/useEngineSettings";

type SettingsTab = "general" | "indexing" | "performance";

interface SettingsPanelProps {
  theme: "dark" | "light";
  onToggleTheme: () => void;
  shortcut: string;
  onShortcutChange: (shortcut: string) => void;
  folders: string[];
  onAddFolder: () => void;
  onAddSpecificFolder?: (folder: string) => void;
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
  engine: EngineSettingsState;
  onEngineChange: (changes: Partial<EngineSettings>) => void;
  onClearRebuildNotice: () => void;
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

function SectionTitle({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">
      {icon}
      <span>{children}</span>
    </div>
  );
}

export function SettingsPanel({
  theme,
  onToggleTheme,
  shortcut,
  onShortcutChange,
  folders,
  onAddFolder,
  onAddSpecificFolder,
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
  engine,
  onEngineChange,
  onClearRebuildNotice,
  onBack,
}: SettingsPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SettingsTab>("general");
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [newPattern, setNewPattern] = useState("");
  const [stats, setStats] = useState<IndexStats | null>(null);
  const [systemDrives, setSystemDrives] = useState<string[]>([]);
  const [libraryFolders, setLibraryFolders] = useState<string[]>([]);

  useEffect(() => {
    const fetchStats = (p: number | null) => {
      const targetPort = p || getSidecarPort();
      if (targetPort) {
        fetch(`http://127.0.0.1:${targetPort}/index/stats`, {
          signal: AbortSignal.timeout(3000),
        })
          .then((r) => r.json())
          .then((d) => setStats(d))
          .catch(() => {});
      }
    };

    fetchStats(getSidecarPort());
    const unsub = subscribeSidecarPort((p) => fetchStats(p));

    import("@tauri-apps/api/core")
      .then(({ invoke }) => {
        invoke<string[]>("get_system_drives").then(setSystemDrives).catch(() => {});
        invoke<string[]>("get_default_folders").then(setLibraryFolders).catch(() => {});
      })
      .catch(() => {});

    return unsub;
  }, []);

  const handleAddPattern = () => {
    const p = newPattern.trim();
    if (p && !excludePatterns.includes(p)) {
      onAddExcludePattern(p);
      setNewPattern("");
    }
  };

  const runRebuild = () => {
    onRebuildIndex();
    onClearRebuildNotice();
    setConfirmRebuild(false);
  };

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: "general", label: t("settings.tabGeneral", "General"), icon: <Keyboard size={12} /> },
    { id: "indexing", label: t("settings.tabIndexing", "Indexing"), icon: <Folder size={12} /> },
    { id: "performance", label: t("settings.tabPerformance", "Performance"), icon: <Gauge size={12} /> },
  ];

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
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-800 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            title={t("settings.back", "Back")}
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
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors font-medium",
              engine.rebuildRequired
                ? "bg-amber-500 text-white hover:bg-amber-600"
                : "bg-neutral-800 dark:bg-neutral-200 text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300",
            )}
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
              onClick={runRebuild}
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

      {/* Tabs */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-neutral-100 dark:border-neutral-800 shrink-0">
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors",
              tab === item.id
                ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                : "text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800/50",
            )}
          >
            {item.icon}
            {item.label}
            {item.id === "performance" && engine.rebuildRequired && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            )}
          </button>
        ))}
      </div>

      {/* Rebuild banner */}
      {(engine.rebuildRequired || engine.rebuildSuggested) && (
        <div className="flex items-start gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-950/25 border-b border-amber-200/60 dark:border-amber-900/40 shrink-0">
          <AlertTriangle size={13} className="text-amber-500 shrink-0 mt-0.5" />
          <p className="flex-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
            {engine.rebuildRequired
              ? t(
                  "settings.rebuildRequiredNote",
                  "The embedding model changed. Rebuild the index so search uses the new one.",
                )
              : t(
                  "settings.rebuildSuggestedNote",
                  "Rebuild the index to pick up content that was skipped before.",
                )}
          </p>
          <button
            onClick={runRebuild}
            className="px-2 py-0.5 text-[11px] rounded-md bg-amber-500 text-white hover:bg-amber-600 transition-colors font-medium shrink-0"
          >
            {t("settings.rebuildIndex")}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-5 custom-scrollbar">
        {tab === "general" && (
          <>
            <section>
              <SectionTitle icon={<Keyboard size={12} />}>{t("settings.shortcut")}</SectionTitle>
              <ShortcutInput value={shortcut} onChange={onShortcutChange} />
              <p className="mt-1 text-[10px] text-neutral-400 dark:text-neutral-600">
                {t("settings.shortcutDesc")}
              </p>
            </section>

            <section>
              <SectionTitle icon={<SunMoon size={12} />}>{t("settings.theme")}</SectionTitle>
              <ThemeToggle
                theme={theme}
                onToggle={onToggleTheme}
                labels={{ dark: t("settings.themeDark"), light: t("settings.themeLight") }}
              />
            </section>

            <section>
              <SectionTitle icon={<Globe size={12} />}>{t("settings.language")}</SectionTitle>
              <div className="flex gap-2">
                {[
                  { id: "en", label: "English" },
                  { id: "tr", label: "Türkçe" },
                ].map((lang) => (
                  <button
                    key={lang.id}
                    onClick={() => onLanguageChange(lang.id)}
                    className={clsx(
                      "px-3 py-1.5 text-xs rounded-lg border transition-colors cursor-pointer select-none",
                      language === lang.id
                        ? "bg-neutral-800 dark:bg-neutral-200 text-white dark:text-neutral-900 border-transparent font-medium shadow-xs"
                        : "border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800",
                    )}
                  >
                    {lang.label}
                  </button>
                ))}
              </div>
            </section>

            <div className="h-px bg-neutral-100 dark:bg-neutral-800" />

            <section className="pt-0.5">
              <Toggle
                checked={autostart}
                onChange={onAutostartChange}
                label={t("settings.autostart")}
                icon={<Monitor size={13} className="text-neutral-400" />}
              />
            </section>
          </>
        )}

        {tab === "indexing" && (
          <>
            <section>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  {t("settings.indexedFolders")}
                </span>
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
                        <span
                          className="text-xs text-neutral-700 dark:text-neutral-300 truncate"
                          title={folder}
                        >
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

              {(systemDrives.length > 0 || libraryFolders.length > 0) && (
                <div className="mt-3 pt-3 border-t border-neutral-100 dark:border-neutral-800">
                  <label className="block text-[11px] font-medium text-neutral-400 dark:text-neutral-500 mb-1.5">
                    {t("settings.quickDrives")}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {systemDrives.map((d) => {
                      const isAdded = folders.includes(d);
                      return (
                        <button
                          key={d}
                          onClick={() => (isAdded ? onRemoveFolder(d) : onAddSpecificFolder?.(d))}
                          className={clsx(
                            "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-colors font-mono",
                            isAdded
                              ? "bg-neutral-800 dark:bg-neutral-200 text-white dark:text-neutral-900"
                              : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700",
                          )}
                        >
                          <HardDrive size={12} className="shrink-0 opacity-70" />
                          <span>{d}</span>
                          <span className="text-[10px] opacity-75">{isAdded ? "✓" : "+"}</span>
                        </button>
                      );
                    })}
                    {libraryFolders.map((f) => {
                      const isAdded = folders.includes(f);
                      const shortName = f.split(/[\\/]/).pop() ?? f;
                      if (systemDrives.includes(f)) return null;
                      return (
                        <button
                          key={f}
                          onClick={() => (isAdded ? onRemoveFolder(f) : onAddSpecificFolder?.(f))}
                          className={clsx(
                            "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-colors",
                            isAdded
                              ? "bg-neutral-800 dark:bg-neutral-200 text-white dark:text-neutral-900"
                              : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700",
                          )}
                        >
                          <Folder size={12} className="shrink-0 opacity-70" />
                          <span>{shortName}</span>
                          <span className="text-[10px] opacity-75">{isAdded ? "✓" : "+"}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-[10px] text-neutral-400 dark:text-neutral-600">
                    {t("settings.subfolderNote")}
                  </p>
                </div>
              )}
            </section>

            <section>
              <SectionTitle>{t("settings.excludePatterns")}</SectionTitle>
              <div className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={newPattern}
                  onChange={(e) => setNewPattern(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddPattern();
                  }}
                  placeholder={t("settings.patternPlaceholder")}
                  className={clsx(
                    "flex-1 px-3 py-1.5 text-xs rounded-lg",
                    "bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700",
                    "text-neutral-800 dark:text-neutral-200 outline-none",
                    "focus:ring-2 focus:ring-blue-500/40",
                    "placeholder:text-neutral-400 dark:placeholder:text-neutral-600",
                  )}
                />
                <button
                  onClick={handleAddPattern}
                  title={t("settings.addPattern")}
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

            <section>
              <SectionTitle>{t("settings.maxFileSize")}</SectionTitle>
              <input
                type="number"
                min={1}
                max={500}
                value={maxFileSize}
                onChange={(e) => onMaxFileSizeChange(Number(e.target.value))}
                className={clsx(
                  "w-24 px-3 py-1.5 text-sm rounded-lg tabular-nums",
                  "bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700",
                  "text-neutral-800 dark:text-neutral-200 outline-none",
                  "focus:ring-2 focus:ring-blue-500/40",
                )}
              />
              <p className="mt-1 text-[10px] text-neutral-400 dark:text-neutral-600">
                {t("settings.maxFileSizeDesc", "Files larger than this are skipped during indexing.")}
              </p>
            </section>
          </>
        )}

        {tab === "performance" && (
          <>
            <section className="space-y-1">
              <Toggle
                checked={engine.quantize}
                onChange={(v) => onEngineChange({ quantize: v })}
                disabled={!engine.loaded}
                label={t("settings.fastIndexing", "Fast indexing (int8)")}
                description={t(
                  "settings.fastIndexingDesc",
                  "Runs the embedding model in 8-bit. Roughly twice as fast to index; a small share of results may be ranked differently.",
                )}
                note={
                  engine.quantize
                    ? t("settings.fastIndexingNote", "Requires a full index rebuild to take effect.")
                    : undefined
                }
                icon={<Zap size={13} className="text-amber-500" />}
              />

              <div className="h-px bg-neutral-100 dark:bg-neutral-800" />

              <Toggle
                checked={engine.ocr}
                onChange={(v) => onEngineChange({ ocr: v })}
                disabled={!engine.loaded}
                label={t("settings.ocr", "Read text in images (OCR)")}
                description={t(
                  "settings.ocrDesc",
                  "Also index text inside screenshots, photos and scanned PDFs. Loads a ~500 MB model and adds a couple of seconds per image.",
                )}
                icon={<ScanText size={13} className="text-violet-500" />}
              />
            </section>

            {stats && stats.total_files > 0 && (
              <section className="pt-1">
                <SectionTitle icon={<BarChart3 size={12} />}>{t("settings.stats")}</SectionTitle>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: t("settings.totalFiles"), value: stats.total_files.toLocaleString() },
                    { label: t("settings.totalChunks"), value: stats.total_chunks.toLocaleString() },
                    { label: t("settings.totalSize"), value: formatBytes(stats.total_size) },
                    { label: t("settings.lastIndexed"), value: formatDate(stats.last_indexed) },
                  ].map((item) => (
                    <div key={item.label} className="px-3 py-2 rounded-lg bg-neutral-50 dark:bg-neutral-800/50">
                      <div className="text-[10px] text-neutral-400 dark:text-neutral-500">{item.label}</div>
                      <div className="text-sm font-semibold text-neutral-800 dark:text-neutral-200 truncate tabular-nums">
                        {item.value}
                      </div>
                    </div>
                  ))}
                </div>

                {Object.keys(stats.file_types).length > 0 && (
                  <div className="mt-2">
                    <div className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-1">
                      {t("settings.fileTypes")}
                    </div>
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
          </>
        )}
      </div>
    </div>
  );
}
