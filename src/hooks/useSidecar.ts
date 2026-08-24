import { useState, useEffect, useCallback, useRef } from "react";
import { setSidecarPort as setApiPort, healthCheck } from "../lib/api";

interface SidecarState {
  connected: boolean;
  modelReady: boolean;
  port: number | null;
  loading: boolean;
  error: string | null;
}

export function useSidecar() {
  const [state, setState] = useState<SidecarState>({
    connected: false,
    modelReady: false,
    port: null,
    loading: true,
    error: null,
  });
  const startedRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollHealth = useCallback(async (port: number) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        const data = await res.json();
        const ready = data.model_ready === true;
        setState((s) => ({ ...s, connected: true, port, modelReady: ready, loading: false, error: null }));
        if (ready && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }
    } catch {
      /* server not ready yet */
    }
  }, []);

  const connect = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setState((s) => ({ ...s, loading: true, error: null }));

    try {
      let resolvedPort: number | null = null;

      try {
        const { invoke } = await import("@tauri-apps/api/core");
        resolvedPort = await invoke<number>("start_sidecar");
      } catch (ipcErr) {
        // Fallback for dev mode / browser testing: check default port 56789
        const isHealthy = await healthCheck(56789);
        if (isHealthy) {
          resolvedPort = 56789;
        } else {
          throw ipcErr;
        }
      }

      if (!resolvedPort) {
        throw new Error("Could not connect to AI engine");
      }

      setApiPort(resolvedPort);
      setState((s) => ({ ...s, connected: true, port: resolvedPort, loading: false, error: null }));

      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => pollHealth(resolvedPort!), 2000);
      pollHealth(resolvedPort);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ connected: false, modelReady: false, port: null, loading: false, error: msg });
      startedRef.current = false;

      // Retry after 4 seconds
      setTimeout(() => {
        startedRef.current = false;
        connect();
      }, 4000);
    }
  }, [pollHealth]);

  useEffect(() => {
    connect();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [connect]);

  return state;
}
