import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getSidecarPort, subscribeSidecarPort, setSidecarPort } from "../lib/api";
import { parseConverterQuery, initRatesUpdater } from "../lib/converter";
import { parseDirectUrl, parseWebShortcutQuery, getWebSearchFallbacks } from "../lib/webSearch";
import { parseMathQuery, parseSystemAction } from "../lib/quickActions";

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
  category?: "calc" | "converter" | "web" | "app" | "repo" | "file" | "content" | "action";
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

const appIconCache = new Map<string, string>();

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
  const aiDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef<number>(0);
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
    const currentSeq = ++searchSeqRef.current;

    if (!q) {
      if (aiDebounceTimerRef.current) {
        clearTimeout(aiDebounceTimerRef.current);
        aiDebounceTimerRef.current = null;
      }
      abortRef.current?.abort();
      setState((s) => ({ ...s, query, results: [], loading: false, error: null }));
      return;
    }

    const searchTab = tab ?? activeTabRef.current;
    const cacheKey = `${searchTab}:${q.toLowerCase()}`;

    const cached = getCached(cacheKey);
    if (cached) {
      if (aiDebounceTimerRef.current) {
        clearTimeout(aiDebounceTimerRef.current);
        aiDebounceTimerRef.current = null;
      }
      abortRef.current?.abort();
      setState((s) => ({ ...s, query, results: cached, loading: false, error: null }));
      return;
    }

    // Cancel any pending AI request or debounce timer
    if (aiDebounceTimerRef.current) {
      clearTimeout(aiDebounceTimerRef.current);
      aiDebounceTimerRef.current = null;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // --- Tier 0: Instant Local Evaluators (0ms) ---
    const instantActions: SearchResult[] = [];
    if (searchTab === "all" || searchTab === "actions") {
      const mathRes = parseMathQuery(q);
      if (mathRes) instantActions.push(mathRes);

      const sysActions = parseSystemAction(q);
      if (sysActions.length > 0) instantActions.push(...sysActions);

      const convRes = parseConverterQuery(q);
      if (convRes) instantActions.push(convRes);

      const directUrlRes = parseDirectUrl(q);
      if (directUrlRes) instantActions.push(directUrlRes);

      const webShortcutRes = parseWebShortcutQuery(q);
      if (webShortcutRes) instantActions.push(webShortcutRes);
    }

    const webFallbacks = (searchTab === "all" || searchTab === "actions") ? getWebSearchFallbacks(q) : [];

    let nativeMatched: SearchResult[] = [];

    // --- Tier 1: Instant Native Rust MFT & App Search (< 0.5ms) ---
    try {
      const nativeResults = await invoke<SearchResult[]>("fast_search_native", {
        query: q,
        filterType: searchTab,
        limit: 25,
      });

      if (currentSeq !== searchSeqRef.current || controller.signal.aborted) {
        return;
      }

      if (nativeResults) {
        // Reuse and populate in-memory Icon Cache to prevent IPC/memory bloat
        for (const item of nativeResults) {
          if (item.icon) {
            appIconCache.set(item.filePath, item.icon);
          } else if (appIconCache.has(item.filePath)) {
            item.icon = appIconCache.get(item.filePath);
          }
        }
        nativeMatched = nativeResults;
      }
    } catch {
      /* Browser fallback if running outside Tauri */
    }

    if (currentSeq !== searchSeqRef.current || controller.signal.aborted) {
      return;
    }

    const seen = new Set<string>();
    const instantMerged: SearchResult[] = [];
    for (const item of [...instantActions, ...nativeMatched, ...webFallbacks]) {
      const key = `${item.category || ""}:${item.fileName}:${item.filePath}`;
      if (!seen.has(key)) {
        seen.add(key);
        instantMerged.push(item);
      }
    }

    // Check whether heavy Python AI semantic search is actually needed
    const qLower = q.toLowerCase();
    const isRepoQuery =
      qLower.startsWith("repo:") ||
      qLower.startsWith("repo ") ||
      qLower === "repo" ||
      qLower.startsWith("git:") ||
      qLower.startsWith("git ") ||
      qLower === "git" ||
      qLower.startsWith("project:") ||
      qLower.startsWith("project ") ||
      qLower === "project";

    const topMatch = nativeMatched[0];
    const topCategory = topMatch?.category;
    const topScore = topMatch?.score ?? (instantActions.length > 0 ? 1.0 : 0);

    const isAppOrActionTab = searchTab === "apps" || searchTab === "actions" || searchTab === "files";
    const hasInstantAction = instantActions.length > 0;
    const hasHighConfidenceApp = (topCategory === "app" || topCategory === "repo" || topCategory === "action") && topScore >= 0.85;
    const hasExactFileMatch = topScore >= 0.95 && q.length <= 4;
    const isPrefixFilter = qLower.startsWith("*.") || qLower.startsWith("ext:") || qLower.startsWith("dir:");
    const isShortGenericQuery = q.length < 3 && searchTab !== "content";

    const shouldSkipAiSearch =
      searchTab !== "content" &&
      (isAppOrActionTab ||
        hasInstantAction ||
        isRepoQuery ||
        hasHighConfidenceApp ||
        hasExactFileMatch ||
        isPrefixFilter ||
        isShortGenericQuery);

    // Show native + instant results immediately
    setState((s) => ({
      ...s,
      query,
      results: instantMerged,
      loading: !shouldSkipAiSearch && (searchTab === "content" || (searchTab === "all" && q.length >= 3)),
      error: null,
    }));

    if (shouldSkipAiSearch) {
      setCache(cacheKey, instantMerged);
      setState((s) => ({ ...s, loading: false }));
      return;
    }

    // --- Tier 2: Debounced AI Semantic Content Search (~180ms) ---
    const currentPort = portRef.current || getSidecarPort();
    if (!currentPort) {
      setCache(cacheKey, instantMerged);
      setState((s) => ({ ...s, loading: false }));
      return;
    }

    // Debounce the AI search request so fast typing doesn't spam ONNX embeddings
    aiDebounceTimerRef.current = setTimeout(async () => {
      if (controller.signal.aborted) return;

      try {
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(`http://127.0.0.1:${currentPort}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: q, type: searchTab, limit: 25 }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`Search failed: ${res.status}`);

        const data = await res.json();
        if (!controller.signal.aborted && currentSeq === searchSeqRef.current) {
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

        // On error, keep the instant/native results visible
        setCache(cacheKey, instantMerged);
        setState((s) => ({ ...s, results: instantMerged, loading: false }));
      }
    }, 180);
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
    if (aiDebounceTimerRef.current) {
      clearTimeout(aiDebounceTimerRef.current);
      aiDebounceTimerRef.current = null;
    }
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
