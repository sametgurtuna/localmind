import { useState, useEffect } from "react";
import {
  FileText,
  FolderOpen,
  Copy,
  ExternalLink,
  ShieldAlert,
  Terminal,
  Code2,
  Calendar,
  HardDrive,
  Check,
  Calculator,
  ArrowRightLeft,
  Globe,
  LayoutGrid,
  Sparkles,
} from "lucide-react";
import type { SearchResult } from "../hooks/useSearch";
import hljs from "highlight.js/lib/core";

// Language Syntax Highlights for Mini Preview
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);

const EXT_TO_LANG: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".rs": "rust",
  ".json": "json",
  ".md": "markdown",
  ".html": "html",
  ".css": "css",
};

interface SplitPreviewPanelProps {
  result: SearchResult | null;
  onOpenFile: (path: string) => void;
  onOpenFolder?: (path: string) => void;
  onOpenInVscode?: (path: string) => void;
  onOpenInTerminal?: (path: string) => void;
  onRunAsAdmin?: (path: string) => void;
  onCopyPath: (path: string) => void;
}

interface NativePreview {
  type: string;
  content: string;
  total_lines: number;
  start_line: number;
  file_ext: string;
  file_size?: number;
  modified?: number;
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

function formatDate(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SplitPreviewPanel({
  result,
  onOpenFile,
  onOpenFolder,
  onOpenInVscode,
  onOpenInTerminal,
  onRunAsAdmin,
  onCopyPath,
}: SplitPreviewPanelProps) {
  const [nativeData, setNativeData] = useState<NativePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!result) {
      setNativeData(null);
      return;
    }

    if (result.category === "calc" || result.category === "converter" || result.category === "web") {
      setNativeData(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    async function loadSnippet() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const res = await invoke<NativePreview>("get_file_preview_native", {
          path: result!.filePath,
          line: result!.lineStart || 1,
          context: 20,
        });
        if (!cancelled) {
          setNativeData(res);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    loadSnippet();
    return () => {
      cancelled = true;
    };
  }, [result?.filePath, result?.lineStart, result?.category]);

  const handleCopy = () => {
    if (!result) return;
    onCopyPath(result.filePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!result) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center text-neutral-400 dark:text-neutral-600 select-none">
        <Sparkles size={32} className="mb-2 opacity-40 animate-pulse" />
        <span className="text-xs font-medium">Select an item to preview</span>
      </div>
    );
  }

  const isCalc = result.category === "calc";
  const isConverter = result.category === "converter";
  const isWeb = result.category === "web";
  const isApp = result.category === "app";
  const isFile = !isCalc && !isConverter && !isWeb && !isApp;

  const ext = (result.fileExt || result.fileName.split(".").pop() || "").toLowerCase();
  const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext);

  // Syntax highlighting for mini code preview
  const extWithDot = `.${ext}`;
  const lang = EXT_TO_LANG[extWithDot];
  let highlightedContent = "";
  if (nativeData?.content && nativeData.type === "text") {
    if (lang && hljs.getLanguage(lang)) {
      try {
        highlightedContent = hljs.highlight(nativeData.content, { language: lang, ignoreIllegals: true }).value;
      } catch {
        highlightedContent = nativeData.content;
      }
    } else {
      highlightedContent = nativeData.content;
    }
  }

