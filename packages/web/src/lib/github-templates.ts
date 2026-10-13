import { t } from '@/lib/i18n'
/**
 * Suggested starting points for "New project → From a template" (spec
 * 2026-09-29-create-new-project). Only a suggestion list: the field still takes any `owner/repo`
 * or GitHub URL, and the server validates whatever is sent.
 *
 * Every entry must be a GitHub TEMPLATE repository (`is_template: true`) and not archived —
 * `gh repo create --template` refuses anything else. Checked with
 * `gh api repos/<slug> --jq '[.is_template, .archived]'` on 2026-09-30; re-check when editing.
 * Preference goes to repos the framework's own organisation (or GitHub) publishes; Hono, Vite,
 * Vue and Vite+ publish none, so those entries are the most-used active community templates.
 */
export interface GithubTemplateSuggestion {
  /** `owner/repo`, exactly what the field is filled with. */
  slug: string
  label: string
  description: string
}

export const GITHUB_TEMPLATE_SUGGESTIONS: readonly GithubTemplateSuggestion[] = [
  { slug: 'github/codespaces-nextjs', get label() { return t('Next.js') }, get description() { return t('Minimal Next.js app (GitHub)') } },
  { slug: 'vercel/ai-chatbot', get label() { return t('Next.js AI chatbot') }, get description() { return t('Full-featured AI chat app (Vercel)') } },
  {
    slug: 'vercel/nextjs-postgres-nextauth-tailwindcss-template',
    get label() { return t('Next.js admin dashboard') },
    get description() { return t('Postgres, Auth.js and Tailwind (Vercel)') },
  },
  { slug: 'github/codespaces-react', get label() { return t('React + Vite') }, get description() { return t('React single-page app (GitHub)') } },
  { slug: 'antfu-collective/vitesse', get label() { return t('Vue + Vite') }, get description() { return t('Opinionated Vue starter (Vitesse)') } },
  { slug: 'nuxt-ui-templates/starter-vue', get label() { return t('Vue + Nuxt UI') }, get description() { return t('Vue + Vite with Nuxt UI (Nuxt)') } },
  { slug: 'mugnavo/cove', get label() { return t('Vite+') }, get description() { return t('TanStack Start on Vite+ (vp), Better Auth') } },
  { slug: 'w3cj/hono-open-api-starter', get label() { return t('Hono') }, get description() { return t('Type-safe JSON API with OpenAPI docs') } },
  { slug: 'github/codespaces-express', get label() { return t('Express') }, get description() { return t('Node.js web server (GitHub)') } },
  {
    slug: 'andrewmcodes/obsidian-beginner-vault-template',
    get label() { return t('Obsidian vault') },
    get description() { return t('Your own knowledge base in Markdown') },
  },
  {
    slug: 'chibat/chrome-extension-typescript-starter',
    get label() { return t('Chrome extension') },
    get description() { return t('TypeScript extension starter') },
  },
  { slug: 'actions/typescript-action', get label() { return t('GitHub Action') }, get description() { return t('TypeScript action with tests (GitHub)') } },
  { slug: 'microsoft/python-package-template', get label() { return t('Python package') }, get description() { return t('Packaging, tests and CI (Microsoft)') } },
  { slug: 'github/codespaces-flask', get label() { return t('Flask') }, get description() { return t('Python web app (GitHub)') } },
  { slug: 'github/codespaces-django', get label() { return t('Django') }, get description() { return t('Python web framework (GitHub)') } },
  { slug: 'github/codespaces-rails', get label() { return t('Ruby on Rails') }, get description() { return t('Rails app (GitHub)') } },
  { slug: 'github/codespaces-jupyter', get label() { return t('Jupyter notebooks') }, get description() { return t('Data science and ML (GitHub)') } },
]

/** Suggestions matching what is typed — label, slug or description, case-insensitive. An empty
 *  query, or one that already IS a suggestion's slug, lists everything so the user can switch. */
export function filterTemplateSuggestions(query: string): readonly GithubTemplateSuggestion[] {
  const q = query.trim().toLowerCase()
  if (q === '' || GITHUB_TEMPLATE_SUGGESTIONS.some((s) => s.slug.toLowerCase() === q)) return GITHUB_TEMPLATE_SUGGESTIONS
  return GITHUB_TEMPLATE_SUGGESTIONS.filter((s) =>
    [s.label, s.slug, s.description].some((field) => field.toLowerCase().includes(q)),
  )
}
