import { StrictMode, useState, useEffect, useCallback } from 'react'
import { createRoot } from 'react-dom/client'

import './index.css'
import App from './App.tsx'
import { type Theme, getStoredTheme, applyTheme } from './utils'

export function Root() {
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const [hasManualTheme, setHasManualTheme] = useState<boolean>(() => {
    const stored = localStorage.getItem("wi_theme");
    return stored === "dark" || stored === "light";
  });

  useEffect(() => { applyTheme(theme); }, [theme]);

  useEffect(() => {
    if (hasManualTheme) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setTheme(e.matches ? "dark" : "light");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [hasManualTheme]);

  const toggleTheme = useCallback(() => {
    setHasManualTheme(true);
    setTheme(prev => {
      const next = prev === "dark" ? "light" : "dark";
      localStorage.setItem("wi_theme", next);
      return next;
    });
  }, []);

  return <App theme={theme} toggleTheme={toggleTheme} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
