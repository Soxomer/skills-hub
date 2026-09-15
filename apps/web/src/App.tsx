import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createBrowserClient } from './api'
import { useRunnerConnection } from './useRunnerConnection'
import { connectionDisplayState } from './runner-status'
import { HarnessWorkspace } from './HarnessWorkspace'
import SkillsHub from './hub/SkillsHub'
import { LibraryProvider } from './hub/LibraryProvider'
import './App.css'

export function App() {
  const { t } = useTranslation('hub')
  const client = useMemo(() => createBrowserClient(), [])
  const connection = useRunnerConnection(client)
  const [workspace, setWorkspace] = useState(false)
  const connected = Boolean(connection.runner?.lastSeenAt && connection.runner.capabilities?.capabilities.library && !connection.error && connectionDisplayState(connection.status, connection.runner) === 'connected')
  return <LibraryProvider client={client} deviceId={connection.runner?.deviceId ?? null} connected={connected}>
    <div className="library-surface" hidden={workspace}>
      <SkillsHub onOpenWorkspace={() => setWorkspace(true)} />
      {!connected && <div className="library-connection-notice"><span>{t('errors.runnerRequired')}</span><button type="button" onClick={() => setWorkspace(true)}>{t('libraryTransport.connect')}</button></div>}
    </div>
    {workspace && <div className="harness-container"><button className="library-back" type="button" onClick={() => { setWorkspace(false); void connection.refresh() }}>{t('libraryTransport.back')}</button><HarnessWorkspace client={client} connection={connection} /></div>}
  </LibraryProvider>
}
