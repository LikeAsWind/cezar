import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import type { AutomationSchedule } from '@open-mercato/cezar-api-client'

import { EditorScheduleFields } from './editor-schedule-fields'
import { setLocale } from '@/lib/i18n'

afterEach(cleanup)

function Harness({ initial }: { initial: AutomationSchedule }) {
  const [schedule, setSchedule] = useState(initial)
  return <EditorScheduleFields schedule={schedule} timeZone="Europe/Warsaw" onChange={setSchedule} />
}

const cron = () => document.querySelector('[data-slot="editor-cron"]')?.textContent

describe('EditorScheduleFields', () => {
  it('translates schedule and weekday choices without changing the schedule', () => {
    render(<Harness initial={{ type: 'weekly', day: 5, hour: 16, minute: 0 }} />)
    act(() => setLocale('zh-CN'))
    expect(screen.getByRole('button', { name: '每周' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '周五' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '每天' })).toBeTruthy()
    expect(cron()).toBe('0 16 * * 5')
    act(() => setLocale('en'))
    expect(screen.getByRole('button', { name: 'Fri' }).getAttribute('aria-pressed')).toBe('true')
    expect(cron()).toBe('0 16 * * 5')
  })

  it('shows the time row, the zone and the derived cron for a daily schedule', () => {
    render(<Harness initial={{ type: 'daily', hour: 4, minute: 0 }} />)
    expect(screen.getByRole('button', { name: 'Every day' }).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByLabelText('Hour') as HTMLInputElement).value).toBe('04')
    expect((screen.getByLabelText('Minute') as HTMLInputElement).value).toBe('00')
    expect(screen.getByText('Europe/Warsaw')).not.toBeNull()
    expect(cron()).toBe('0 4 * * *')
  })

  it('weekly adds the weekday chips and the cron follows the day', () => {
    render(<Harness initial={{ type: 'daily', hour: 7, minute: 30 }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }))
    expect(screen.getByRole('group', { name: 'Weekday' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Fri' }))
    expect(cron()).toBe('30 7 * * 5')
    fireEvent.click(screen.getByRole('button', { name: 'Sun' }))
    expect(cron()).toBe('30 7 * * 0')
  })

  it('hours replaces the time row with the every-N select, cron on the hour step', () => {
    render(<Harness initial={{ type: 'hours', every: 6 }} />)
    expect(screen.queryByLabelText('Hour')).toBeNull()
    expect(screen.getByText(/starting at 00:00/)).not.toBeNull()
    expect(cron()).toBe('0 */6 * * *')
    fireEvent.click(screen.getByRole('button', { name: 'Weekdays' }))
    expect(cron()).toBe('0 4 * * 1-5')
  })

  it('clamps a typed hour and minute', () => {
    render(<Harness initial={{ type: 'daily', hour: 4, minute: 0 }} />)
    fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '99' } })
    fireEvent.change(screen.getByLabelText('Minute'), { target: { value: '7' } })
    expect((screen.getByLabelText('Hour') as HTMLInputElement).value).toBe('23')
    expect(cron()).toBe('7 23 * * *')
  })
})
