import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import type { SearchTab } from "../hooks/useSearch";
import { Sparkles, LayoutGrid, FileText, FileCode } from "lucide-react";

interface TabSelectorProps {
  activeTab: SearchTab;
  onTabChange: (tab: SearchTab) => void;
}

export function TabSelector({ activeTab, onTabChange }: TabSelectorProps) {
  const { t } = useTranslation();

  const tabs: { id: SearchTab; label: string; icon: React.ReactNode }[] = [
    { id: "all", label: t("search.tabAll", "All"), icon: <Sparkles size={11} className="shrink-0" /> },
    { id: "apps", label: t("search.tabApps", "Apps"), icon: <LayoutGrid size={11} className="shrink-0" /> },
    { id: "files", label: t("search.tabFiles", "Files"), icon: <FileText size={11} className="shrink-0" /> },
    { id: "content", label: t("search.tabContent", "Content"), icon: <FileCode size={11} className="shrink-0" /> },
  ];

  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-xl bg-neutral-100/80 dark:bg-neutral-800/60 backdrop-blur-md border border-black/5 dark:border-white/5 shrink-0">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={clsx(
            "flex items-center gap-1 px-2 py-0.5 sm:px-2.5 sm:py-1 text-xs font-medium rounded-lg transition-all duration-150 cursor-pointer select-none shrink-0",
            activeTab === tab.id
              ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 shadow-xs font-semibold"
              : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-200/40 dark:hover:bg-neutral-700/40",
          )}
        >
          {tab.icon}
          <span className="text-[11px] sm:text-xs">{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
