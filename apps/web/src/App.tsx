import { useCallback, useMemo, useRef, useState } from 'react'
import { createBrowserClient, type ControlPlaneClient } from './api'
import { useRunnerConnection } from './useRunnerConnection'
import { connectionDisplayState } from './runner-status'
import { HarnessWorkspace } from './HarnessWorkspace'
import SkillsHub from './hub/SkillsHub'
import { LibraryProvider } from './hub/LibraryProvider'
import { HelperOnboarding } from './components/HelperOnboarding'
import './App.css'

interface AppProps { client?: ControlPlaneClient; onSignOut?: () => void }

export function App({ client: suppliedClient, onSignOut }: AppProps = {}) {
  const client = useMemo(() => suppliedClient ?? createBrowserClient(), [suppliedClient])
  const connection = useRunnerConnection(client)
  const [workspace, setWorkspace] = useState<'projects' | 'setups' | 'skills' | null>(null)
  const [setupSelection, setSetupSelection] = useState<{ setupId: string; setupRevisionId: string }>()
  const [skillsNavigationRequest, setSkillsNavigationRequest] = useState(0)
  const [onboarding, setOnboarding] = useState(() => new URLSearchParams(window.location.search).get('connect') === 'helper')
  const pendingConnection = useRef<((connected: boolean) => void) | null>(null)
  const requestConnection = useCallback(() => {
    pendingConnection.current?.(false)
    setOnboarding(true)
    return new Promise<boolean>(resolve => { pendingConnection.current = resolve })
  }, [])
  const finishConnection = useCallback((ready: boolean) => {
    setOnboarding(false)
    pendingConnection.current?.(ready)
    pendingConnection.current = null
    const url = new URL(window.location.href)
    url.searchParams.delete('connect')
    window.history.replaceState(null, '', url)
  }, [])
  const connected = Boolean(connection.runner?.lastSeenAt && connection.runner.capabilities?.capabilities.library && !connection.error && connectionDisplayState(connection.status, connection.runner) === 'connected')
  return <LibraryProvider client={client} deviceId={connection.runner?.deviceId ?? null} connected={connected} requestConnection={requestConnection}
    setupSnapshotsSupported={connection.runner?.capabilities?.capabilities.setupSnapshots === true}
    onOpenSetup={(selection) => { setSetupSelection(selection); setWorkspace('setups') }}>
    <div className="library-surface">
      <SkillsHub workspacePage={workspace} skillsNavigationRequest={skillsNavigationRequest} onOpenWorkspace={setWorkspace} onCloseWorkspace={() => setWorkspace(null)} onSignOut={onSignOut}>
        <HarnessWorkspace client={client} connection={connection} page={workspace} onPageChange={setWorkspace}
          setupSelection={setupSelection} onSkills={() => { setSkillsNavigationRequest(value => value + 1); setWorkspace(null) }} onConnect={() => void requestConnection()} />
      </SkillsHub>
    </div>
    {onboarding && <HelperOnboarding connection={connection} connected={connected} onFinish={finishConnection} />}
  </LibraryProvider>
}
