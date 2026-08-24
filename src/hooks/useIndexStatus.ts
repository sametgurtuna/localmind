import { useState, useEffect, useRef, useCallback } from "react";
import { getSidecarPort, subscribeSidecarPort, setSidecarPort } from "../lib/api";

export { setSidecarPort as setIndexPort };

export interface IndexStatus {
  status: "idle" | "indexing" | "complete" | "error";
  progress: number;
  total: number;
  indexed: number;
  /** Files that were already up to date and did not need re-reading. */
  skipped: number;
  /** File currently being processed, for a sense of movement. */
  current: string;
  /** Seconds remaining, estimated from throughput so far. */
  etaSeconds: number;
  error?: string;
}

const IDLE_POLL_MS = 5000;
const ACTIVE_POLL_MS = 800;

const EMPTY: IndexStatus = {
  status: "idle",
  progress: 0,
  total: 0,
  indexed: 0,
  skipped: 0,
  current: "",
  etaSeconds: 0,
};

export function useIndexStatus(portProp?: number | null) {
  const [indexStatus, setIndexStatus] = useState<IndexStatus>(EMPTY);
  const portRef = useRef<number | null>(portProp || getSidecarPort());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (portProp) portRef.current = portProp;
  }, [portProp]);

  useEffect(() => {
    return subscribeSidecarPort((p) => {
      if (p) portRef.current = p;
    });
  }, []);

  const pollStatus = useCallback(async (): Promise<IndexStatus | null> => {
    const currentPort = portRef.current || getSidecarPort();
    if (!currentPort) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${currentPort}/index/status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const next: IndexStatus = {
        status: data.status ?? "idle",
        progress: data.progress ?? 0,
        total: data.total ?? 0,
        indexed: data.indexed ?? 0,
        skipped: data.skipped ?? 0,
        current: data.current ?? "",
        etaSeconds: data.eta_seconds ?? 0,
        error: data.error ?? undefined,
      };
      setIndexStatus(next);
      return next;
    } catch {
      return null; /* sidecar not ready */
    }
  }, []);

  useEffect(() => {
    stoppedRef.current = false;

    const tick = async () => {
      const status = await pollStatus();
      if (stoppedRef.current) return;
      const active = status?.status === "indexing";
      timerRef.current = setTimeout(tick, active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    tick();

    return () => {
      stoppedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [pollStatus]);

  const startIndexing = useCallback(
    async (folders: string[], maxFileSize?: number, excludePatterns?: string[]) => {
      const currentPort = portRef.current || getSidecarPort();
      if (!currentPort) return;
      try {
        await fetch(`http://127.0.0.1:${currentPort}/index/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folders,
            max_file_size: maxFileSize ?? 50,
            exclude_patterns: excludePatterns ?? [],
          }),
          signal: AbortSignal.timeout(5000),
        });
        pollStatus();
      } catch {
        /* noop */
      }
    },
    [pollStatus],
  );

  const rebuildIndex = useCallback(
    async (folders?: string[], maxFileSize?: number, excludePatterns?: string[]) => {
      const currentPort = portRef.current || getSidecarPort();
      if (!currentPort) return;
      try {
        await fetch(`http://127.0.0.1:${currentPort}/index/rebuild`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folders: folders ?? [],
            max_file_size: maxFileSize ?? 50,
            exclude_patterns: excludePatterns ?? [],
          }),
          signal: AbortSignal.timeout(5000),
        });
        pollStatus();
      } catch {
        /* noop */
      }
    },
    [pollStatus],
  );

  const stopIndexing = useCallback(async () => {
    const currentPort = portRef.current || getSidecarPort();
    if (!currentPort) return;
    try {
      await fetch(`http://127.0.0.1:${currentPort}/index/stop`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
      pollStatus();
    } catch {
      /* noop */
    }
  }, [pollStatus]);

  return {
    indexStatus,
    startIndexing,
    rebuildIndex,
    stopIndexing,
    pollStatus,
  };
}
