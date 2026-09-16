"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "./client-api";
import { errorMessage } from "./errors";
import type { DriverSummary } from "./models";

export function useDriverRoster() {
  const [drivers, setDrivers] = useState<DriverSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const data = await requestJson<DriverSummary[]>("/api/drivers", { signal: controller.signal });
      if (!controller.signal.aborted) setDrivers(data);
    } catch (failure: unknown) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, [refresh]);

  return { drivers, loading, error, refresh };
}
