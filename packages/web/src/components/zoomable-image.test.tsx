import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ZoomableImage } from './zoomable-image'
import { setLocale } from '@/lib/i18n'

afterEach(cleanup)

describe('ZoomableImage', () => {
  it('translates the preview label without translating the attachment description', () => {
    render(<ZoomableImage src="/img.png" alt="Project skills" />)
    fireEvent.click(screen.getByRole('img'))
    act(() => setLocale('zh-CN'))
    expect(screen.getByRole('dialog', { name: '图片预览' })).toBeTruthy()
    expect(screen.getAllByRole('img').every((image) => image.getAttribute('alt') === 'Project skills')).toBe(true)
    act(() => setLocale('en'))
    expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeTruthy()
  })

  it('opens a lightbox on click and closes on backdrop click', () => {
    render(<ZoomableImage src="/api/v1/runs/r1/images/shot.png" alt="shot" data-slot="thread-image" />)
    // The thumbnail forwards data-slot and is zoom-in cursored.
    const thumb = document.querySelector('[data-slot="thread-image"]') as HTMLImageElement
    expect(thumb).toBeTruthy()
    expect(document.querySelector('[data-slot="image-lightbox"]')).toBeNull()

    fireEvent.click(thumb)
    const lightbox = document.querySelector('[data-slot="image-lightbox"]')
    expect(lightbox).not.toBeNull()

    fireEvent.click(lightbox as HTMLElement)
    expect(document.querySelector('[data-slot="image-lightbox"]')).toBeNull()
  })

  it('closes on Escape', () => {
    render(<ZoomableImage src="/img.png" alt="pic" />)
    fireEvent.click(screen.getByRole('img'))
    expect(document.querySelector('[data-slot="image-lightbox"]')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('[data-slot="image-lightbox"]')).toBeNull()
  })
})
