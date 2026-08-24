import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { SearchBar } from "./components/SearchBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { useTheme } from "./hooks/useTheme";
import { useSidecar } from "./hooks/useSidecar";
import { useEngineSettings } from "./hooks/useEngineSettings";
import {
  loadConfig,
  saveConfig,
  addRecentFile,
  clearRecentFiles,
  addSearchHistory,
  removeSearchHistory,
  clearSearchHistory,
  togglePinnedFile,
  type AppConfig,
} from "./lib/config";

type View = "search" | "settings";

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

async function tauriListen(event: string, handler: () => void) {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return listen(event, handler);
  } catch {
    return undefined;
  }
}

export default function App() {
  const { i18n } = useTranslation();
  const { theme, toggleTheme, setTheme } = useTheme();
  const sidecar = useSidecar();
  const { engine, updateEngine, clearRebuildNotice } = useEngineSettings(sidecar.port);
  const [view, setView] = useState<View>("search");
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());

  useEffect(() => {
    setTheme(config.theme);
    i18n.changeLanguage(config.language);
  }, [config.theme, config.language, setTheme, i18n]);

  useEffect(() => {
    const unsubs: Array<(() => void) | undefined> = [];

    tauriListen("open-settings", () => setView("settings")).then((u) => {
      if (u) unsubs.push(u as unknown as () => void);
    });

    tauriListen("rebuild-index", () => {
      handleRebuildIndex();
    }).then((u) => {
      if (u) unsubs.push(u as unknown as () => void);
    });

    return () => unsubs.forEach((u) => u?.());
  }, []);

  useEffect(() => {
    if (config.indexedFolders.length === 0) {
      tauriInvoke<string[]>("get_default_folders")
        .then((folders) => {
          if (folders.length > 0) {
            updateConfig({ indexedFolders: folders });
          }
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (sidecar.connected && sidecar.modelReady && sidecar.port && config.indexedFolders.length > 0) {
      fetch(`http://127.0.0.1:${sidecar.port}/index/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folders: config.indexedFolders,
          max_file_size: config.maxFileSize,
          exclude_patterns: config.excludePatterns,
        }),
        signal: AbortSignal.timeout(6000),
      }).catch(() => {});
    }
  }, [sidecar.connected, sidecar.modelReady, sidecar.port, config.indexedFolders, config.maxFileSize, config.excludePatterns]);

  const updateConfig = useCallback((partial: Partial<AppConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...partial };
      saveConfig(next);
      return next;
    });
  }, []);

  const handleOpenFile = useCallback(async (filePath: string) => {
    const name = filePath.split(/[\\/]/).pop() ?? filePath;
    setConfig((prev) => {
      const next = addRecentFile(prev, filePath, name);
      saveConfig(next);
      return next;
    });
    try {
      if (filePath.endsWith(".lnk") || filePath.endsWith(".exe") || (filePath.includes(":") && !filePath.includes("\\"))) {
        await tauriInvoke("launch_app", { path: filePath });
      } else {
        await tauriInvoke("open_file", { path: filePath });
      }
    } catch {
      window.open(`file://${filePath}`);
    }
  }, []);

  const handleOpenFolder = useCallback(async (filePath: string) => {
    try {
      await tauriInvoke("show_in_folder", { path: filePath });
    } catch {
      try {
        await tauriInvoke("open_folder", { path: filePath });
      } catch {
        const sep = filePath.includes("\\") ? "\\" : "/";
        const folder = filePath.substring(0, filePath.lastIndexOf(sep));
        window.open(`file://${folder}`);
      }
    }
  }, []);

  const handleOpenInVscode = useCallback(async (path: string) => {
    try {
      await tauriInvoke("open_in_vscode", { path });
    } catch {
      /* noop */
    }
  }, []);

  const handleOpenInTerminal = useCallback(async (path: string) => {
    try {
      await tauriInvoke("open_in_terminal", { path });
    } catch {
      /* noop */
    }
  }, []);

  const handleRunAsAdmin = useCallback(async (path: string) => {
    try {
      await tauriInvoke("run_as_admin", { path });
    } catch {
      /* noop */
    }
  }, []);

  const handleSystemCommand = useCallback(async (command: string) => {
    try {
      await tauriInvoke("system_command", { command });
    } catch {
      /* noop */
    }
  }, []);

  const handleDeleteFile = useCallback(async (path: string) => {
    try {
      await tauriInvoke("delete_file", { path });
    } catch {
      /* noop */
    }
  }, []);

  const handleAddFolder = useCallback(async () => {
    try {
      const folder = await tauriInvoke<string | null>("pick_folder");
      if (folder) {
        setConfig((prev) => {
          if (prev.indexedFolders.includes(folder)) return prev;
          const next = { ...prev, indexedFolders: [...prev.indexedFolders, folder] };
          saveConfig(next);
          return next;
        });
      }
    } catch {
      /* noop */
    }
  }, []);

  const handleAddSpecificFolder = useCallback((folder: string) => {
    setConfig((prev) => {
      if (prev.indexedFolders.includes(folder)) return prev;
      const next = { ...prev, indexedFolders: [...prev.indexedFolders, folder] };
      saveConfig(next);
      return next;
    });
  }, []);

  const handleRemoveFolder = useCallback((folder: string) => {
    setConfig((prev) => {
      const next = { ...prev, indexedFolders: prev.indexedFolders.filter((f) => f !== folder) };
      saveConfig(next);
      return next;
    });
  }, []);

  const handleRebuildIndex = useCallback(async () => {
    if (!sidecar.port) {
      try {
        await tauriInvoke("rebuild_index");
      } catch { /* noop */ }
      return;
    }
    try {
      await fetch(`http://127.0.0.1:${sidecar.port}/index/rebuild`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folders: config.indexedFolders,
          max_file_size: config.maxFileSize,
          exclude_patterns: config.excludePatterns,
        }),
        signal: AbortSignal.timeout(6000),
      });
    } catch { /* noop */ }
  }, [sidecar.port, config.indexedFolders, config.maxFileSize, config.excludePatterns]);

  const handleShortcutChange = useCallback(
    (shortcut: string) => {
      updateConfig({ shortcut });
      tauriInvoke("save_config", { config: { ...config, shortcut } }).catch(() => {});
    },
    [config, updateConfig],
  );

  const handleAutostartChange = useCallback(
    async (autostart: boolean) => {
      updateConfig({ autostart });
      try {
        if (autostart) {
          const { enable } = await import("@tauri-apps/plugin-autostart");
          await enable();
        } else {
          const { disable } = await import("@tauri-apps/plugin-autostart");
          await disable();
        }
      } catch {
        /* noop */
      }
    },
    [updateConfig],
  );

  const handleMaxFileSizeChange = useCallback(
    (maxFileSize: number) => {
      if (maxFileSize >= 1 && maxFileSize <= 500) {
        updateConfig({ maxFileSize });
      }
    },
    [updateConfig],
  );

  const handleLanguageChange = useCallback(
    (language: string) => {
      updateConfig({ language });
    },
    [updateConfig],
  );

  const handleAddExcludePattern = useCallback((pattern: string) => {
    setConfig((prev) => {
      if (prev.excludePatterns.includes(pattern)) return prev;
      const next = { ...prev, excludePatterns: [...prev.excludePatterns, pattern] };
      saveConfig(next);
      return next;
    });
  }, []);

  const handleRemoveExcludePattern = useCallback((pattern: string) => {
    setConfig((prev) => {
      const next = { ...prev, excludePatterns: prev.excludePatterns.filter((p) => p !== pattern) };
      saveConfig(next);
      return next;
    });
  }, []);

  const handleSearchHistoryAdd = useCallback((query: string) => {
    setConfig((prev) => {
      const next = addSearchHistory(prev, query);
      saveConfig(next);
      return next;
    });
  }, []);

  const handleSearchHistoryRemove = useCallback((query: string) => {
    setConfig((prev) => {
      const next = removeSearchHistory(prev, query);
      saveConfig(next);
      return next;
    });
  }, []);

  const handleSearchHistoryClear = useCallback(() => {
    setConfig((prev) => {
      const next = clearSearchHistory(prev);
      saveConfig(next);
      return next;
    });
  }, []);

  const handleRecentFilesClear = useCallback(() => {
    setConfig((prev) => {
      const next = clearRecentFiles(prev);
      saveConfig(next);
      return next;
    });
  }, []);

  const handleTogglePin = useCallback((path: string, name: string) => {
    setConfig((prev) => {
      const next = togglePinnedFile(prev, path, name);
      saveConfig(next);
      return next;
    });
  }, []);

  return (
    <div className="w-full h-full flex items-start justify-center p-3 sm:p-4 overflow-hidden select-none bg-transparent">
      {view === "search" ? (
        <SearchBar
          onOpenSettings={() => setView("settings")}
          onOpenFile={handleOpenFile}
          onOpenFolder={handleOpenFolder}
          onOpenInVscode={handleOpenInVscode}
          onOpenInTerminal={handleOpenInTerminal}
          onRunAsAdmin={handleRunAsAdmin}
          onSystemCommand={handleSystemCommand}
          onDeleteFile={handleDeleteFile}
          sidecarConnected={sidecar.connected}
          modelReady={sidecar.modelReady}
          sidecarLoading={sidecar.loading}
          searchHistory={config.searchHistory}
          recentFiles={config.recentFiles}
          pinnedFiles={config.pinnedFiles}
          onAddSearchHistory={handleSearchHistoryAdd}
          onRemoveSearchHistory={handleSearchHistoryRemove}
          onClearSearchHistory={handleSearchHistoryClear}
          onClearRecentFiles={handleRecentFilesClear}
          onTogglePin={handleTogglePin}
          config={config}
          sidecarPort={sidecar.port}
          sidecarError={sidecar.error}
        />
      ) : (
        <SettingsPanel
          theme={theme}
          onToggleTheme={toggleTheme}
          shortcut={config.shortcut}
          onShortcutChange={handleShortcutChange}
          folders={config.indexedFolders}
          onAddFolder={handleAddFolder}
          onAddSpecificFolder={handleAddSpecificFolder}
          onRemoveFolder={handleRemoveFolder}
          onRebuildIndex={handleRebuildIndex}
          autostart={config.autostart}
          onAutostartChange={handleAutostartChange}
          maxFileSize={config.maxFileSize}
          onMaxFileSizeChange={handleMaxFileSizeChange}
          language={config.language}
          onLanguageChange={handleLanguageChange}
          excludePatterns={config.excludePatterns}
          onAddExcludePattern={handleAddExcludePattern}
          onRemoveExcludePattern={handleRemoveExcludePattern}
          engine={engine}
          onEngineChange={updateEngine}
          onClearRebuildNotice={clearRebuildNotice}
          onBack={() => setView("search")}
        />
      )}
    </div>
  );
}
