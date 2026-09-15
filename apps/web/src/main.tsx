import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { HostedAccess } from './HostedAccess'
import './i18n'
import './index.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Missing web application root element')
}

createRoot(root).render(
  <StrictMode>
    <HostedAccess />
  </StrictMode>,
)
