import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/bricolage-grotesque/opsz.css'
import './App.css'
import App from './App.jsx'

// Theme colours only animate for user-initiated switches, never on first render
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add('theme-ready')))

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
