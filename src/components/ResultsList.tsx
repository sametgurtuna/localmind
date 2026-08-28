import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  FileText,
  Star,
  Code,
  Calculator,
  Zap,
  LayoutGrid,
  FileCode,
  FileSpreadsheet,
  MoreHorizontal,
  SearchX,
  Eye,
  ArrowRightLeft,
  Globe,
  Languages,
  MapPin,
  Youtube,
  Github,
  BookOpen,
  ExternalLink,
  Bot,
  GitBranch,
  FolderGit2,
  Lock,
  Moon,
  RotateCw,
  Power,
  Trash2,
  Wifi,
} from "lucide-react";
import { clsx } from "clsx";
import type { SearchResult, SearchTab } from "../hooks/useSearch";
import type { GroupedResult, ResultGroup } from "../lib/grouping";
import { isPinned, type AppConfig } from "../lib/config";

interface ResultsListProps {
  groups: ResultGroup[];
  loading: boolean;
  error: string | null;
  query: string;
  selectedIndex: number;
  activeTab: SearchTab;
  onSelectIndex: (index: number) => void;
  onOpenResult: (result: SearchResult) => void;
  onOpenActionMenu: (result: SearchResult) => void;
  onOpenPreview?: (result: SearchResult) => void;
  config: AppConfig;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim() || !text) return text;
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

  return (
    <>
      {parts.map((p, i) =>
        p.highlight ? (
          <mark
            key={i}
            className="bg-blue-500/20 dark:bg-blue-400/25 text-blue-900 dark:text-blue-100 rounded-[2px] px-0.5 not-italic font-semibold"
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let val = bytes;
  let unitIndex = 0;
  while (val >= 1024 && unitIndex < units.length - 1) {
    val /= 1024;
    unitIndex++;
  }
  return `${val.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getResultIcon(result: SearchResult) {
  if (result.icon && result.icon.startsWith("data:")) {
    return (
      <img
        src={result.icon}
        alt=""
        className="w-[18px] h-[18px] object-contain shrink-0 rounded"
        loading="lazy"
      />
    );
  }
  if (result.category === "repo" || result.icon === "git") {
    return <FolderGit2 size={18} className="text-orange-500 shrink-0" />;
  }
  if (result.category === "converter") {
    return <ArrowRightLeft size={18} className="text-emerald-500 shrink-0" />;
  }
  if (result.category === "web") {
    if (result.icon === "youtube") return <Youtube size={18} className="text-red-500 shrink-0" />;
    if (result.icon === "github") return <Github size={18} className="text-neutral-700 dark:text-neutral-200 shrink-0" />;
    if (result.icon === "wikipedia") return <BookOpen size={18} className="text-blue-400 shrink-0" />;
    if (result.icon === "translate") return <Languages size={18} className="text-sky-500 shrink-0" />;
    if (result.icon === "maps") return <MapPin size={18} className="text-red-400 shrink-0" />;
    if (result.icon === "chatgpt") return <Bot size={18} className="text-emerald-500 shrink-0" />;
    return <Globe size={18} className="text-blue-500 shrink-0" />;
  }
  if (result.category === "calc" || result.icon === "calc") {
    return <Calculator size={18} className="text-amber-500 shrink-0" />;
  }
  if (result.category === "action") {
    if (result.icon === "lock") return <Lock size={18} className="text-amber-500 shrink-0" />;
    if (result.icon === "sleep") return <Moon size={18} className="text-indigo-400 shrink-0" />;
    if (result.icon === "restart") return <RotateCw size={18} className="text-sky-500 shrink-0" />;
    if (result.icon === "shutdown") return <Power size={18} className="text-rose-500 shrink-0" />;
    if (result.icon === "trash") return <Trash2 size={18} className="text-red-500 shrink-0" />;
    if (result.icon === "network" || result.icon === "ip") return <Wifi size={18} className="text-emerald-500 shrink-0" />;
    return <Zap size={18} className="text-purple-500 shrink-0" />;
  }
  if (result.category === "app") {
    return <LayoutGrid size={18} className="text-blue-500 shrink-0" />;
  }
  if (result.category === "content") {
    return <FileCode size={18} className="text-violet-500 shrink-0" />;
  }

  const ext = (result.fileExt || result.fileName.split(".").pop() || "").replace(".", "").toLowerCase();
  const codeExts = ["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "c", "cpp", "html", "css", "json", "yaml", "yml", "sql", "sh"];
  if (codeExts.includes(ext)) {
    return <Code size={18} className="text-sky-500 shrink-0" />;
  }
  if (["xlsx", "csv"].includes(ext)) {
    return <FileSpreadsheet size={18} className="text-emerald-500 shrink-0" />;
  }
  if (["pdf", "docx", "doc", "txt", "md"].includes(ext)) {
    return <FileText size={18} className="text-rose-500 shrink-0" />;
  }

  return <FileText size={18} className="text-neutral-400 shrink-0" />;
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="w-9 h-9 rounded-lg bg-neutral-150 dark:bg-neutral-800 animate-pulse" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 w-2/5 rounded bg-neutral-150 dark:bg-neutral-800 animate-pulse" />
        <div className="h-2.5 w-3/4 rounded bg-neutral-100 dark:bg-neutral-800/60 animate-pulse" />
      </div>
    </div>
  );
}

interface RowProps {
  result: GroupedResult;
  isSelected: boolean;
  query: string;
  pinned: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onOpenActionMenu: () => void;
  onOpenPreview?: () => void;
  rowRef: React.Ref<HTMLDivElement> | null;
}

function ResultRow({
  result,
  isSelected,
  query,
  pinned,
  onSelect,
  onOpen,
  onOpenActionMenu,
  onOpenPreview,
  rowRef,
}: RowProps) {
  const isCalc = result.category === "calc";
  const isConverter = result.category === "converter";
  const isWeb = result.category === "web";
  const isApp = result.category === "app";
  const isRepo = result.category === "repo";
  const isContent = result.category === "content";

  return (
    <div
      ref={rowRef}
      role="option"
      aria-selected={isSelected}
      onClick={onOpen}
      onMouseEnter={onSelect}
      className={clsx(
        "group relative flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl cursor-pointer select-none",
        "transition-colors duration-100",
        isSelected
          ? "bg-blue-500/10 dark:bg-blue-500/15 text-neutral-900 dark:text-white border border-blue-500/25 dark:border-blue-400/25"
          : "hover:bg-neutral-100/70 dark:hover:bg-neutral-800/50 text-neutral-700 dark:text-neutral-300 border border-transparent",
      )}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div
          className={clsx(
            "p-2 rounded-lg flex items-center justify-center transition-colors",
            isSelected ? "bg-white dark:bg-neutral-800 shadow-xs" : "bg-neutral-100 dark:bg-neutral-800/60",
          )}
        >
          {getResultIcon(result)}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                "text-sm font-semibold truncate",
                isCalc && "font-mono text-base text-amber-600 dark:text-amber-400",
                isConverter && "text-[14px] font-bold text-emerald-600 dark:text-emerald-400",
                isWeb && "text-blue-600 dark:text-blue-400",
                isRepo && "text-neutral-900 dark:text-neutral-100 font-bold",
              )}
            >
              {highlightMatch(result.fileName, query)}
            </span>

            {isRepo && (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-orange-500/15 text-orange-600 dark:text-orange-400 font-medium">
                <GitBranch size={11} />
                Workspace
              </span>
            )}

            {isConverter && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium">
                Unit & Currency
              </span>
            )}

            {isWeb && (
              <ExternalLink size={12} className="text-blue-400 shrink-0 opacity-70" />
            )}

            {pinned && <Star size={12} className="text-amber-400 fill-amber-400 shrink-0" />}

            {result.lineStart !== undefined && result.lineStart > 0 && (
              <span className="text-[10px] text-neutral-400 font-mono shrink-0">L{result.lineStart}</span>
            )}
          </div>

          <div className="text-xs text-neutral-400 dark:text-neutral-500 truncate mt-0.5">
            {isContent ? (
              <span className="font-mono text-[11px] text-neutral-600 dark:text-neutral-300">
                {highlightMatch(result.snippet, query)}
              </span>
            ) : (
              <span className={clsx(isRepo && "text-neutral-600 dark:text-neutral-300 font-medium")}>{result.snippet || result.filePath}</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {!isCalc && !isConverter && !isWeb && !isApp && result.fileSize ? (
          <span className="text-[11px] text-neutral-400 dark:text-neutral-500 font-mono tabular-nums hidden sm:inline">
            {formatBytes(result.fileSize)}
          </span>
        ) : null}

        {onOpenPreview && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenPreview();
            }}
            className={clsx(
              "p-1.5 rounded-lg text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-opacity",
              isSelected
                ? "opacity-100 bg-neutral-200/50 dark:bg-neutral-700/50"
                : "opacity-0 group-hover:opacity-100",
            )}
            title="Preview (Ctrl+P)"
          >
            <Eye size={14} />
          </button>
        )}

        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenActionMenu();
          }}
          className={clsx(
            "p-1.5 rounded-lg text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-opacity",
            isSelected
              ? "opacity-100 bg-neutral-200/50 dark:bg-neutral-700/50"
              : "opacity-0 group-hover:opacity-100",
          )}
          title="Actions (Ctrl+K)"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    </div>
  );
}

export function ResultsList({
  groups,
  loading,
  error,
  query,
  selectedIndex,
  activeTab,
  onSelectIndex,
  onOpenResult,
  onOpenActionMenu,
  onOpenPreview,
  config,
}: ResultsListProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (loading && total === 0) {
    return (
      <div className="px-2 py-1" aria-busy="true">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-2 px-4 py-8 text-center text-sm text-red-500 dark:text-red-400 bg-red-50/40 dark:bg-red-950/20 rounded-xl">
        {error}
      </div>
    );
  }

  if (query && total === 0) {
    return (
      <div className="px-6 py-12 flex flex-col items-center gap-2 text-center">
        <SearchX size={22} className="text-neutral-300 dark:text-neutral-600" />
        <span className="text-sm text-neutral-500 dark:text-neutral-400">
          {t("search.noResults", "No results found")}
        </span>
        <span className="text-xs text-neutral-400 dark:text-neutral-600 max-w-xs leading-relaxed">
          {t(
            "search.noResultsHint",
            "Try a different word, or switch tabs with Tab to search apps, filenames or file contents.",
          )}
        </span>
      </div>
    );
  }

  if (total === 0) return null;

  const showHeaders = activeTab === "all" && groups.length > 1;

  return (
    <div
      ref={listRef}
      role="listbox"
      className={clsx(
        "max-h-[380px] overflow-y-auto px-2 py-1 custom-scrollbar",
        loading && "opacity-60 transition-opacity",
      )}
    >
      {groups.map((group) => (
        <div key={group.category} className="mb-1 last:mb-0">
          {showHeaders && (
            <div className="flex items-center gap-2 px-3 pt-2 pb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                {t(group.labelKey, group.fallbackLabel)}
              </span>
              <span className="text-[10px] text-neutral-300 dark:text-neutral-600 tabular-nums">
                {group.items.length}
              </span>
              <div className="flex-1 h-px bg-black/5 dark:bg-white/5" />
            </div>
          )}

          <div className="space-y-0.5">
            {group.items.map((result) => {
              const isSelected = result.flatIndex === selectedIndex;
              return (
                <ResultRow
                  key={`${result.filePath}-${result.chunkIndex ?? result.flatIndex}`}
                  result={result}
                  isSelected={isSelected}
                  query={query}
                  pinned={isPinned(config, result.filePath)}
                  onSelect={() => onSelectIndex(result.flatIndex)}
                  onOpen={() => onOpenResult(result)}
                  onOpenActionMenu={() => onOpenActionMenu(result)}
                  onOpenPreview={onOpenPreview ? () => onOpenPreview(result) : undefined}
                  rowRef={isSelected ? selectedRef : null}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
