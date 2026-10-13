import { useSyncExternalStore } from 'react'
import chinese from './i18n/zh-CN.json'

export type Locale = 'zh-CN' | 'en'
export const LOCALE_STORAGE_KEY = 'cez-locale'
export const DEFAULT_LOCALE: Locale = 'zh-CN'

export function normalizeLocale(value: unknown): Locale {
  return value === 'en' ? 'en' : DEFAULT_LOCALE
}

export function readStoredLocale(): Locale {
  try { return normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY)) }
  catch { return DEFAULT_LOCALE }
}

let locale = readStoredLocale()
const listeners = new Set<() => void>()

export function getLocale(): Locale { return locale }

export function setLocale(next: Locale): void {
  locale = normalizeLocale(next)
  try { localStorage.setItem(LOCALE_STORAGE_KEY, locale) } catch { /* Storage is optional. */ }
  if (typeof document !== 'undefined') document.documentElement.lang = locale
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Components subscribe rather than remount: changing language must preserve form drafts. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, () => DEFAULT_LOCALE)
}

const catalog: Readonly<Record<string, string>> = chinese

/** English source keys are the fallback; values stay opaque (user text is never translated). */
export function t(source: string, values?: Record<string, unknown>): string {
  const message = locale === 'zh-CN' && Object.hasOwn(catalog, source) ? catalog[source]! : source
  return values ? message.replace(/\{(\d+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : placeholder) : message
}

const dates = new Map<string, Intl.DateTimeFormat>()
const numbers = new Map<string, Intl.NumberFormat>()

export function dateTimeFormat(options: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
  const key = `${locale}:${JSON.stringify(options)}`
  let formatter = dates.get(key)
  if (!formatter) { formatter = new Intl.DateTimeFormat(locale, options); dates.set(key, formatter) }
  return formatter
}

export function numberFormat(options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${locale}:${JSON.stringify(options)}`
  let formatter = numbers.get(key)
  if (!formatter) { formatter = new Intl.NumberFormat(locale, options); numbers.set(key, formatter) }
  return formatter
}
