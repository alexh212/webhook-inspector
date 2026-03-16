import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import Landing from './Landing.tsx'

function Root() {
  const [showLanding, setShowLanding] = useState(true);
  if (showLanding) return <Landing onEnter={() => setShowLanding(false)} />;
  return <App onBack={() => setShowLanding(true)} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
