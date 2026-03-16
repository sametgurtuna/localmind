import { useState, useEffect, useRef, useCallback } from "react";

export interface IndexStatus {
  status: "idle" | "indexing" | "complete" | "error";
  progress: number;
  total: number;
  indexed: number;
  error?: string;
}

let sidecarPort: number | null = null;

export function setIndexPort(port: number) {
  sidecarPort = port;
}

export function useIndexStatus() {
  const [indexStatus, setIndexStatus] = useState<IndexStatus>({
    status: "idle",
    progress: 0,
    total: 0,
    indexed: 0,
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollStatus = useCallback(async () => {
    if (!sidecarPort) return;
    try {
      const res = await fetch(`http://127.0.0.1:${sidecarPort}/index/status`);
      if (res.ok) {
        const data = await res.json();
        setIndexStatus(data);
      }
    } catch {
      /* sidecar not ready */
    }
  }, []);

  const startPolling = useCallback(() => {
    if (intervalRef.current) return;
    intervalRef.current = setInterval(pollStatus, 1500);
  }, [pollStatus]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const startIndexing = useCallback(
    async (folders: string[]) => {
      if (!sidecarPort) return;
      try {
        await fetch(`http://127.0.0.1:${sidecarPort}/index/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folders }),
        });
        startPolling();
      } catch {
        /* noop */
      }
    },
    [startPolling],
  );

  const rebuildIndex = useCallback(async () => {
    if (!sidecarPort) return;
    try {
      await fetch(`http://127.0.0.1:${sidecarPort}/index/rebuild`, {
        method: "POST",
      });
      startPolling();
    } catch {
      /* noop */
    }
  }, [startPolling]);

  return {
    indexStatus,
    startIndexing,
    rebuildIndex,
    startPolling,
    stopPolling,
    pollStatus,
  };
}
