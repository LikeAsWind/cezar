import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'

/**
 * Settings → Bookmarklets end-to-end against the shared dry-run environment.
 *
 * Reachability: fully reachable. The generator needs only the skills catalog (discovered
 * fresh on every GET, so the suite seeds two real project skills into this worktree's
 * `.ai/skills/` and removes them in afterAll) and the launch-key route. Nothing here
 * executes a `javascript:` URL — the page is a drag source only (spec 011 §5), so the specs
 * assert on the generated `href`, which is exactly what a user would drag to their bar.
 *
 * The `/new?skill=&auto=&key=&ref=` grammar these links bake is a PROTECTED contract
 * (BACKWARD_COMPATIBILITY.md §1): promoting the generator to its own subpage must not
 * change a single character of it, and the scoped `/p/<id>/settings/skills?skill=__bm` entry
 * point must keep working. Both are pinned below.
 *
 * Multi-project: the generated path and launch key name the selected registered project.
 * Workspace-level URLs never pick a project implicitly; the final describe pins that selection
 * UI for old flat bookmarks and pasted links.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-settings-bookmarklets-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

const skillsDir = resolve(import.meta.dirname, '../../../.ai/skills')
const ALPHA = 'e2e-bm-alpha-skill'
const BETA = 'e2e-bm-beta-skill'

let browser: AgentBrowser
let baseUrl: string
let createdSkillsDir = false
/** An explicit registered ID used to scope project pages and generated bookmarklets. */
let bootProject = ''

const linkIn = (slot: string) => `[data-slot="${slot}"] [data-slot="bm-link"]`
const hrefOf = (selector: string) =>
  decodeURIComponent(String(browser.evaluate(`document.querySelector('${selector}').getAttribute('href')`)))
/** The generated href lands imperatively after mount — never read it before it is a real URL. */
const waitForGeneratedHref = (selector: string) =>
  browser.waitForFunction(
    `(document.querySelector('${selector}')?.getAttribute('href') ?? '').startsWith('javascript:')`,
  )
/**
 * Backspace the filter empty the way a user does. `fill(selector, '')` cannot do this: it
 * assigns `.value` directly, which a controlled React input never observes — the DOM would
 * read empty while the component still filtered on the old needle.
 */
const clearFilter = () => {
  const selector = '[data-slot="bm-filter"]'
  browser.click(selector)
  const length = Number(browser.evaluate(`document.querySelector('${selector}').value.length`))
  for (let i = 0; i < length; i += 1) browser.press('Backspace')
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = ((await (await fetch(`${baseUrl}/api/v1/projects`)).json()) as { bootProject: string })
    .bootProject
  expect(bootProject).toBeTruthy()
  createdSkillsDir = !existsSync(skillsDir)
  mkdirSync(skillsDir, { recursive: true })
  writeFileSync(
    resolve(skillsDir, `${ALPHA}.md`),
    `---\nname: ${ALPHA}\ndescription: An e2e-seeded project skill\n---\n\nDo the alpha thing.\n`,
    'utf8',
  )
  writeFileSync(
    resolve(skillsDir, `${BETA}.md`),
    `---\nname: ${BETA}\ndescription: The second seeded skill\n---\n\nDo the beta thing.\n`,
    'utf8',
  )
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  // Never leave test skills in a developer's catalog.
  rmSync(resolve(skillsDir, `${ALPHA}.md`), { force: true })
  rmSync(resolve(skillsDir, `${BETA}.md`), { force: true })
  if (createdSkillsDir) rmSync(skillsDir, { recursive: true, force: true })
  browser?.close()
})

