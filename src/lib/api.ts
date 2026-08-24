const DEFAULT_PORT = 56789;
let port: number | null = null;
const listeners = new Set<(p: number | null) => void>();

export function setSidecarPort(p: number | null) {
  port = p;
  listeners.forEach((fn) => {
    try {
      fn(p);
    } catch {
      /* noop */
    }
  });
}

export function getSidecarPort(): number | null {
  return port;
}

export function subscribeSidecarPort(fn: (p: number | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getApiBaseUrl(): string {
  const p = port || DEFAULT_PORT;
  return `http://127.0.0.1:${p}`;
}

export async function sidecarFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const targetPort = port || DEFAULT_PORT;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(`http://127.0.0.1:${targetPort}${path}`, {
      ...options,
      signal: options?.signal || controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Sidecar error ${res.status}: ${text}`);
    }
    return res.json();
  } catch (err: unknown) {
    clearTimeout(timeout);
    if (err instanceof Error) {
      if (err.name === "AbortError") {
        throw new Error("Request timed out");
      }
      throw err;
    }
    throw new Error("Connection failed");
  }
}

export async function healthCheck(customPort?: number): Promise<boolean> {
  const p = customPort || port || DEFAULT_PORT;
  try {
    const res = await fetch(`http://127.0.0.1:${p}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
