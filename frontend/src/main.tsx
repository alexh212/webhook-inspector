import { StrictMode, useState, useEffect, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import Landing from './Landing.tsx'
import { type Theme, getStoredTheme, applyTheme } from './utils'

function Root() {
  const [showLanding, setShowLanding] = useState(true);
  const [theme, setTheme] = useState<Theme>(getStoredTheme);

  useEffect(() => { applyTheme(theme); }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => prev === "dark" ? "light" : "dark");
  }, []);

  if (showLanding) return <Landing onEnter={() => setShowLanding(false)} theme={theme} toggleTheme={toggleTheme} />;
  return <App onBack={() => setShowLanding(true)} theme={theme} toggleTheme={toggleTheme} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
