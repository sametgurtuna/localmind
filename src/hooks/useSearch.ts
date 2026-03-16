import { useState, useCallback, useRef } from "react";

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
}

export type SearchTab = "files" | "semantic" | "apps";

interface SearchState {
  query: string;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  activeTab: SearchTab;
}

const API_BASE = "http://127.0.0.1";
let sidecarPort: number | null = null;

export function setSidecarPort(port: number) {
  sidecarPort = port;
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
  if (searchCache.size > 100) {
    const oldest = searchCache.keys().next().value;
    if (oldest) searchCache.delete(oldest);
  }
  searchCache.set(key, { results, ts: Date.now() });
}

export function useSearch() {
  const [state, setState] = useState<SearchState>({
    query: "",
    results: [],
    loading: false,
    error: null,
    activeTab: "semantic",
  });
  const abortRef = useRef<AbortController | null>(null);
  const activeTabRef = useRef(state.activeTab);
  activeTabRef.current = state.activeTab;

  const search = useCallback(async (query: string, tab?: SearchTab) => {
    if (!query.trim()) {
      setState((s) => ({ ...s, query, results: [], loading: false, error: null }));
      return;
    }

    const searchTab = tab ?? activeTabRef.current;
    const cacheKey = `${searchTab}:${query.trim().toLowerCase()}`;

    const cached = getCached(cacheKey);
    if (cached) {
      setState((s) => ({ ...s, query, results: cached, loading: false, error: null }));
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((s) => ({ ...s, query, loading: true, error: null }));

    if (!sidecarPort) {
      setState((s) => ({ ...s, loading: false, error: null, results: [] }));
      return;
    }

    try {
      const res = await fetch(`${API_BASE}:${sidecarPort}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), type: searchTab, limit: 15 }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Search failed: ${res.status}`);

      const data = await res.json();
      if (!controller.signal.aborted) {
        const results = data.results ?? [];
        setCache(cacheKey, results);
        setState((s) => ({ ...s, results, loading: false }));
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!controller.signal.aborted) {
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : "Search failed",
        }));
      }
    }
  }, []);

  const searchSimilar = useCallback(async (filePath: string) => {
    if (!sidecarPort) return;

    setState((s) => ({ ...s, loading: true, error: null, query: `Similar to: ${filePath.split(/[\\/]/).pop()}` }));

    try {
      const res = await fetch(`${API_BASE}:${sidecarPort}/similar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_path: filePath, limit: 10 }),
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
