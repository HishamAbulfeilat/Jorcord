import { test, expect } from '@playwright/test';
import { newUser, createServer } from './helpers';

test('register and create a server', async ({ browser }) => {
  const a = await newUser(browser, 'Alice');
  await createServer(a.page, 'Test Guild');
  await a.page.screenshot({ path: '/tmp/jc/smoke.png' });
  await expect(a.page.getByRole('navigation', { name: 'Channels' })).toContainText('general');
});