  return (
    <div className="h-full flex flex-col justify-between p-4 bg-neutral-50/70 dark:bg-neutral-900/60 border-l border-black/5 dark:border-white/5 overflow-y-auto">
      {/* 1. Header & Identity */}
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-white dark:bg-neutral-800 shadow-sm border border-black/5 dark:border-white/5 shrink-0">
            {result.icon && result.icon.startsWith("data:") ? (
              <img src={result.icon} alt="" className="w-8 h-8 object-contain" />
            ) : isConverter ? (
              <ArrowRightLeft size={24} className="text-emerald-500" />
            ) : isCalc ? (
              <Calculator size={24} className="text-amber-500" />
            ) : isWeb ? (
              <Globe size={24} className="text-blue-500" />
            ) : isApp ? (
              <LayoutGrid size={24} className="text-blue-500" />
            ) : (
              <FileText size={24} className="text-neutral-500 dark:text-neutral-400" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-bold text-neutral-900 dark:text-neutral-100 truncate leading-snug">
              {result.fileName}
            </h3>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[10px] uppercase font-semibold px-2 py-0.5 rounded-md bg-neutral-200/70 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300">
                {isConverter
                  ? "Unit & Currency"
                  : isCalc
                  ? "Calculation"
                  : isWeb
                  ? "Web Shortcut"
                  : isApp
                  ? "Application"
                  : ext.toUpperCase() || "File"}
              </span>
              {result.fileSize ? (
                <span className="text-[11px] text-neutral-400 font-mono">
                  {formatBytes(result.fileSize)}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* 2. Middle Preview Area */}
        <div className="w-full rounded-xl overflow-hidden border border-black/5 dark:border-white/10 bg-white dark:bg-neutral-950/80 shadow-xs min-h-[140px] max-h-[220px] flex flex-col">
          {isConverter || isCalc ? (
            <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
              <span className="text-xs text-neutral-400 mb-1">Result</span>
              <span className="text-xl font-bold text-emerald-600 dark:text-emerald-400 font-mono">
                {result.filePath}
              </span>
              <span className="text-[11px] text-neutral-500 mt-2">{result.snippet}</span>
            </div>
          ) : isWeb ? (
            <div className="flex-1 flex flex-col items-center justify-center p-4 text-center gap-2">
              <Globe size={28} className="text-blue-500 opacity-80" />
              <span className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">
                {result.fileName}
              </span>
              <span className="text-[10px] text-neutral-400 font-mono truncate max-w-full px-2">
                {result.filePath}
              </span>
            </div>
          ) : isImage && nativeData?.type === "image" ? (
            <div className="flex-1 flex items-center justify-center p-2 bg-[radial-gradient(#80808020_1px,transparent_1px)] [background-size:12px_12px]">
              <img
                src={nativeData.content}
                alt={result.fileName}
                className="max-h-[190px] max-w-full object-contain rounded"
              />
            </div>
          ) : isFile && nativeData?.type === "text" && highlightedContent ? (
            <div className="flex-1 overflow-auto font-mono text-[11px] leading-relaxed p-2.5 text-neutral-700 dark:text-neutral-300">
              <pre className="m-0 p-0 whitespace-pre-wrap break-words">
                <code dangerouslySetInnerHTML={{ __html: highlightedContent }} />
              </pre>
            </div>
          ) : loading ? (
            <div className="flex-1 flex items-center justify-center py-8">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-4 text-center text-neutral-400 text-xs">
              <FileText size={32} className="mb-2 opacity-30" />
              <span className="truncate max-w-full px-2 text-[11px] text-neutral-500">
                {result.snippet || result.filePath}
              </span>
            </div>
          )}
        </div>

        {/* 3. Metadata Table (For Files & Apps) */}
        {(isFile || isApp) && (
          <div className="grid grid-cols-2 gap-2 text-[11px] text-neutral-500 dark:text-neutral-400 mt-1">
            <div className="flex items-center gap-1.5 truncate p-1.5 rounded-lg bg-neutral-100/60 dark:bg-neutral-800/40">
              <HardDrive size={12} className="shrink-0 text-neutral-400" />
              <span className="truncate">{result.fileSize ? formatBytes(result.fileSize) : "N/A"}</span>
            </div>
            <div className="flex items-center gap-1.5 truncate p-1.5 rounded-lg bg-neutral-100/60 dark:bg-neutral-800/40">
              <Calendar size={12} className="shrink-0 text-neutral-400" />
              <span className="truncate">{formatDate(result.fileModified) || "N/A"}</span>
            </div>
          </div>
        )}
      </div>

      {/* 4. Action Buttons Footer */}
      <div className="flex flex-col gap-2 mt-4 pt-3 border-t border-black/5 dark:border-white/5">
        <button
          onClick={() => onOpenFile(result.filePath)}
          className="w-full py-2 px-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs flex items-center justify-center gap-2 shadow-sm transition-all"
        >
          {isWeb ? <ExternalLink size={14} /> : isApp ? <LayoutGrid size={14} /> : isCalc || isConverter ? <Copy size={14} /> : <FileText size={14} />}
          <span>
            {isWeb
              ? "Open in Browser (Enter)"
              : isApp
              ? "Launch Application (Enter)"
              : isCalc || isConverter
              ? "Copy Result (Enter)"
              : "Open File (Enter)"}
          </span>
        </button>

        <div className="flex items-center gap-1.5">
          {onOpenFolder && isFile && (
            <button
              onClick={() => onOpenFolder(result.filePath)}
              className="flex-1 py-1.5 px-2 rounded-lg bg-neutral-150 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 text-[11px] font-medium flex items-center justify-center gap-1.5 transition-colors"
              title="Reveal in Folder"
            >
              <FolderOpen size={12} />
              <span>Folder</span>
            </button>
          )}

          {onOpenInVscode && isFile && (
            <button
              onClick={() => onOpenInVscode(result.filePath)}
              className="flex-1 py-1.5 px-2 rounded-lg bg-neutral-150 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 text-[11px] font-medium flex items-center justify-center gap-1.5 transition-colors"
              title="Open in VS Code"
            >
              <Code2 size={12} />
              <span>VS Code</span>
            </button>
          )}

          {onOpenInTerminal && isFile && (
            <button
              onClick={() => onOpenInTerminal(result.filePath)}
              className="flex-1 py-1.5 px-2 rounded-lg bg-neutral-150 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 text-[11px] font-medium flex items-center justify-center gap-1.5 transition-colors"
              title="Open in Terminal"
            >
              <Terminal size={12} />
              <span>Terminal</span>
            </button>
          )}

          {onRunAsAdmin && isApp && (
            <button
              onClick={() => onRunAsAdmin(result.filePath)}
              className="flex-1 py-1.5 px-2 rounded-lg bg-neutral-150 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 text-[11px] font-medium flex items-center justify-center gap-1.5 transition-colors"
              title="Run as Administrator"
            >
              <ShieldAlert size={12} />
              <span>Admin</span>
            </button>
          )}

          <button
            onClick={handleCopy}
            className="py-1.5 px-2.5 rounded-lg bg-neutral-150 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 text-[11px] font-medium flex items-center justify-center gap-1.5 transition-colors shrink-0"
            title="Copy Path"
          >
            {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
