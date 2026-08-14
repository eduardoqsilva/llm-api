import type { ToolArgs, ToolHandler } from './types.js'

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo'

function formatParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  return Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  )
}

function formatOffset(date: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value
  return name ?? ''
}

export const getCurrentTimeHandler: ToolHandler = async (
  args: ToolArgs
): Promise<string> => {
  const timezone =
    typeof args.timezone === 'string' && args.timezone.trim()
      ? args.timezone.trim()
      : DEFAULT_TIMEZONE

  const now = new Date()
  const parts = formatParts(now, timezone)

  return JSON.stringify({
    iso: now.toISOString(),
    local: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${formatOffset(now, timezone)}`,
    timezone,
    timestamp: now.getTime(),
  })
}