describe('settings → bookmarklets against the live dry-run server', () => {
  it('is a first-class subpage: the scoped settings URL renders the generator and marks nav current', () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/bookmarklets`)
    browser.waitForFunction(`document.querySelector('[data-slot="bookmarklet-panel"]') !== null`)

    // The point of the change (#399): reachable by URL and findable in the nav, not buried
    // behind a Skills deep link.
    const nav = '[data-slot="settings-nav"]'
    expect(browser.count(`${nav} [data-section="bookmarklets"]`)).toBe(1)
    expect(
      browser.evaluate(`document.querySelector('${nav} [aria-current="page"]').getAttribute('data-section')`),
    ).toBe('bookmarklets')
    browser.screenshot(`${artifactsDir}/settings-bookmarklets.png`)
  })

  it('the generic launcher bakes the protected /new grammar with the server real launch key', () => {
    waitForGeneratedHref(linkIn('bm-generic'))
    const generic = hrefOf(linkIn('bm-generic'))

    // The protected deep-link grammar (BACKWARD_COMPATIBILITY.md §1), baked with the real key,
    // now under this project's own URL prefix (multi-project spec, step 3.6). The whole target
    // is asserted — origin AND scope — because the generated code opens it as one absolute URL.
    expect(generic).toContain(`open('${baseUrl}/p/${bootProject}/new?'+q,'_blank')`)
    expect(generic).toMatch(/auto=0&key=[^&]+&ref=/)
    // A real key, not the empty-string fallback of a failed fetch.
    expect(generic).toMatch(/key=[^&]+&/)
    // The generic launcher carries no skill — it only prefills the form.
    expect(generic).not.toContain('skill=')
  })

  it('one launcher per catalog skill, and the filter narrows the list', () => {
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-link"]')].some((a) => a.textContent.includes('/${ALPHA}'))`,
    )
    expect(browser.count('[data-slot="bm-list"] [data-slot="bm-row"]')).toBeGreaterThanOrEqual(2)

    browser.fill('[data-slot="bm-filter"]', ALPHA)
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-row"]').length === 1`,
    )
    expect(browser.text('[data-slot="bm-list"]')).toContain(`/${ALPHA}`)
    expect(browser.text('[data-slot="bm-list"]')).not.toContain(`/${BETA}`)

    // A filter that matches nothing says so rather than rendering an empty void.
    browser.fill('[data-slot="bm-filter"]', 'zzz-no-such-skill')
    browser.waitForFunction(
      `document.querySelector('[data-slot="bm-list"]').textContent.includes('(no skills match)')`,
    )
    clearFilter()
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-link"]')].some((a) => a.textContent.includes('/${BETA}'))`,
    )
  })

  it('one-click launch arms the per-skill launchers but never the generic one', () => {
    const skillLink = `[data-slot="bm-list"] [data-slot="bm-row"] [data-slot="bm-link"]`
    waitForGeneratedHref(skillLink)
    expect(hrefOf(skillLink)).toContain('auto=0')

    browser.click('[data-slot="bm-auto"]')
    browser.waitForFunction(
      `decodeURIComponent(document.querySelector('${skillLink}').getAttribute('href')).includes('auto=1')`,
    )
    expect(hrefOf(skillLink)).toContain('auto=1')

    // The generic launcher forces auto off no matter what the checkbox says: it has no skill
    // to run, so auto-submitting it would arm nothing.
    expect(hrefOf(linkIn('bm-generic'))).toContain('auto=0')
  })

  it('the scoped /settings/skills?skill=__bm entry point opens the same generator', () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/skills?skill=__bm`)
    browser.waitForFunction(`document.querySelector('[data-slot="bookmarklet-panel"]') !== null`)
    waitForGeneratedHref(linkIn('bm-generic'))
    expect(hrefOf(linkIn('bm-generic'))).toContain(`/p/${bootProject}/new?'+q`)
  })
})

/**
 * The compatibility half of step 3.6. Adding the `/p/<id>` prefix is only safe because every
 * project-specific bookmarklets open the explicitly named project, while a flat URL leaves
 * project choice to the user. These checks exercise that distinction in a real browser.
 */
describe('flat project URLs require explicit project selection', () => {
  it("the generated key is the server's own — the target scope will accept it", async () => {
    const scoped = (await (
      await fetch(`${baseUrl}/api/v1/p/${encodeURIComponent(bootProject)}/launch-key`)
    ).json()) as { key: string }
    expect(scoped.key).toBeTruthy()

    browser.goto(`${baseUrl}/p/${encodeURIComponent(bootProject)}/settings/bookmarklets`)
    waitForGeneratedHref(linkIn('bm-generic'))
    // The URL names the project AND carries that project's `.ai/cezar/launch-key` secret.
    expect(hrefOf(linkIn('bm-generic'))).toContain(`/p/${bootProject}/new?'+q`)
    expect(hrefOf(linkIn('bm-generic'))).toContain(`key=${scoped.key}&ref=`)
  })

  it('a flat /new?… bookmarklet asks the user to choose rather than guessing a project', () => {
    browser.goto(`${baseUrl}/new?skill=${ALPHA}&auto=0&key=stale-key&ref=legacy%20bookmarklet%20task`)
    browser.waitForFunction(`document.querySelector('[data-slot="registered-projects"]') !== null`)
    expect(browser.count('[data-route="new"] [data-slot="composer"]')).toBe(0)
    expect(browser.url()).toBe(
      `${baseUrl}/new?skill=${ALPHA}&auto=0&key=stale-key&ref=legacy%20bookmarklet%20task`,
    )
    expect(browser.count(`[data-slot="registered-projects"] a[href="/p/${bootProject}/"]`)).toBe(1)
  })

  it('a flat /settings/bookmarklets URL offers a project without opening its settings implicitly', () => {
    browser.goto(`${baseUrl}/settings/bookmarklets`)
    browser.waitForFunction(`document.querySelector('[data-slot="registered-projects"]') !== null`)
    expect(browser.count('[data-slot="bookmarklet-panel"]')).toBe(0)
    expect(browser.url()).toBe(`${baseUrl}/settings/bookmarklets`)
    expect(browser.count(`[data-slot="registered-projects"] a[href="/p/${bootProject}/"]`)).toBe(1)
  })
})
