import { Sun, Moon } from "lucide-react";
import { clsx } from "clsx";

interface ThemeToggleProps {
  theme: "dark" | "light";
  onToggle: () => void;
  labels?: { dark: string; light: string };
}

export function ThemeToggle({ theme, onToggle, labels }: ThemeToggleProps) {
  return (
    <button
      onClick={onToggle}
      className={clsx(
        "flex items-center gap-2 px-3 py-2 rounded-lg transition-colors",
        "bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700",
        "text-neutral-700 dark:text-neutral-300 text-sm",
      )}
    >
      {theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
      {labels && (
        <span>{theme === "dark" ? labels.dark : labels.light}</span>
      )}
    </button>
  );
}
