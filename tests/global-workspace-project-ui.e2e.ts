import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

/**
 * The project-neutral global workspace home (Task 7) and the single-tab remount isolation that
 * stands in for two-tab isolation at the browser level.
 *
 * The e2e harness boots `CEZ_DRY_RUN=1` with `CEZ_HOME=.e2e/cez-home` and NO project registered —
 * a genuine zero-project workspace. `browser` is single-tab (no `newContext`/`newPage`), so this
 * spec asserts what that harness honestly supports: the fixed home renders its empty state, and
 * opening it never redirects. Two-tab isolation itself is pinned by the unit suites
 * (`cross-project-task-navigation.test.tsx`, `app-shell.test.tsx`); this is the browser-level proxy.
 */

test('the global workspace home renders its zero-project state without redirecting', async ({ app, screen, browser }) => {
  await app.open('/');

  // The empty-workspace hero: the "Workspace" heading and the disabled New-task CTA are what the
  // zero-project state shows, and the one action is registering a project.
  await expect(screen.getByRole('heading', { name: 'Workspace' })).toBeVisible();
  await expect(screen.getByRole('button', { name: 'New task' })).toBeDisabled();
  await expect(screen.getByRole('link', { name: 'Register project' })).toHaveAttribute(
    'href',
    '/projects?register=1',
  );

  // `/` is a fixed home, never a redirect (task 5, step 3): opening it lands at the home, and
  // opening it again stays there. In a single-tab harness this is the browser-level proof that a
  // second tab pointed at the same URL would mount the same fixed surface rather than being
  // bounced to a boot project.
  await app.open('/');
  await expect(browser).toHaveURL(/\/$/);
  await expect(screen.getByRole('heading', { name: 'Workspace' })).toBeVisible();
});
