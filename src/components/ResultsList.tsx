import { useTranslation } from "react-i18next";
import {
  FileText,
  FolderOpen,
  ExternalLink,
  Star,
  Copy,
  Code,
  Terminal,
  Layers,
} from "lucide-react";
import { clsx } from "clsx";
import type { SearchResult } from "../hooks/useSearch";
import { isPinned, type AppConfig } from "../lib/config";

interface ResultsListProps {
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  query: string;
  selectedIndex: number;
  onOpenFile: (path: string) => void;
  onOpenFolder: (path: string) => void;
  onTogglePin: (path: string, name: string) => void;
  onCopyPath: (path: string) => void;
  onSearchSimilar: (filePath: string) => void;
  config: AppConfig;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const parts: { text: string; highlight: boolean }[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let earliest = -1;
    let matchLen = 0;
    for (const term of terms) {
      const idx = remaining.toLowerCase().indexOf(term);
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
        matchLen = term.length;
      }
    }
    if (earliest === -1) {
      parts.push({ text: remaining, highlight: false });
      break;
    }
    if (earliest > 0) {
      parts.push({ text: remaining.slice(0, earliest), highlight: false });
    }
    parts.push({
      text: remaining.slice(earliest, earliest + matchLen),
      highlight: true,
    });
    remaining = remaining.slice(earliest + matchLen);
  }

  return parts.map((p, i) =>
    p.highlight ? (
      <mark key={i} className="bg-yellow-300/40 dark:bg-yellow-500/30 text-inherit rounded-sm px-0.5">
        {p.text}
      </mark>
    ) : (
      <span key={i}>{p.text}</span>
    ),
  );
}

function getFileIcon(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const colorMap: Record<string, string> = {
    py: "text-blue-500",
    js: "text-yellow-500",
    ts: "text-blue-400",
    tsx: "text-blue-400",
    jsx: "text-yellow-500",
    html: "text-orange-500",
    css: "text-purple-500",
    json: "text-green-500",
    md: "text-neutral-500",
    pdf: "text-red-500",
    docx: "text-blue-600",
    txt: "text-neutral-400",
    rs: "text-orange-600",
    go: "text-cyan-500",
    java: "text-red-400",
    c: "text-blue-300",
    cpp: "text-blue-300",
    rb: "text-red-600",
    sh: "text-green-400",
    sql: "text-yellow-600",
    xml: "text-orange-400",
    yaml: "text-pink-400",
    yml: "text-pink-400",
    toml: "text-neutral-500",
    csv: "text-green-600",
    xlsx: "text-green-700",
    pptx: "text-orange-600",
  };
  return colorMap[ext ?? ""] ?? "text-neutral-400";
}

async function openInVscode(path: string) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_in_vscode", { path });
  } catch {
    /* noop */
  }
}

async function openFileAtLine(path: string, line: number) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_file_at_line", { path, line });
  } catch {
    /* noop */
  }
}

async function openInTerminal(path: string) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_in_terminal", { path });
  } catch {
    /* noop */
  }
}

export function ResultsList({
  results,
  loading,
  error,
  query,
  selectedIndex,
  onOpenFile,
  onOpenFolder,
  onTogglePin,
  onCopyPath,
  onSearchSimilar,
  config,
}: ResultsListProps) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="w-5 h-5 border-2 border-neutral-300 dark:border-neutral-600 border-t-neutral-600 dark:border-t-neutral-300 rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-6 text-center text-sm text-red-500 dark:text-red-400">
        {error}
      </div>
    );
  }

  if (query && results.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
        {t("search.noResults")}
      </div>
    );
  }

  if (!query) return null;

  return (
    <div className="max-h-[340px] overflow-y-auto">
      {results.map((result, index) => {
        const pinned = isPinned(config, result.filePath);
        return (
          <div
            key={`${result.filePath}-${result.chunkIndex ?? index}`}
            className={clsx(
              "group flex items-start gap-3 px-4 py-2.5 cursor-pointer transition-colors duration-100 animate-slide-fade-in",
              index === selectedIndex
                ? "bg-neutral-100 dark:bg-neutral-800/80"
                : "hover:bg-neutral-50 dark:hover:bg-neutral-800/40",
            )}
            style={{ animationDelay: `${index * 30}ms` }}
            onClick={() => {
              if (result.lineStart && result.lineStart > 0) {
                openFileAtLine(result.filePath, result.lineStart);
              } else {
                onOpenFile(result.filePath);
              }
            }}
          >
            <FileText
              size={18}
              className={clsx("mt-0.5 shrink-0", getFileIcon(result.fileName))}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">
                  {result.fileName}
                </span>
                {result.score > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400">
                    {Math.round(result.score * 100)}%
                  </span>
                )}
                {result.lineStart && result.lineStart > 0 && (
                  <span className="text-[10px] px-1 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-500 dark:text-blue-400 font-mono">
                    L{result.lineStart}
                  </span>
                )}
                {pinned && (
                  <Star size={10} className="text-amber-500" fill="currentColor" />
                )}
              </div>
              <p className="text-xs text-neutral-400 dark:text-neutral-500 truncate mt-0.5">
                {result.filePath}
              </p>
              {result.snippet && (
                <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1 line-clamp-2 leading-relaxed">
                  {highlightMatch(result.snippet, query)}
                </p>
              )}
            </div>
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5">
              <button
                onClick={(e) => { e.stopPropagation(); onTogglePin(result.filePath, result.fileName); }}
                className={clsx(
                  "p-1 rounded transition-colors",
                  pinned
                    ? "text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/30"
                    : "text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700",
                )}
                title={pinned ? t("results.unpin") : t("results.pin")}
              >
                <Star size={13} fill={pinned ? "currentColor" : "none"} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onCopyPath(result.filePath); }}
                className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-400"
                title={t("results.copyPath")}
              >
                <Copy size={13} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onSearchSimilar(result.filePath); }}
                className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-400"
                title={t("search.similarFiles")}
              >
                <Layers size={13} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); openInVscode(result.filePath); }}
                className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-400"
                title={t("results.openInVscode")}
              >
                <Code size={13} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); openInTerminal(result.filePath); }}
                className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-400"
                title={t("results.openInTerminal")}
              >
                <Terminal size={13} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onOpenFile(result.filePath); }}
                className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-400"
                title={t("results.openFile")}
              >
                <ExternalLink size={13} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onOpenFolder(result.filePath); }}
                className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-400"
                title={t("results.openFolder")}
              >
                <FolderOpen size={13} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
