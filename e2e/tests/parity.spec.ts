import { test, expect } from '@playwright/test';
import { newUser, createServer, openGuildSettings, closeSettings, rest, guildId, type User } from './helpers';

let A: User;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => { A = await newUser(browser, 'Parity'); });
test.afterAll(async () => { await A?.ctx.close(); });

test('soundboard: upload a clip in Server Settings, it is listed and can be renamed and removed', async () => {
  await createServer(A.page, 'Sound Lab');
  await openGuildSettings(A.page, 'Sound Lab', 'Soundboard');
  const dlg = A.page.getByRole('dialog', { name: 'Sound Lab' });
  await dlg.getByLabel('Sound name').fill('airhorn');
  await dlg.getByTestId('sound-file').setInputFiles({ name: 'horn.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(800, 3) });
  await expect(dlg.getByText('airhorn', { exact: true })).toBeVisible();
  const gid = await A.page.evaluate(() => location.pathname.match(/channels\/(\d+)/)![1]);
  expect((await rest(A.page, 'GET', `/guilds/${gid}/soundboard-sounds`))).toHaveLength(1);
  await dlg.getByRole('button', { name: 'Delete airhorn' }).click();
  await expect(dlg.getByText('airhorn', { exact: true })).toHaveCount(0);
  await closeSettings(A.page);
});
