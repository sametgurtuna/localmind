import { Sun, Moon } from "lucide-react";
import { clsx } from "clsx";

interface ThemeToggleProps {
  theme: "dark" | "light";
  onToggle: () => void;
  labels?: { dark: string; light: string };
}

export function ThemeToggle({ theme, onToggle, labels }: ThemeToggleProps) {
  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => {
          if (theme !== "light") onToggle();
        }}
        className={clsx(
          "flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all cursor-pointer select-none",
          theme === "light"
            ? "bg-neutral-800 dark:bg-neutral-200 text-white dark:text-neutral-900 border-transparent font-medium shadow-xs"
            : "border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800",
        )}
      >
        <Sun size={13} />
        <span>{labels?.light ?? "Light"}</span>
      </button>

      <button
        type="button"
        onClick={() => {
          if (theme !== "dark") onToggle();
        }}
        className={clsx(
          "flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all cursor-pointer select-none",
          theme === "dark"
            ? "bg-neutral-800 dark:bg-neutral-200 text-white dark:text-neutral-900 border-transparent font-medium shadow-xs"
            : "border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800",
        )}
      >
        <Moon size={13} />
        <span>{labels?.dark ?? "Dark"}</span>
      </button>
    </div>
  );
}
