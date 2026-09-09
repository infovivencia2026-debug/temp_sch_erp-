import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AppStateProvider } from '@/hooks/useAppState'
import { ToastProvider } from '@/components/ui'
import './index.css'
// Loaded after the base so the ten interface layers win over the base tokens.
import './styles/ui-variants.css'
import './styles/ui-variants-b.css'
import './styles/ui-16-eduos.css'
import './styles/fonts.css'
import './styles/scrollbars.css'
// Baseline behaviour every interface should have, whatever its layout.
import './styles/a11y.css'
// Nudges the dense end of the type scale up a pixel.
import './styles/type-scale.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppStateProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AppStateProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
