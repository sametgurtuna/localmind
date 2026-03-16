export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
}

export interface PinnedFile {
  path: string;
  name: string;
}

export interface AppConfig {
  shortcut: string;
  theme: "dark" | "light";
  language: string;
  autostart: boolean;
  maxFileSize: number;
  indexedFolders: string[];
  excludePatterns: string[];
  searchHistory: string[];
  recentFiles: RecentFile[];
  pinnedFiles: PinnedFile[];
}

const CONFIG_KEY = "localmind-config";

const MAX_HISTORY = 20;
const MAX_RECENT = 15;

export const DEFAULT_CONFIG: AppConfig = {
  shortcut: "Ctrl+Space",
  theme: "dark",
  language: "en",
  autostart: true,
  maxFileSize: 50,
  indexedFolders: [],
  excludePatterns: ["node_modules", "*.min.js", "*.log", ".git"],
  searchHistory: [],
  recentFiles: [],
  pinnedFiles: [],
};

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch {
    /* noop */
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: AppConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function addSearchHistory(config: AppConfig, query: string): AppConfig {
  const q = query.trim();
  if (!q) return config;
  const history = [q, ...config.searchHistory.filter((h) => h !== q)].slice(0, MAX_HISTORY);
  return { ...config, searchHistory: history };
}

export function removeSearchHistory(config: AppConfig, query: string): AppConfig {
  return { ...config, searchHistory: config.searchHistory.filter((h) => h !== query) };
}

export function clearSearchHistory(config: AppConfig): AppConfig {
  return { ...config, searchHistory: [] };
}

export function addRecentFile(config: AppConfig, path: string, name: string): AppConfig {
  const entry: RecentFile = { path, name, openedAt: Date.now() };
  const recent = [entry, ...config.recentFiles.filter((r) => r.path !== path)].slice(0, MAX_RECENT);
  return { ...config, recentFiles: recent };
}

export function togglePinnedFile(config: AppConfig, path: string, name: string): AppConfig {
  const exists = config.pinnedFiles.some((p) => p.path === path);
  if (exists) {
    return { ...config, pinnedFiles: config.pinnedFiles.filter((p) => p.path !== path) };
  }
  return { ...config, pinnedFiles: [...config.pinnedFiles, { path, name }] };
}

export function isPinned(config: AppConfig, path: string): boolean {
  return config.pinnedFiles.some((p) => p.path === path);
}
