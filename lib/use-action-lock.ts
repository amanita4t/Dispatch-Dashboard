"use client";

import { useCallback, useRef, useState } from "react";

export function useActionLock() {
  const active = useRef(false);
  const [pending, setPending] = useState<string | null>(null);

  const begin = useCallback((action: string) => {
    if (active.current) return false;
    active.current = true;
    setPending(action);
    return true;
  }, []);

  const finish = useCallback(() => {
    active.current = false;
    setPending(null);
  }, []);

  return { pending, begin, finish };
}
