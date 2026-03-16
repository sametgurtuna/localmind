let port: number | null = null;

export function setSidecarPort(p: number) {
  port = p;
}

export function getSidecarPort(): number | null {
  return port;
}

export async function sidecarFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  if (!port) throw new Error("Sidecar not connected");
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sidecar error ${res.status}: ${text}`);
  }
  return res.json();
}

export async function healthCheck(): Promise<boolean> {
  try {
    await sidecarFetch("/health");
    return true;
  } catch {
    return false;
  }
}
