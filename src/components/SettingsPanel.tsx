import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
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
  Sparkles,
  Download,
  CheckCircle2,
  ExternalLink,
  Github,
} from "lucide-react";
import { clsx } from "clsx";
import { ThemeToggle } from "./ThemeToggle";
import { ShortcutInput } from "./ShortcutInput";
import { Toggle } from "./Toggle";
import { getSidecarPort, subscribeSidecarPort } from "../lib/api";
import type { EngineSettings, EngineSettingsState } from "../hooks/useEngineSettings";

const CURRENT_VERSION = "2.1.0";

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  html_url: string;
  assets?: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

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

interface MftVolumeInfo {
  drive_letter: string;
  file_count: number;
  is_mft: boolean;
}

interface MftStatusData {
  status: string;
  total_files: number;
  total_apps: number;
  scan_time_ms: number;
  volumes: MftVolumeInfo[];
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
  const [mftStatus, setMftStatus] = useState<MftStatusData | null>(null);
  const [rescanningDrives, setRescanningDrives] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "up-to-date" | "update-available" | "error">("idle");
  const [latestRelease, setLatestRelease] = useState<GitHubRelease | null>(null);

  const isNewerVersion = (remote: string, current: string): boolean => {
    const rParts = remote.split(".").map((n) => parseInt(n) || 0);
    const cParts = current.split(".").map((n) => parseInt(n) || 0);
    for (let i = 0; i < Math.max(rParts.length, cParts.length); i++) {
      const r = rParts[i] || 0;
      const c = cParts[i] || 0;
      if (r > c) return true;
      if (r < c) return false;
    }
    return false;
  };

  const processRelease = (data: GitHubRelease) => {
    setLatestRelease(data);
    const cleanTag = data.tag_name.replace(/^v/i, "").trim();
    if (isNewerVersion(cleanTag, CURRENT_VERSION)) {
      setUpdateStatus("update-available");
    } else {
      setUpdateStatus("up-to-date");
    }
  };

  const handleCheckForUpdates = async () => {
    setUpdateStatus("checking");
    try {
      const res = await fetch("https://api.github.com/repos/sametgurtuna/localmind/releases/latest", {
        signal: AbortSignal.timeout(6000),
        headers: { Accept: "application/vnd.github.v3+json" },
      });
      if (!res.ok) {
        const listRes = await fetch("https://api.github.com/repos/sametgurtuna/localmind/releases", {
          signal: AbortSignal.timeout(6000),
        });
        if (listRes.ok) {
          const releases: GitHubRelease[] = await listRes.json();
          if (releases && releases.length > 0) {
            processRelease(releases[0]);
            return;
          }
        }
        setUpdateStatus("error");
        return;
      }
      const data: GitHubRelease = await res.json();
      processRelease(data);
    } catch {
      setUpdateStatus("error");
    }
  };

  const handleOpenUrl = (url: string) => {
    invoke("open_file", { path: url }).catch(() => {
      window.open(url, "_blank");
    });
  };

  const fetchMftStatus = () => {
    invoke<MftStatusData>("get_mft_status")
      .then((data) => setMftStatus(data))
      .catch(() => {});
  };

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

    invoke<string[]>("get_system_drives").then(setSystemDrives).catch(() => {});
    invoke<string[]>("get_default_folders").then(setLibraryFolders).catch(() => {});
    fetchMftStatus();

