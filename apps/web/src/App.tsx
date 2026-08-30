import { PROTOCOL_VERSION } from '@ahm/contracts'
import { memo } from 'react'

export const App = memo(function App() {
  return <main data-protocol-version={PROTOCOL_VERSION} />
})
