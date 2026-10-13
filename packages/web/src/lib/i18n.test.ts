import { afterEach, describe, expect, it } from 'vitest'
import { dateTimeFormat, getLocale, normalizeLocale, readStoredLocale, setLocale, t } from './i18n'

afterEach(() => {
  localStorage.clear()
  setLocale('en')
})

describe('interface language', () => {
  it.each([
    ['auto', '自动'],
    ['Export', '导出'],
    ['Model', '模型'],
    ['Most used', '最常用'],
    ['Project skills', '项目技能'],
    ['Start task', '启动任务'],
    ['One run', '运行一次'],
    ['Session closed — Continue to reopen.', '会话已关闭——点击“继续”重新打开。'],
    ['Tasks connected', '任务连接正常'],
  ])('uses software terminology for %s', (source, translated) => {
    setLocale('zh-CN')
    expect(t(source)).toBe(translated)
    setLocale('en')
    expect(t(source)).toBe(source)
  })

  it('opens a new installation in Chinese, including invalid preferences', () => {
    localStorage.clear()
    expect(readStoredLocale()).toBe('zh-CN')
    expect(normalizeLocale('fr')).toBe('zh-CN')
    setLocale(readStoredLocale())
    expect(t('Settings')).toBe('设置')
  })

  it('switches existing messages and saves the choice for the next visit', () => {
    setLocale('zh-CN')
    expect(t('Workflows')).toBe('工作流')
    setLocale('en')
    expect(t('Workflows')).toBe('Workflows')
    expect(getLocale()).toBe('en')
    expect(readStoredLocale()).toBe('en')
  })

  it('interpolates values without translating user content', () => {
    setLocale('zh-CN')
    expect(t('Delete {0}?', { 0: 'Settings' })).toBe('删除 Settings？')
    expect(t('An unknown server response')).toBe('An unknown server response')
    expect(t('constructor')).toBe('constructor')
  })

  it('formats dates in the selected language after a live switch', () => {
    const at = new Date(2026, 9, 13)
    setLocale('en')
    expect(dateTimeFormat({ month: 'long' }).format(at)).toBe('October')
    setLocale('zh-CN')
    expect(dateTimeFormat({ month: 'long' }).format(at)).toBe('十月')
  })
})
