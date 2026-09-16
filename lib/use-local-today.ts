"use client";

import { useEffect, useState } from "react";
import { todayLocal } from "./dates";

export function useLocalToday(): string {
  const [today, setToday] = useState("");

  useEffect(() => {
    const update = () => setToday(todayLocal());
    update();
    const interval = window.setInterval(update, 60_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return today;
}
