import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  ExternalLink,
  FolderOpen,
  Copy,
  Code,
  Terminal,
  Shield,
  Eye,
  Star,
  Trash2,
  Sparkles,
  Github,
  X,
  Zap,
} from "lucide-react";
import { clsx } from "clsx";
import type { SearchResult } from "../hooks/useSearch";

export interface ActionItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  shortcut?: string;
  danger?: boolean;
  onExecute: () => void;
}

interface ActionMenuProps {
  isOpen: boolean;
  onClose: () => void;
  result: SearchResult | null;
  onOpenFile: (path: string) => void;
  onOpenFolder: (path: string) => void;
  onOpenInVscode: (path: string) => void;
  onOpenInTerminal: (path: string) => void;
  onRunAsAdmin: (path: string) => void;
  onCopyPath: (path: string) => void;
  onTogglePreview: () => void;
  onTogglePin: (path: string, name: string) => void;
  onSearchSimilar: (filePath: string) => void;
  onDeleteFile: (path: string) => void;
  isPinned: boolean;
}

export function ActionMenu({
  isOpen,
  onClose,
  result,
  onOpenFile,
  onOpenFolder,
  onOpenInVscode,
  onOpenInTerminal,
  onRunAsAdmin,
  onCopyPath,
  onTogglePreview,
  onTogglePin,
  onSearchSimilar,
  onDeleteFile,
  isPinned,
}: ActionMenuProps) {
  const { t } = useTranslation();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setSelectedIndex(0);
      // Small timeout ensures the DOM node is rendered and ready for focus
      setTimeout(() => {
        containerRef.current?.focus();
      }, 10);
    }
  }, [isOpen, result?.filePath]);

  if (!isOpen || !result) return null;

  const isApp = result.category === "app";
  const isCalc = result.category === "calc";
  const isAction = result.category === "action";
  const isRepo = result.category === "repo";

  const actions: ActionItem[] = [];

  if (isCalc || isAction) {
    if (result.action === "system_command") {
      actions.push({
        id: "execute",
        label: result.actionTitle || "Execute Action",
        icon: <Zap size={16} className="text-purple-500" />,
        shortcut: "↵",
        onExecute: () => {
          invoke("system_command", { command: result.filePath }).catch(() => {});
          onClose();
        },
      });
    } else {
      actions.push({
        id: "copy",
        label: result.actionTitle || "Copy Result",
        icon: <Copy size={16} className="text-amber-500" />,
        shortcut: "↵",
        onExecute: () => {
          onCopyPath(result.filePath);
          onClose();
        },
      });
    }
  } else if (isRepo) {
    // 1. Primary Action for Repos: Open in VS Code
    actions.push({
      id: "vscode",
      label: t("results.openInVscode", "Open in VS Code"),
      icon: <Code size={16} className="text-cyan-500" />,
      shortcut: "↵",
      onExecute: () => {
        onOpenInVscode(result.filePath);
        onClose();
      },
    });

    // 2. Open in Terminal
    actions.push({
      id: "terminal",
      label: t("results.openInTerminal", "Open in Terminal"),
      icon: <Terminal size={16} className="text-purple-500" />,
      shortcut: "Ctrl+Alt+T",
      onExecute: () => {
        onOpenInTerminal(result.filePath);
        onClose();
      },
    });

    // 3. Open on GitHub / Remote
    actions.push({
      id: "github",
      label: t("results.openOnGithub", "View on GitHub / Remote"),
      icon: <Github size={16} className="text-neutral-800 dark:text-neutral-200" />,
      shortcut: "Ctrl+G",
      onExecute: () => {
        invoke("open_git_remote", { path: result.filePath }).catch(() => {});
        onClose();
      },
    });

    // 4. Open Folder in Explorer
    actions.push({
      id: "folder",
      label: t("results.openFolder", "Show in Explorer"),
      icon: <FolderOpen size={16} className="text-amber-500" />,
      shortcut: "Ctrl+↵",
      onExecute: () => {
        onOpenFolder(result.filePath);
        onClose();
      },
    });

    // 5. Copy Path
    actions.push({
      id: "copy",
      label: t("results.copyPath", "Copy Full Path"),
      icon: <Copy size={16} className="text-emerald-500" />,
      shortcut: "Ctrl+C",
      onExecute: () => {
        onCopyPath(result.filePath);
        onClose();
      },
    });

    // 6. Preview Dashboard
    actions.push({
      id: "preview",
      label: "Workspace Dashboard",
      icon: <Eye size={16} className="text-indigo-500" />,
      shortcut: "Ctrl+P",
      onExecute: () => {
        onTogglePreview();
        onClose();
      },
    });
  } else {
    // 1. Primary Open
    actions.push({
      id: "open",
      label: isApp ? "Launch Application" : t("results.openFile", "Open"),
      icon: <ExternalLink size={16} className="text-blue-500" />,
      shortcut: "↵",
      onExecute: () => {
        onOpenFile(result.filePath);
        onClose();
      },
    });

    // 2. Open Folder
    actions.push({
      id: "folder",
      label: t("results.openFolder", "Show in Explorer"),
      icon: <FolderOpen size={16} className="text-amber-500" />,
      shortcut: "Ctrl+↵",
      onExecute: () => {
        onOpenFolder(result.filePath);
        onClose();
      },
    });

    // 3. Copy Path
    actions.push({
      id: "copy",
      label: t("results.copyPath", "Copy Full Path"),
      icon: <Copy size={16} className="text-emerald-500" />,
      shortcut: "Ctrl+C",
      onExecute: () => {
        onCopyPath(result.filePath);
        onClose();
      },
    });

    // 4. Open in VS Code (if file)
    if (!isApp) {
      actions.push({
        id: "vscode",
        label: t("results.openInVscode", "Open in VS Code"),
        icon: <Code size={16} className="text-cyan-500" />,
        shortcut: "Ctrl+Alt+V",
        onExecute: () => {
          onOpenInVscode(result.filePath);
          onClose();
        },
      });

      actions.push({
        id: "terminal",
        label: t("results.openInTerminal", "Open in Terminal"),
        icon: <Terminal size={16} className="text-purple-500" />,
        shortcut: "Ctrl+Alt+T",
        onExecute: () => {
          onOpenInTerminal(result.filePath);
          onClose();
        },
      });

      actions.push({
        id: "preview",
        label: "Quick Preview",
        icon: <Eye size={16} className="text-indigo-500" />,
        shortcut: "Ctrl+P",
        onExecute: () => {
          onTogglePreview();
          onClose();
        },
      });

      actions.push({
        id: "similar",
        label: t("search.similarFiles", "Find Similar Files"),
        icon: <Sparkles size={16} className="text-violet-500" />,
        shortcut: "Ctrl+S",
        onExecute: () => {
          onSearchSimilar(result.filePath);
          onClose();
        },
      });
    }

    // 5. Run as admin
    if (isApp || result.fileName.endsWith(".exe") || result.fileName.endsWith(".bat") || result.fileName.endsWith(".ps1")) {
      actions.push({
        id: "admin",
        label: t("results.runAsAdmin", "Run as Administrator"),
        icon: <Shield size={16} className="text-red-500" />,
        onExecute: () => {
          onRunAsAdmin(result.filePath);
          onClose();
        },
      });
    }

    // 6. Pin / Unpin
    actions.push({
      id: "pin",
      label: isPinned ? t("results.unpin", "Unpin") : t("results.pin", "Pin to Quick Access"),
      icon: <Star size={16} className={clsx(isPinned ? "fill-amber-400 text-amber-400" : "text-neutral-400")} />,
      shortcut: "Ctrl+D",
      onExecute: () => {
        onTogglePin(result.filePath, result.fileName);
        onClose();
      },
    });

    // 7. Delete (only for files)
    if (!isApp) {
      actions.push({
        id: "delete",
        label: t("results.deleteFile", "Delete File"),
        icon: <Trash2 size={16} className="text-red-500" />,
        danger: true,
        shortcut: "Shift+Del",
        onExecute: () => {
          onDeleteFile(result.filePath);
          onClose();
        },
      });
    }
  }

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % actions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + actions.length) % actions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      actions[selectedIndex]?.onExecute();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in p-4"
      onClick={onClose}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      ref={containerRef}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white/95 dark:bg-neutral-900/95 backdrop-blur-xl border border-black/10 dark:border-white/10 shadow-2xl overflow-hidden animate-slide-fade-in flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/5 bg-neutral-50/50 dark:bg-neutral-800/30">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Actions</span>
            <span className="text-xs text-neutral-500 dark:text-neutral-400 truncate max-w-[200px]">
              {result.fileName}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-200/50 dark:hover:bg-neutral-700/50"
          >
            <X size={14} />
          </button>
        </div>

        {/* Action List */}
        <div className="p-1.5 max-h-[320px] overflow-y-auto">
          {actions.map((act, idx) => (
            <div
              key={act.id}
              onClick={act.onExecute}
              onMouseEnter={() => setSelectedIndex(idx)}
              className={clsx(
                "flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium cursor-pointer transition-all duration-100",
                idx === selectedIndex
                  ? act.danger
                    ? "bg-red-500/10 text-red-600 dark:text-red-400"
                    : "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-semibold"
                  : act.danger
                  ? "text-red-500/80 hover:bg-red-500/5"
                  : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100/50 dark:hover:bg-neutral-800/50",
              )}
            >
              <div className="flex items-center gap-2.5">
                {act.icon}
                <span>{act.label}</span>
              </div>
              {act.shortcut && (
                <kbd className="px-1.5 py-0.5 text-[10px] font-mono text-neutral-400 dark:text-neutral-500 bg-neutral-200/60 dark:bg-neutral-800 rounded border border-black/5 dark:border-white/5">
                  {act.shortcut}
                </kbd>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
