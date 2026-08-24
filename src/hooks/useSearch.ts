import { useState, useCallback, useRef, useEffect } from "react";
import { getSidecarPort, subscribeSidecarPort, setSidecarPort } from "../lib/api";
import { parseConverterQuery, initRatesUpdater } from "../lib/converter";
import { parseDirectUrl, parseWebShortcutQuery, getWebSearchFallbacks } from "../lib/webSearch";

export { setSidecarPort };

export interface SearchResult {
  fileName: string;
  filePath: string;
  snippet: string;
  score: number;
  chunkIndex?: number;
  lineStart?: number;
  lineEnd?: number;
  fileExt?: string;
  fileSize?: number;
  fileModified?: number;
  category?: "calc" | "converter" | "web" | "app" | "file" | "content" | "action";
  action?: string;
  actionTitle?: string;
  icon?: string;
}

export type SearchTab = "all" | "apps" | "files" | "content" | "actions";

interface SearchState {
  query: string;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  activeTab: SearchTab;
}

const searchCache = new Map<string, { results: SearchResult[]; ts: number }>();
const CACHE_TTL = 30_000;

function getCached(key: string): SearchResult[] | null {
  const entry = searchCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.results;
  searchCache.delete(key);
  return null;
}

function setCache(key: string, results: SearchResult[]) {
  if (searchCache.size > 150) {
    const oldest = searchCache.keys().next().value;
    if (oldest) searchCache.delete(oldest);
  }
  searchCache.set(key, { results, ts: Date.now() });
}

