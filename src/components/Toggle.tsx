import { clsx } from "clsx";

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  /** Optional trailing note, e.g. a cost or a caveat. */
  note?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, description, note, icon, disabled }: ToggleProps) {
  return (
    <div
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      className={clsx(
        "group flex items-start justify-between gap-4 p-2.5 -mx-2.5 rounded-xl transition-colors duration-150 select-none",
        disabled
          ? "opacity-45 cursor-not-allowed"
          : "cursor-pointer hover:bg-neutral-100/70 dark:hover:bg-neutral-800/40",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {icon && (
            <span className="shrink-0 text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-700 dark:group-hover:text-neutral-200 transition-colors">
              {icon}
            </span>
          )}
          <span className="text-xs font-medium text-neutral-800 dark:text-neutral-200">
            {label}
          </span>
        </div>
        {description && (
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            {description}
          </p>
        )}
        {note && (
          <p className="mt-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-500 font-medium">
            {note}
          </p>
        )}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) onChange(!checked);
        }}
        className={clsx(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 ease-in-out mt-0.5 outline-none cursor-pointer",
          "focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900",
          disabled && "cursor-not-allowed",
          checked
            ? "bg-blue-600 dark:bg-blue-500 group-hover:bg-blue-700 dark:group-hover:bg-blue-400"
            : "bg-neutral-300 dark:bg-neutral-700 group-hover:bg-neutral-400/80 dark:group-hover:bg-neutral-600",
        )}
      >
        <span
          className={clsx(
            "pointer-events-none absolute top-0.5 left-0.5 inline-block h-4 w-4 rounded-full bg-white shadow-xs ring-0 transition-transform duration-200 ease-in-out group-active:scale-95",
            checked ? "translate-x-4" : "translate-x-0",
          )}
        />
      </button>
    </div>
  );
}
