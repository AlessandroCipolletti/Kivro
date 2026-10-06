"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";

export function useResource<T>(path: string | null, pollMs = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(Boolean(path));
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => { window.addEventListener("kivro-session", refresh); return () => window.removeEventListener("kivro-session", refresh); }, [refresh]);
  useEffect(() => {
    if (!path) { setData(undefined); setLoading(false); setError(undefined); return; }
    const controller = new AbortController();
    let active = true;
    let timeout: ReturnType<typeof setTimeout>;
    setData(undefined);
    setLoading(true);
    async function fetchData() {
      try {
        const next = await api<T>(path!, { signal: controller.signal });
        if (active) { setData(next); setError(undefined); }
      } catch (error) {
        if (active && !controller.signal.aborted) setError(errorMessage(error));
      } finally {
        if (active) {
          setLoading(false);
          if (pollMs) timeout = setTimeout(fetchData, pollMs);
        }
      }
    }
    void fetchData();
    return () => { active = false; controller.abort(); clearTimeout(timeout); };
  }, [path, revision, pollMs]);
  return { data, setData, error, loading, refresh };
}

export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (busy.current) return;
    busy.current = true;
    setPending(true); setError(undefined);
    try { return await action(); } catch (error) { setError(errorMessage(error)); }
    finally { busy.current = false; setPending(false); }
  }
  return { run, pending, error, setError };
}
