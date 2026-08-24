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
    { id: "all", label: t("search.tabAll", "All"), icon: <Sparkles size={12} className="shrink-0" /> },
    { id: "apps", label: t("search.tabApps", "Apps"), icon: <LayoutGrid size={12} className="shrink-0" /> },
    { id: "files", label: t("search.tabFiles", "Files"), icon: <FileText size={12} className="shrink-0" /> },
    { id: "content", label: t("search.tabContent", "Content"), icon: <FileCode size={12} className="shrink-0" /> },
  ];

  return (
    <div className="flex items-center gap-1 p-1 rounded-xl bg-neutral-100/80 dark:bg-neutral-800/60 backdrop-blur-md border border-black/5 dark:border-white/5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={clsx(
            "flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg transition-all duration-150 cursor-pointer select-none",
            activeTab === tab.id
              ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 shadow-sm shadow-black/5 font-semibold"
              : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-200/40 dark:hover:bg-neutral-700/40",
          )}
        >
          {tab.icon}
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
