import { beforeEach } from 'vitest'
import { configure } from '@testing-library/react'
import { setLocale } from '@/lib/i18n'

// Existing fixtures describe the English UI. Locale tests explicitly select Chinese.
setLocale('en')
// Lazy route chunks can take longer than the library's 1 s default on Windows.
configure({ asyncUtilTimeout: 5000 })
beforeEach(() => setLocale('en'))
