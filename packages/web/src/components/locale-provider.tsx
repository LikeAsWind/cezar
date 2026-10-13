import { useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { putWorkspaceUiState } from '@/api/client'
import { useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { getLocale, LOCALE_STORAGE_KEY, normalizeLocale, setLocale, t, useLocale, type Locale } from '@/lib/i18n'
import { toast } from '@/components/ui/toaster'

const LanguageContext = createContext<((locale: Locale) => void) | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const uiState = useWorkspaceUiState()
  const pending = useRef(0)
  const generation = useRef(0)
  const writes = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (uiState.data !== undefined && !pending.current) setLocale(normalizeLocale(uiState.data.locale))
  }, [uiState.data])

  useEffect(() => {
    document.documentElement.lang = getLocale()
    const onStorage = (event: StorageEvent) => {
      if (event.key === LOCALE_STORAGE_KEY) setLocale(normalizeLocale(event.newValue))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const save = (next: Locale) => {
    const currentGeneration = ++generation.current
    pending.current = currentGeneration
    const previous = normalizeLocale(client.getQueryData<{ locale?: Locale }>(workspaceQueryKeys.uiState)?.locale)
    setLocale(next)
    // Keep request order as well as render order when the user switches twice quickly.
    const request = writes.current.then(() => putWorkspaceUiState({ locale: next }))
    writes.current = request.then(() => {}, () => {})
    request.then((result) => {
      if (currentGeneration !== generation.current) return
      pending.current = 0
      client.setQueryData(workspaceQueryKeys.uiState, result)
    }).catch(() => {
      if (currentGeneration !== generation.current) return
      pending.current = 0
      setLocale(previous)
      toast(t('Could not save the interface language. Please try again.'), { tone: 'danger' })
      void client.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
    })
  }

  return <LanguageContext.Provider value={save}>{children}</LanguageContext.Provider>
}

export function useLanguage() {
  const locale = useLocale()
  const save = useContext(LanguageContext)
  return { locale, setLanguage: save }
}
