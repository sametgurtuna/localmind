import { useState, useEffect, useRef, useMemo } from "react";
import {
  X,
  ExternalLink,
  Copy,
  Check,
  FolderOpen,
  FileText,
  FileCode,
  Image as ImageIcon,
  File,
  LayoutGrid,
} from "lucide-react";
import hljs from "highlight.js/lib/core";
import { getApiBaseUrl } from "../lib/api";

// Syntax Highlight Languages
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import cpp from "highlight.js/lib/languages/cpp";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import bash from "highlight.js/lib/languages/bash";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("svg", xml);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c", cpp);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);

const EXT_TO_LANG: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".css": "css",
  ".html": "xml",
  ".xml": "xml",
  ".json": "json",
  ".md": "markdown",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "cpp",
  ".cpp": "cpp",
  ".h": "cpp",
  ".sql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sh": "bash",
  ".bat": "bash",
};

interface FilePreviewProps {
  filePath: string;
  fileName: string;
  lineStart?: number;
  icon?: string;
  category?: string;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onOpenFolder?: (path: string) => void;
}

interface PreviewData {
  type: "text" | "image" | "pdf" | "binary" | "app" | "pdf_pending" | "unknown";
  content: string;
  pdf_image?: string;
  page_count?: number;
  total_lines: number;
  start_line: number;
  file_ext: string;
  file_size?: number;
  modified?: number;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let val = bytes;
  let unitIndex = 0;
  while (val >= 1024 && unitIndex < units.length - 1) {
    val /= 1024;
    unitIndex++;
  }
  return `${val.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function FilePreview({
  filePath,
  fileName,
  lineStart,
  icon,
  category,
  onClose,
  onOpenFile,
  onOpenFolder,
}: FilePreviewProps) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [pdfViewMode, setPdfViewMode] = useState<"page" | "text">("page");
  const [copiedPath, setCopiedPath] = useState(false);
  const [copiedContent, setCopiedContent] = useState(false);
  const codeRef = useRef<HTMLPreElement>(null);
  const highlightLineRef = useRef<HTMLTableRowElement>(null);

  // Fetch preview data: Native Rust IPC first (instant), fallback/enrich with PyMuPDF sidecar
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function loadPreview() {
      // 1. Try native Rust command (instant <0.1ms for images, apps, PDF base64, code/text)
      let nativeData: PreviewData | null = null;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const res = await invoke<PreviewData>("get_file_preview_native", {
          path: filePath,
          line: lineStart || 0,
          context: 80,
        });
        if (!cancelled && res && (res.content || res.type === "image" || res.type === "pdf" || res.type === "app")) {
          nativeData = res;
          setData(res);
          setLoading(false);
          // If not PDF, we are done immediately!
          if (res.type !== "pdf") return;
        }
      } catch (err) {
        console.warn("Native preview error:", err);
      }

      // 2. Query PyMuPDF sidecar in background (for extracted text and page 1 raster render)
      try {
        const baseUrl = getApiBaseUrl();
        const params = new URLSearchParams({ path: filePath });
        if (lineStart) params.set("line", String(lineStart));

        const r = await fetch(`${baseUrl}/preview?${params}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) {
          const d = await r.json();
          if (!cancelled && d && (d.content || d.pdf_image || d.type === "image" || d.type === "pdf")) {
            setData((prev) => ({
              ...(prev || {}),
              ...d,
              content: d.content || prev?.content || "",
              pdf_image: d.pdf_image || prev?.pdf_image,
              type: d.type || prev?.type || "pdf",
            }));
            setLoading(false);
            return;
          }
        }
      } catch (err) {
        console.warn("Sidecar preview fetch fallback:", err);
      }

      if (!cancelled) {
        if (!nativeData) setLoading(false);
      }
    }

    loadPreview();
    return () => {
      cancelled = true;
    };
  }, [filePath, lineStart]);

  // Scroll to targeted line when lineStart is given
  useEffect(() => {
    if (highlightLineRef.current) {
      highlightLineRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [data]);

  // Global Keyboard shortcuts when Preview Modal is open
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (e.ctrlKey && e.key.toLowerCase() === "p")) {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && !e.ctrlKey) {
        e.preventDefault();
        onOpenFile(filePath);
      } else if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        onOpenFolder?.(filePath);
      } else if (e.ctrlKey && (e.key === "c" || e.key === "C") && e.shiftKey) {
        e.preventDefault();
        handleCopyPath();
      } else if (e.ctrlKey && (e.key === "c" || e.key === "C") && !e.shiftKey && data?.type === "text" && data.content) {
        handleCopyContent();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [filePath, data, onClose, onOpenFile, onOpenFolder]);

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(filePath);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 2000);
    } catch {
      /* noop */
    }
  };

  const handleCopyContent = async () => {
    if (!data?.content) return;
    try {
      await navigator.clipboard.writeText(data.content);
      setCopiedContent(true);
      setTimeout(() => setCopiedContent(false), 2000);
    } catch {
      /* noop */
    }
  };

  const ext = (data?.file_ext || fileName.split(".").pop() || "").toLowerCase();
  const normalizedExt = ext.startsWith(".") ? ext : `.${ext}`;
  const lang = EXT_TO_LANG[normalizedExt];

  // Highlight syntax with line numbers
  const highlightedLines = useMemo(() => {
    if (!data?.content || data.type !== "text") return [];
    const rawLines = data.content.split("\n");
    return rawLines.map((lineStr, idx) => {
      const lineNum = (data.start_line || 1) + idx;
      let html = lineStr;
      if (lang) {
        try {
          html = hljs.highlight(lineStr, { language: lang, ignoreIllegals: true }).value;
        } catch {
          html = lineStr;
        }
      }
      return { lineNum, html: html || "&nbsp;", isTarget: lineStart ? lineNum === lineStart : false };
    });
  }, [data, lang, lineStart]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-md animate-fade-in"
      onClick={onClose}
    >
      {/* PowerToys Peek Modal Container */}
      <div
        className="w-full max-w-4xl max-h-[85vh] bg-white/95 dark:bg-neutral-900/95 backdrop-blur-2xl border border-black/10 dark:border-white/10 flex flex-col rounded-2xl shadow-2xl overflow-hidden transition-all scale-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header Bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/10 dark:border-white/10 bg-neutral-50/80 dark:bg-neutral-800/60">
          {/* File Identity */}
          <div className="flex items-center gap-3 min-w-0 pr-4">
            {icon ? (
              <img src={icon} alt="" className="w-6 h-6 object-contain rounded shrink-0" />
            ) : category === "app" ? (
              <LayoutGrid size={22} className="text-blue-500 shrink-0" />
            ) : data?.type === "image" ? (
              <ImageIcon size={22} className="text-pink-500 shrink-0" />
            ) : lang ? (
              <FileCode size={22} className="text-sky-500 shrink-0" />
            ) : (
              <FileText size={22} className="text-neutral-400 shrink-0" />
            )}

            <div className="min-w-0 flex flex-col">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate">
                  {fileName}
                </span>
                {normalizedExt && (
                  <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300">
                    {normalizedExt.replace(".", "")}
                  </span>
                )}
              </div>
              <span className="text-[11px] text-neutral-400 dark:text-neutral-500 truncate max-w-md">
                {filePath}
              </span>
            </div>
          </div>

          {/* Quick Action Buttons */}
          <div className="flex items-center gap-1.5 shrink-0">
            {data?.type === "text" && data.content && (
              <button
                onClick={handleCopyContent}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-200/60 dark:bg-neutral-800 hover:bg-neutral-300/70 dark:hover:bg-neutral-700 transition-colors"
                title="Copy Content (Ctrl+C)"
              >
                {copiedContent ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
                <span className="hidden sm:inline">{copiedContent ? "Copied" : "Copy Content"}</span>
              </button>
            )}

            <button
              onClick={handleCopyPath}
              className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-200/60 dark:hover:bg-neutral-800 transition-colors"
              title="Copy Full Path (Ctrl+Shift+C)"
            >
              {copiedPath ? <Check size={15} className="text-emerald-500" /> : <Copy size={15} />}
            </button>

            {onOpenFolder && (
              <button
                onClick={() => onOpenFolder(filePath)}
                className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-200/60 dark:hover:bg-neutral-800 transition-colors"
                title="Reveal in Explorer (Ctrl+Enter)"
              >
                <FolderOpen size={15} />
              </button>
            )}

            <button
              onClick={() => onOpenFile(filePath)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 shadow-sm transition-colors"
              title="Open File (Enter)"
            >
              <ExternalLink size={13} />
              <span>Open</span>
            </button>

            <button
              onClick={onClose}
              className="p-1.5 ml-1 rounded-lg text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-200/60 dark:hover:bg-neutral-800 transition-colors"
              title="Close Preview (Esc)"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content Viewer Body */}
        <div className="flex-1 min-h-[300px] max-h-[65vh] overflow-y-auto bg-neutral-100/50 dark:bg-neutral-950/70 p-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-neutral-400">Loading PowerToys Preview...</span>
            </div>
          ) : data?.type === "pdf" ? (
            /* High-Res PDF Document Viewer (PyMuPDF) */
            <div className="flex flex-col items-center justify-center py-2">
              {data.pdf_image && data.content && (
                <div className="mb-3 flex items-center p-0.5 rounded-lg bg-neutral-200/80 dark:bg-neutral-800/80 text-xs select-none">
                  <button
                    onClick={() => setPdfViewMode("page")}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded-md font-medium transition-all ${
                      pdfViewMode === "page"
                        ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-xs"
                        : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                    }`}
                  >
                    <ImageIcon size={13} />
                    <span>Page View</span>
                  </button>
                  <button
                    onClick={() => setPdfViewMode("text")}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded-md font-medium transition-all ${
                      pdfViewMode === "text"
                        ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-xs"
                        : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                    }`}
                  >
                    <FileText size={13} />
                    <span>Text Content</span>
                  </button>
                </div>
              )}

              {pdfViewMode === "page" ? (
                data.pdf_image ? (
                  <div className="flex flex-col items-center">
                    <div className="max-w-full max-h-[52vh] rounded-lg overflow-hidden border border-neutral-300 dark:border-neutral-700 shadow-2xl bg-white">
                      <img
                        src={data.pdf_image}
                        alt={fileName}
                        className="max-h-[52vh] max-w-full object-contain mx-auto"
                      />
                    </div>
                    <div className="mt-3 flex items-center gap-3 text-xs text-neutral-500">
                      <span className="font-semibold text-neutral-700 dark:text-neutral-300">
                        Sayfa 1 / {data.page_count || 1}
                      </span>
                      <span>•</span>
                      <span>{data.file_size ? formatBytes(data.file_size) : ""}</span>
                      <span>•</span>
                      <span className="text-red-500 font-bold uppercase">PDF Belgesi</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-16 gap-3 text-neutral-400">
                    <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs">PDF sayfası oluşturuluyor...</span>
                  </div>
                )
              ) : (
                /* Extracted PDF Text */
                <div className="w-full rounded-xl border border-black/10 dark:border-white/10 bg-white/90 dark:bg-neutral-900/90 overflow-hidden font-mono text-[12px] leading-relaxed shadow-sm">
                  <pre ref={codeRef} className="m-0 p-0 overflow-x-auto">
                    <table className="w-full border-collapse">
                      <tbody>
                        {highlightedLines.map(({ lineNum, html, isTarget }) => (
                          <tr
                            key={lineNum}
                            ref={isTarget ? highlightLineRef : null}
                            className="hover:bg-neutral-100/70 dark:hover:bg-neutral-800/40 transition-colors"
                          >
                            <td className="w-12 py-0.5 pr-3 pl-3 text-right select-none text-[11px] text-neutral-400 dark:text-neutral-600 border-r border-black/5 dark:border-white/5 font-medium">
                              {lineNum}
                            </td>
                            <td className="py-0.5 px-3 text-neutral-800 dark:text-neutral-200 whitespace-pre break-words">
                              <span dangerouslySetInnerHTML={{ __html: html }} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </pre>
                </div>
              )}
            </div>
          ) : data?.type === "image" && data.content ? (
            /* High-Res Image Preview */
            <div className="flex flex-col items-center justify-center py-4">
              <div className="max-w-full max-h-[50vh] rounded-xl overflow-hidden border border-black/10 dark:border-white/10 shadow-lg bg-[radial-gradient(#80808020_1px,transparent_1px)] [background-size:16px_16px]">
                <img
                  src={data.content}
                  alt={fileName}
                  className="max-h-[50vh] max-w-full object-contain mx-auto"
                />
              </div>
              <div className="mt-3 flex items-center gap-3 text-xs text-neutral-500">
                <span>{data.file_size ? formatBytes(data.file_size) : ""}</span>
                <span>•</span>
                <span className="uppercase font-semibold">{normalizedExt} Image</span>
              </div>
            </div>
          ) : data?.type === "text" && highlightedLines.length > 0 ? (
            /* Code / Text Document Viewer with Line Numbers */
            <div className="rounded-xl border border-black/10 dark:border-white/10 bg-white/90 dark:bg-neutral-900/90 overflow-hidden font-mono text-[12px] leading-relaxed shadow-sm">
              <pre ref={codeRef} className="m-0 p-0 overflow-x-auto">
                <table className="w-full border-collapse">
                  <tbody>
                    {highlightedLines.map(({ lineNum, html, isTarget }) => (
                      <tr
                        key={lineNum}
                        ref={isTarget ? highlightLineRef : null}
                        className={`hover:bg-neutral-100/70 dark:hover:bg-neutral-800/40 transition-colors ${
                          isTarget ? "bg-blue-500/15 dark:bg-blue-500/20 font-semibold" : ""
                        }`}
                      >
                        {/* Line Number Gutter */}
                        <td className="w-12 py-0.5 pr-3 pl-3 text-right select-none text-[11px] text-neutral-400 dark:text-neutral-600 border-r border-black/5 dark:border-white/5 font-medium">
                          {lineNum}
                        </td>
                        {/* Code Line */}
                        <td className="py-0.5 px-3 text-neutral-800 dark:text-neutral-200 whitespace-pre break-words">
                          <span dangerouslySetInnerHTML={{ __html: html }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </pre>
            </div>
          ) : (
            /* Binary / File Inspector Card */
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <div className="p-4 rounded-2xl bg-neutral-200/50 dark:bg-neutral-800/50 border border-black/5 dark:border-white/5">
                {category === "app" ? (
                  <LayoutGrid size={48} className="text-blue-500" />
                ) : (
                  <File size={48} className="text-neutral-400" />
                )}
              </div>
              <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
                {fileName}
              </h3>
              <p className="text-xs text-neutral-400 max-w-sm">
                {data?.file_size ? `${formatBytes(data.file_size)} • ` : ""}
                {category === "app" ? "Executable Application" : "Binary File Preview"}
              </p>
              <button
                onClick={() => onOpenFile(filePath)}
                className="mt-2 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 shadow transition-all"
              >
                Launch & Open in Default App
              </button>
            </div>
          )}
        </div>

        {/* Footer Meta & Keyboard Hints */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-black/10 dark:border-white/10 bg-neutral-50/90 dark:bg-neutral-800/80 text-[11px] text-neutral-500 dark:text-neutral-400">
          <div className="flex items-center gap-3">
            {data?.total_lines ? (
              <span>{data.total_lines} total lines</span>
            ) : null}
            {data?.file_size ? (
              <span>{formatBytes(data.file_size)}</span>
            ) : null}
          </div>

          <div className="flex items-center gap-2 font-medium">
            <span><kbd className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/10 text-[10px]">Esc</kbd> Close</span>
            <span>•</span>
            <span><kbd className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/10 text-[10px]">↵</kbd> Open</span>
            <span>•</span>
            <span><kbd className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/10 text-[10px]">Ctrl+↵</kbd> Explorer</span>
          </div>
        </div>
      </div>
    </div>
  );
}
