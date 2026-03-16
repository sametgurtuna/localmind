import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X, ExternalLink, Copy } from "lucide-react";
import hljs from "highlight.js/lib/core";

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
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("bash", bash);

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
  sidecarPort: number | null;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}

interface PreviewData {
  content: string;
  total_lines: number;
  start_line: number;
  file_ext: string;
}

export function FilePreview({
  filePath,
  fileName,
  lineStart,
  sidecarPort,
  onClose,
  onOpenFile,
}: FilePreviewProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const codeRef = useRef<HTMLPreElement>(null);
  const highlightLineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sidecarPort) return;

    setLoading(true);
    const params = new URLSearchParams({ path: filePath });
    if (lineStart) params.set("line", String(lineStart));

    fetch(`http://127.0.0.1:${sidecarPort}/preview?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [filePath, lineStart, sidecarPort]);

  useEffect(() => {
    if (highlightLineRef.current) {
      highlightLineRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [data]);

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(filePath);
    } catch {
      /* noop */
    }
  };

  const lang = data?.file_ext ? EXT_TO_LANG[data.file_ext] : undefined;

  let highlighted = "";
  if (data?.content && lang) {
    try {
      highlighted = hljs.highlight(data.content, { language: lang }).value;
    } catch {
      highlighted = "";
    }
  }

  return (
    <div className="animate-slide-fade-in border-t border-neutral-200 dark:border-neutral-700">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-neutral-50 dark:bg-neutral-800/50">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300 truncate">
            {fileName}
          </span>
          {data && (
            <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
              {data.total_lines} lines
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleCopyPath}
            className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-400"
            title={t("results.copyPath")}
          >
            <Copy size={12} />
          </button>
          <button
            onClick={() => onOpenFile(filePath)}
            className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-400"
            title={t("results.openFile")}
          >
            <ExternalLink size={12} />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-400"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-h-[200px] overflow-y-auto bg-neutral-50 dark:bg-neutral-950/50">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-4 h-4 border-2 border-neutral-300 dark:border-neutral-600 border-t-neutral-600 dark:border-t-neutral-300 rounded-full animate-spin" />
          </div>
        ) : data?.content ? (
          <pre
            ref={codeRef}
            className="text-[11px] leading-[1.6] font-mono p-3 m-0 whitespace-pre-wrap break-words"
          >
            {highlighted ? (
              <code dangerouslySetInnerHTML={{ __html: highlighted }} />
            ) : (
              <code className="text-neutral-700 dark:text-neutral-300">
                {data.content}
              </code>
            )}
          </pre>
        ) : (
          <div className="px-4 py-6 text-center text-xs text-neutral-400">
            Unable to preview this file
          </div>
        )}
      </div>
    </div>
  );
}
