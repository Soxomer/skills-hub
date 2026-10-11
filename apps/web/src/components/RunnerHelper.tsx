import { useTranslation } from 'react-i18next'
import { helperConnectionLink, installerFor, suggestedHelperPlatform } from '../helper-connection'
import { CommandBlock } from './CommandBlock'

interface RunnerHelperProps { command?: string }

export function RunnerHelper({ command }: RunnerHelperProps) {
  const { t } = useTranslation()
  const helperInstallerUrl = installerFor(suggestedHelperPlatform(navigator.userAgent))
  const link = command ? helperConnectionLink(command) : 'ahm://open'
  return <div className="runner-helper">
    <p>{t('helper.installHelp')}</p>
    <div className="runner-helper-actions">
      {helperInstallerUrl && <a className="secondary-button" href={helperInstallerUrl}>{t('helper.download')}</a>}
      {link && <a className="primary-button" href={link}>{t(command ? 'helper.connect' : 'helper.open')}</a>}
    </div>
    {!helperInstallerUrl && <p>{t('helper.downloadUnavailable')}</p>}
    <p>{t('helper.missing')}</p>
    {command && <>
      <p>{t('helper.expiry')}</p>
      {link && <details><summary>{t('helper.manualLink')}</summary><CommandBlock command={link} name={t('helper.manualLink')} /></details>}
    </>}
    <details><summary>{t('helper.terminal')}</summary>
      <CommandBlock command={command ?? 'ahm worker'} name={t('helper.terminal')} />
      <p>{t('helper.terminalHelp')}</p>
    </details>
  </div>
}
