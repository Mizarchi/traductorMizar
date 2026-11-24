import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { OverlayWindow } from './translation/OverlayWindow'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('No se encontró el nodo raíz')

const isOverlay = window.location.hash === '#overlay'

createRoot(root).render(
  <StrictMode>
    {isOverlay ? <OverlayWindow /> : <App />}
  </StrictMode>,
)
