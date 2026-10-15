import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import chinese from './i18n/zh-CN.json'

// Every user-facing string reaches the UI through t(). zh-CN is the default locale, so a
// source key missing from the dictionary falls back to untranslated English in the default
// UI. This test fails on any such key, making "forgot the dictionary entry" a red build
// rather than a silent half-translated screen.
// The jsdom test environment replaces the global URL, so derive the source root from
// import.meta.url with node:url rather than `new URL('..', import.meta.url)`.
const SRC = dirname(dirname(fileURLToPath(import.meta.url)))

const T_CALL = /\bt\(\s*"((?:[^"\\]|\\.)*)"|\bt\(\s*'((?:[^'\\]|\\.)*)'/g

function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(path)
  }
  return files
}

function unescape(raw: string): string {
  // TS string-literal escapes match JSON's; the catch covers the odd `\'`.
  try { return JSON.parse(`"${raw}"`) }
  catch { return raw.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') }
}

describe('i18n dictionary coverage', () => {
  it('every t() source string has a zh-CN entry', () => {
    const dict = new Set(Object.keys(chinese))
    const missing = new Map<string, string[]>()
    for (const file of walk(SRC)) {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
      for (const match of readFileSync(file, 'utf8').matchAll(T_CALL)) {
        const key = unescape(match[1] ?? match[2]!)
        if (dict.has(key)) continue
        if (!missing.has(key)) missing.set(key, [])
        missing.get(key)!.push(file)
      }
    }
    expect([...missing.entries()].map(([key, files]) => `${JSON.stringify(key)} → ${files.join(', ')}`))
      .toEqual([])
  })
})
