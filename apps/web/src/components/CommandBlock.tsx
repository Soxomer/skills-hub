import { Check, Copy, Terminal } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface CommandBlockProps {
  command: string
  name: string
  disabled?: boolean
}

async function writeClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    const copied = await navigator.clipboard.writeText(value).then(
      () => true,
      () => false,
    )
    if (copied) return
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

export const CommandBlock = memo(function CommandBlock({
  command,
  name,
  disabled = false,
}: CommandBlockProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 2_000)
    return () => window.clearTimeout(timeout)
  }, [copied])

  const copy = async () => {
    await writeClipboard(command)
    setCopied(true)
  }

  return (
    <div className="command-block">
      <Terminal aria-hidden="true" size={18} />
      <code>{command}</code>
      <button
        className="copy-button"
        type="button"
        onClick={() => void copy()}
        disabled={disabled}
        aria-label={t('command.copyLabel', { name })}
      >
        {copied ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}
        <span>{copied ? t('command.copied') : t('command.copy')}</span>
      </button>
    </div>
  )
})
