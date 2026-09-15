/** Display a runner location without exposing the transport handle. */
export function locationLabel(value: string): string {
  if (!value.startsWith('folder-')) return value
  const name = value.slice(value.indexOf('/') + 1)
  try { return decodeURIComponent(name) } catch { return name }
}
