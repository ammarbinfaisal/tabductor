"use client";

import { createStore } from "zustand/vanilla";
import { useStoreBridge } from "../lib/store.js";
import { useMountHook } from "../lib/use-mount-hook.js";

type Theme = "system" | "light" | "dark";
const themeStore = createStore<{ theme: Theme }>(() => ({ theme: "system" }));
const storageKey = "tabductor.theme";
const validTheme = (value: string | null): Theme => value === "light" || value === "dark" ? value : "system";

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    : theme;
  themeStore.setState({ theme });
}

export function ThemeSwitcher() {
  const { theme } = useStoreBridge(themeStore);
  useMountHook(() => {
    let saved: Theme = "system";
    try { saved = validTheme(localStorage.getItem(storageKey)); } catch { /* Storage is optional. */ }
    applyTheme(saved);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => { if (themeStore.getState().theme === "system") applyTheme("system"); };
    const onStorage = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) applyTheme(validTheme(event.newValue)); };
    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    return () => { media.removeEventListener("change", onSystemChange); window.removeEventListener("storage", onStorage); };
  });
  return <label className="theme-switcher">
    <span aria-hidden="true">◐</span>
    <select aria-label="Color theme" value={theme} onChange={event => {
      const next = validTheme(event.target.value);
      applyTheme(next);
      try { localStorage.setItem(storageKey, next); } catch { /* Keep the in-memory preference. */ }
    }}>
      <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
    </select>
  </label>;
}
