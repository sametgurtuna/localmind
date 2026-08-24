import { useCallback, useEffect, useState, useRef } from "react";
import { getSidecarPort, subscribeSidecarPort } from "../lib/api";

export interface EngineSettings {
  /** Read text out of images and scanned PDFs. Costs ~500MB RAM and seconds per image. */
  ocr: boolean;
  /** int8 quantized model: about 2x faster indexing, slightly different matches. */
  quantize: boolean;
}

export interface EngineSettingsState extends EngineSettings {
  loaded: boolean;
  /** Set when a change means the existing index no longer matches the engine. */
  rebuildRequired: boolean;
  /** Set when a change would find more content if the index were rebuilt. */
  rebuildSuggested: boolean;
}

const INITIAL: EngineSettingsState = {
  ocr: false,
  quantize: false,
  loaded: false,
  rebuildRequired: false,
  rebuildSuggested: false,
};

/**
 * Engine settings live in the sidecar, not localStorage: indexing starts before
 * any window exists, so the Python side has to own them.
 */
export function useEngineSettings(portProp?: number | null) {
  const [state, setState] = useState<EngineSettingsState>(INITIAL);
  const [activePort, setActivePort] = useState<number | null>(portProp || getSidecarPort());
  const activePortRef = useRef<number | null>(activePort);
  activePortRef.current = activePort;

  useEffect(() => {
    if (portProp) {
      setActivePort(portProp);
    }
  }, [portProp]);

  useEffect(() => {
    return subscribeSidecarPort((p) => {
      if (p) setActivePort(p);
    });
  }, []);

  useEffect(() => {
    const currentPort = activePort || getSidecarPort();
    if (!currentPort) return;
    let cancelled = false;

    fetch(`http://127.0.0.1:${currentPort}/engine/settings`, {
      signal: AbortSignal.timeout(3000),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setState((s) => ({ ...s, ocr: !!d.ocr, quantize: !!d.quantize, loaded: true }));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [activePort]);

  const update = useCallback(async (changes: Partial<EngineSettings>) => {
    const currentPort = activePortRef.current || getSidecarPort();
    if (!currentPort) return;

    // Optimistic: the toggle should respond immediately, and the request is local.
    setState((s) => ({ ...s, ...changes }));

    try {
      const res = await fetch(`http://127.0.0.1:${currentPort}/engine/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
        signal: AbortSignal.timeout(5000),
      });
      const d = await res.json();
      setState((s) => ({
        ...s,
        ocr: !!d.ocr,
        quantize: !!d.quantize,
        loaded: true,
        rebuildRequired: s.rebuildRequired || !!d.rebuild_required,
        rebuildSuggested: s.rebuildSuggested || !!d.rebuild_suggested,
      }));
    } catch {
      /* keep the optimistic value; the sidecar will be re-read on next open */
    }
  }, []);

  const clearRebuildNotice = useCallback(() => {
    setState((s) => ({ ...s, rebuildRequired: false, rebuildSuggested: false }));
  }, []);

  return { engine: state, updateEngine: update, clearRebuildNotice };
}
