import { t, useLocale } from '@/lib/i18n'
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'

import { useTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import type { Theme } from '@/lib/theme'

/* A proper icon button (fixes #378 — the legacy text toggle clipped in the sidebar footer).
 * It cycles rather than opening a menu: three states, one target, no popover to hit on mobile.
 * The icon shows the *choice*, not the resolved palette — otherwise `system` would be invisible. */

/** Exported because the ⌘K palette's "Toggle theme" action must cycle exactly like this button —
 *  one order, defined once. */
export const NEXT_THEME: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' }
const ICON = { light: SunIcon, dark: MoonIcon, system: MonitorIcon } as const
const LABEL: Record<Theme, string> = { get light() { return t('light') }, get dark() { return t('dark') }, get system() { return t('system') } }

export function ThemeToggle({ className }: { className?: string }) {
  useLocale()

  const { theme, setTheme } = useTheme()
  const next = NEXT_THEME[theme]
  const Icon = ICON[theme]

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={className}
      data-slot="theme-toggle"
      data-theme-pref={theme}
      title={t('Theme: {0}', { 0: LABEL[theme] })}
      aria-label={t('Theme: {0}. Switch to {1}.', { 0: LABEL[theme], 1: LABEL[next] })}
      onClick={() => setTheme(next)}
    >
      <Icon aria-hidden="true" />
    </Button>
  )
}
