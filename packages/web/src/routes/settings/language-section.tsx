import { useLanguage } from '@/components/locale-provider'
import { t, type Locale } from '@/lib/i18n'

export function LanguageSection() {
  const { locale, setLanguage } = useLanguage()
  if (!setLanguage) return null
  return (
    <section className="flex flex-col gap-2" data-slot="appearance-language">
      <div>
        <label htmlFor="interface-language" className="text-sm font-semibold text-foreground">{t('Interface language')}</label>
        <p className="text-[13px] text-muted-foreground">{t('Saved for this workspace. New installations use Simplified Chinese.')}</p>
      </div>
      <select id="interface-language" value={locale}
        onChange={event => setLanguage(event.currentTarget.value as Locale)}
        className="h-9 w-fit rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </select>
    </section>
  )
}
