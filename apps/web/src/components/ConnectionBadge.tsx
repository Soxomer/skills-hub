import { CheckCircle2, CircleAlert, Clock3, PlugZap, WifiOff } from 'lucide-react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'

import type { ConnectionDisplayState } from '../runner-status'

interface ConnectionBadgeProps {
  state: ConnectionDisplayState
}

const icons = {
  ready: PlugZap,
  waiting: Clock3,
  connected: CheckCircle2,
  offline: WifiOff,
  expired: CircleAlert,
  revoked: CircleAlert,
}

export const ConnectionBadge = memo(function ConnectionBadge({ state }: ConnectionBadgeProps) {
  const { t } = useTranslation()
  const Icon = icons[state]
  return (
    <div className={`connection-badge connection-badge--${state}`}>
      <Icon aria-hidden="true" size={16} />
      <span>{t(`status.${state}`)}</span>
    </div>
  )
})