    return unsub;
  }, []);

  const handleRescanDrives = async () => {
    setRescanningDrives(true);
    try {
      await invoke("refresh_mft_index");
      setTimeout(() => {
        fetchMftStatus();
        setRescanningDrives(false);
      }, 1200);
    } catch {
      setRescanningDrives(false);
    }
  };

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

            <div className="h-px bg-neutral-100 dark:bg-neutral-800" />

            {/* Version & GitHub Updates */}
            <section className="pt-0.5">
              <SectionTitle icon={<Sparkles size={12} className="text-blue-500" />}>
                {t("settings.updates", "Version & Updates")}
              </SectionTitle>

              <div className="p-3.5 rounded-xl bg-neutral-50 dark:bg-neutral-800/40 border border-neutral-200/80 dark:border-neutral-700/60 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">
                      LocalMind
                    </span>
                    <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                      v{CURRENT_VERSION}
                    </span>
                  </div>

                  <button
                    onClick={handleCheckForUpdates}
                    disabled={updateStatus === "checking"}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-100 font-medium transition-colors cursor-pointer disabled:opacity-50 shadow-xs"
                  >
                    <RefreshCw size={12} className={clsx(updateStatus === "checking" && "animate-spin")} />
                    <span>
                      {updateStatus === "checking"
                        ? t("settings.checkingUpdates", "Checking...")
                        : t("settings.checkForUpdates", "Check for Updates")}
                    </span>
                  </button>
                </div>

                {updateStatus === "up-to-date" && (
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-300 text-xs animate-fade-in">
                    <CheckCircle2 size={15} className="shrink-0 text-emerald-500" />
                    <span className="flex-1 font-medium">
                      {t("settings.upToDateDesc", { version: CURRENT_VERSION, defaultValue: `You are running the latest release (v${CURRENT_VERSION}).` })}
                    </span>
                  </div>
                )}

                {updateStatus === "update-available" && latestRelease && (
                  <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/25 space-y-2.5 animate-slide-fade-in">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Sparkles size={15} className="text-blue-500 shrink-0" />
                        <span className="text-xs font-semibold text-blue-900 dark:text-blue-200">
                          {t("settings.updateAvailable", "New Version Available")}: {latestRelease.tag_name}
                        </span>
                      </div>
                      {latestRelease.published_at && (
                        <span className="text-[10px] text-neutral-500 dark:text-neutral-400">
                          {new Date(latestRelease.published_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>

                    {latestRelease.name && (
                      <p className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
                        {latestRelease.name}
                      </p>
                    )}

                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={() => handleOpenUrl(latestRelease.html_url)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium shadow-xs transition-colors cursor-pointer"
                      >
                        <Download size={12} />
                        <span>{t("settings.downloadUpdate", "Download Update")}</span>
                      </button>
                      <button
                        onClick={() => handleOpenUrl(latestRelease.html_url)}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors cursor-pointer"
                      >
                        <ExternalLink size={12} />
                        <span>{t("settings.viewReleaseNotes", "Release Notes")}</span>
                      </button>
                    </div>
                  </div>
                )}

                {updateStatus === "error" && (
                  <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-800 dark:text-amber-300 text-xs animate-fade-in">
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={14} className="shrink-0 text-amber-500" />
                      <span>{t("settings.updateCheckFailed", "Could not check for updates.")}</span>
                    </div>
                    <button
                      onClick={() => handleOpenUrl("https://github.com/sametgurtuna/localmind/releases")}
                      className="flex items-center gap-1 underline text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:opacity-80 cursor-pointer"
                    >
                      <Github size={11} />
                      <span>Releases</span>
                    </button>
                  </div>
                )}
              </div>
            </section>
          </>
        )}

        {tab === "indexing" && (
          <>
            {/* 1. Instant MFT / Drive Search Section */}
            <section className="p-3.5 rounded-xl bg-neutral-100/70 dark:bg-neutral-800/40 border border-black/5 dark:border-white/5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap size={14} className="text-amber-500 shrink-0" />
                  <span className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">
                    {t("settings.instantDrives", "Instant Scanned Drives (0.001s Search)")}
                  </span>
                </div>
                <button
                  onClick={handleRescanDrives}
                  disabled={rescanningDrives}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-lg bg-neutral-200/80 dark:bg-neutral-700/80 hover:bg-neutral-300 dark:hover:bg-neutral-600 text-neutral-700 dark:text-neutral-300 transition-colors font-medium cursor-pointer disabled:opacity-50"
                  title={t("settings.rescanDrives", "Rescan All Drives")}
                >
                  <RefreshCw size={11} className={clsx(rescanningDrives && "animate-spin")} />
                  <span>{rescanningDrives ? t("settings.rescanning", "Scanning...") : t("settings.rescanDrives", "Rescan Drives")}</span>
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                {mftStatus && mftStatus.volumes.length > 0 ? (
                  mftStatus.volumes.map((vol) => (
                    <div
                      key={vol.drive_letter}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white dark:bg-neutral-800 border border-black/5 dark:border-white/5 shadow-xs"
                    >
                      <HardDrive size={13} className="text-blue-500 shrink-0" />
                      <span className="text-xs font-bold font-mono text-neutral-900 dark:text-neutral-100">
                        {vol.drive_letter}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium">
                        {vol.is_mft ? "NTFS MFT" : "Direct"}
                      </span>
                      <span className="text-[11px] text-neutral-500 dark:text-neutral-400 font-mono">
                        {vol.file_count.toLocaleString()} files
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="flex items-center gap-2 text-xs text-neutral-400">
                    <HardDrive size={13} />
                    <span>C:\, D:\ (Ready for instant search)</span>
                  </div>
                )}
              </div>

              <p className="text-[11px] text-neutral-500 dark:text-neutral-400 leading-relaxed">
                {t(
                  "settings.instantDrivesDesc",
                  "All hard drives (C:, D:, etc.) are scanned into memory on startup for instant file and app search without indexing delays.",
                )}
              </p>
            </section>

            <div className="h-px bg-neutral-100 dark:bg-neutral-800 my-1" />

            {/* 2. Deep AI Content & Semantic Indexing */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="text-xs font-semibold text-neutral-800 dark:text-neutral-200 block">
                    {t("settings.contentIndexing", "AI Deep Content & Semantic Indexing")}
                  </span>
                  <span className="text-[10px] text-neutral-400 dark:text-neutral-500 block">
                    {t("settings.contentIndexingDesc", "Index full-text inside documents, code, and PDFs")}
                  </span>
                </div>
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
