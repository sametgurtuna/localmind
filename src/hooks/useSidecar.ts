import { useState, useEffect, useCallback, useRef } from "react";
import { setSidecarPort } from "../hooks/useSearch";
import { setIndexPort } from "../hooks/useIndexStatus";

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
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const data = await res.json();
        const ready = data.model_ready === true;
        setState((s) => ({ ...s, connected: true, modelReady: ready, loading: false }));
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
      const { invoke } = await import("@tauri-apps/api/core");
      const port = await invoke<number>("start_sidecar");
      setSidecarPort(port);
      setIndexPort(port);
      setState((s) => ({ ...s, connected: true, port, loading: false }));

      // Poll health until model is ready
      pollRef.current = setInterval(() => pollHealth(port), 2000);
      pollHealth(port);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ connected: false, modelReady: false, port: null, loading: false, error: msg });
      startedRef.current = false;

      // Retry after 3 seconds
      setTimeout(() => {
        startedRef.current = false;
        connect();
      }, 3000);
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