export function useSearch(portProp?: number | null) {
  const [state, setState] = useState<SearchState>({
    query: "",
    results: [],
    loading: false,
    error: null,
    activeTab: "all",
  });
  const portRef = useRef<number | null>(portProp || getSidecarPort());
  const abortRef = useRef<AbortController | null>(null);
  const activeTabRef = useRef(state.activeTab);
  activeTabRef.current = state.activeTab;

  useEffect(() => {
    if (portProp) {
      portRef.current = portProp;
    }
  }, [portProp]);

  useEffect(() => {
    initRatesUpdater();
    return subscribeSidecarPort((p) => {
      if (p) portRef.current = p;
    });
  }, []);

  const search = useCallback(async (query: string, tab?: SearchTab) => {
    const q = query.trim();
    if (!q) {
      setState((s) => ({ ...s, query, results: [], loading: false, error: null }));
      return;
    }

    const searchTab = tab ?? activeTabRef.current;
    const cacheKey = `${searchTab}:${q.toLowerCase()}`;

    const cached = getCached(cacheKey);
    if (cached) {
      setState((s) => ({ ...s, query, results: cached, loading: false, error: null }));
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Instant Tier 0: Converter, Direct URL, Web Search Shortcuts
    const instantActions: SearchResult[] = [];
    if (searchTab === "all" || searchTab === "actions") {
      const convRes = parseConverterQuery(q);
      if (convRes) instantActions.push(convRes);

      const directUrlRes = parseDirectUrl(q);
      if (directUrlRes) instantActions.push(directUrlRes);

      const webShortcutRes = parseWebShortcutQuery(q);
      if (webShortcutRes) instantActions.push(webShortcutRes);
    }

    const webFallbacks = (searchTab === "all" || searchTab === "actions") ? getWebSearchFallbacks(q) : [];

    // Keep showing previous results while loading (no flash of empty state)
    const initialInstant = [...instantActions, ...webFallbacks];
    if (initialInstant.length > 0) {
      setState((s) => ({ ...s, query, results: initialInstant, loading: true, error: null }));
    } else {
      setState((s) => ({ ...s, query, loading: true, error: null }));
    }

    let nativeMatched: SearchResult[] = [];

    // --- Tier 1: Instant Native Rust MFT & App Search (< 0.5ms) ---
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const nativeResults = await invoke<SearchResult[]>("fast_search_native", {
        query: q,
        filterType: searchTab,
        limit: 25,
      });

      if (nativeResults && !controller.signal.aborted) {
        nativeMatched = nativeResults;
        const instantMerged = [...instantActions, ...nativeResults, ...webFallbacks];
        setState((s) => ({
          ...s,
          results: instantMerged,
          loading: false,
          error: null,
        }));

        // If top app, converter, or exact filename match on short query, return instantly
        const bestScore = nativeResults[0]?.score ?? (instantActions.length > 0 ? 1.0 : 0);
        const isShortQuery = q.split(/\s+/).length <= 2;
        if (bestScore >= 0.98 && isShortQuery && searchTab !== "content") {
          setCache(cacheKey, instantMerged);
          return;
        }
      }
    } catch {
      /* Browser fallback if running outside Tauri */
    }

    // --- Tier 2: Asynchronous AI Semantic Content Search (20-40ms) ---
    const currentPort = portRef.current || getSidecarPort();
    if (!currentPort) {
      const fallbackCombined = [...instantActions, ...nativeMatched, ...webFallbacks];
      if (fallbackCombined.length > 0) {
        setCache(cacheKey, fallbackCombined);
      }
      setState((s) => ({ ...s, results: fallbackCombined, loading: false }));
      return;
    }

    try {
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(`http://127.0.0.1:${currentPort}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, type: searchTab, limit: 25 }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`Search failed: ${res.status}`);

      const data = await res.json();
      if (!controller.signal.aborted) {
        const sidecarResults: SearchResult[] = data.results ?? [];

        // Merge instant + native + AI content + web fallbacks seamlessly
        const existingPaths = new Set(
          [...instantActions, ...nativeMatched].map((r) => r.filePath.toLowerCase()),
        );
        const middleResults: SearchResult[] = [...nativeMatched];

        for (const item of sidecarResults) {
          if (!existingPaths.has(item.filePath.toLowerCase())) {
            middleResults.push(item);
            existingPaths.add(item.filePath.toLowerCase());
          }
        }

        middleResults.sort((a, b) => b.score - a.score);
        const finalResults = [
          ...instantActions,
          ...middleResults.slice(0, 25),
          ...webFallbacks,
        ];

        setCache(cacheKey, finalResults);
        setState((s) => ({ ...s, results: finalResults, loading: false, error: null }));
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (controller.signal.aborted) return;

      const fallbackResults = [...instantActions, ...nativeMatched, ...webFallbacks];
      if (fallbackResults.length > 0) {
        setState((s) => ({ ...s, results: fallbackResults, loading: false, error: null }));
        return;
      }

      const isNetworkFail = err instanceof TypeError && String(err.message).toLowerCase().includes("fetch");
      const errorMsg = isNetworkFail
        ? "AI Engine is connecting..."
        : err instanceof Error
        ? err.message
        : "Search failed";

      setState((s) => ({
        ...s,
        loading: false,
        error: errorMsg,
      }));
    }
  }, []);

  const searchSimilar = useCallback(async (filePath: string) => {
    const currentPort = portRef.current || getSidecarPort();
    if (!currentPort) return;

    setState((s) => ({ ...s, loading: true, error: null, query: `Similar to: ${filePath.split(/[\\/]/).pop()}` }));

    try {
      const res = await fetch(`http://127.0.0.1:${currentPort}/similar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_path: filePath, limit: 10 }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) throw new Error(`Similar search failed: ${res.status}`);

      const data = await res.json();
      setState((s) => ({ ...s, results: data.results ?? [], loading: false }));
    } catch (err: unknown) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : "Similar search failed",
      }));
    }
  }, []);

  const setActiveTab = useCallback((tab: SearchTab) => {
    setState((s) => ({ ...s, activeTab: tab }));
  }, []);

  const clearSearch = useCallback(() => {
    abortRef.current?.abort();
    setState((s) => ({
      query: "",
      results: [],
      loading: false,
      error: null,
      activeTab: s.activeTab,
    }));
  }, []);

  return {
    ...state,
    search,
    searchSimilar,
    setActiveTab,
    clearSearch,
  };
}
