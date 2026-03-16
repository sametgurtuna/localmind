import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import type { SearchTab } from "../hooks/useSearch";

interface TabSelectorProps {
  activeTab: SearchTab;
  onTabChange: (tab: SearchTab) => void;
}

export function TabSelector({ activeTab, onTabChange }: TabSelectorProps) {
  const { t } = useTranslation();

  const tabs: { id: SearchTab; label: string }[] = [
    { id: "files", label: t("search.tabFiles") },
    { id: "semantic", label: t("search.tabSemantic") },
    { id: "apps", label: t("search.tabApps") },
  ];

  return (
    <div className="flex gap-0.5 p-0.5 rounded-lg bg-neutral-100 dark:bg-neutral-800/60">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={clsx(
            "px-2.5 py-1 text-[11px] font-medium rounded-md transition-all duration-150",
            activeTab === tab.id
              ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 shadow-sm"
              : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
