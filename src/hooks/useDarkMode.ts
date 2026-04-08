import { useState, useEffect } from "react";

const STORAGE_KEY = "vf_dark_mode";

export function useDarkMode() {
  const [isDark, setIsDark] = useState<boolean>(() => {
    return localStorage.getItem(STORAGE_KEY) === "true";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [isDark]);

  const toggle = () => {
    setIsDark((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  };

  return { isDark, toggle };
}
