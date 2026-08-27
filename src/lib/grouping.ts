import type { SearchResult, SearchTab } from "../hooks/useSearch";

export type ResultCategory = "converter" | "calc" | "app" | "repo" | "file" | "content" | "web";

export interface GroupedResult extends SearchResult {
  /** Position in the flattened display order (what keyboard navigation uses). */
  flatIndex: number;
}

export interface ResultGroup {
  category: ResultCategory;
  labelKey: string;
  fallbackLabel: string;
  items: GroupedResult[];
}

/** Display order of the sections. Instant answers first, then apps, then git repos, then filenames, then in-file content, then web fallbacks. */
const ORDER: { category: ResultCategory; labelKey: string; fallbackLabel: string }[] = [
  { category: "converter", labelKey: "results.secConverter", fallbackLabel: "Unit & Currency Converter" },
  { category: "calc", labelKey: "results.secCalc", fallbackLabel: "Calculations & Actions" },
  { category: "app", labelKey: "results.secApps", fallbackLabel: "Applications" },
  { category: "repo", labelKey: "results.secRepos", fallbackLabel: "Git Repositories & Workspaces" },
  { category: "file", labelKey: "results.secFiles", fallbackLabel: "Files" },
  { category: "content", labelKey: "results.secContent", fallbackLabel: "In-File Content" },
  { category: "web", labelKey: "results.secWeb", fallbackLabel: "Web Searches & Shortcuts" },
];

function categoryOf(result: SearchResult): ResultCategory {
  if (result.category === "converter") return "converter";
  if (result.category === "calc" || result.category === "action") return "calc";
  if (result.category === "web") return "web";
  if (result.category === "app") return "app";
  if (result.category === "repo") return "repo";
  if (result.category === "content") return "content";
  return "file";
}

/**
 * Split results into display sections, keeping the backend's relevance order
 * inside each one and assigning every item its flat keyboard index.
 *
 * Grouping only applies to the "all" tab; a single-category tab is already
 * homogeneous and headers would just be noise.
 */
export function groupResults(results: SearchResult[], activeTab: SearchTab): ResultGroup[] {
  if (activeTab !== "all") {
    return [
      {
        category: "file",
        labelKey: "",
        fallbackLabel: "",
        items: results.map((r, i) => ({ ...r, flatIndex: i })),
      },
    ];
  }

  const buckets = new Map<ResultCategory, SearchResult[]>();
  for (const result of results) {
    const category = categoryOf(result);
    const bucket = buckets.get(category);
    if (bucket) bucket.push(result);
    else buckets.set(category, [result]);
  }

  const groups: ResultGroup[] = [];
  let flatIndex = 0;
  for (const spec of ORDER) {
    const items = buckets.get(spec.category);
    if (!items || items.length === 0) continue;
    groups.push({
      ...spec,
      items: items.map((r) => ({ ...r, flatIndex: flatIndex++ })),
    });
  }
  return groups;
}

/** The results in display order (what Enter, arrows and Ctrl+N act on). */
export function flattenGroups(groups: ResultGroup[]): GroupedResult[] {
  return groups.flatMap((g) => g.items);
}
