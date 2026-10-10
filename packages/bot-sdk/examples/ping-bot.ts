/**
 * Minimal bot: `/ping` replies "Pong!", and a button shows component handling.
 *
 *   JORCORD_URL=http://localhost:3000 JORCORD_BOT_TOKEN=<token from the developer portal> pnpm --filter @jorcord/bot-sdk ping
 *
 * Install the bot with the OAuth2 scopes `bot applications.commands` first.
 */
import { Bot, Intents } from '../src/index';

const token = process.env.JORCORD_BOT_TOKEN;
if (!token) throw new Error('Set JORCORD_BOT_TOKEN');

const bot = new Bot({ token, baseUrl: process.env.JORCORD_URL ?? 'http://localhost:3000', intents: Intents.GUILDS | Intents.GUILD_MESSAGES });

bot.command('ping', async (ix) => {
  const started = Date.now();
  await ix.reply({ content: 'Pong!', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Again', customId: 'ping-again' }] }] });
  console.log(`ponged ${ix.userId} in ${Date.now() - started}ms`);
});
bot.component('ping-again', (ix) => ix.update({ content: `Pong again! (${new Date().toISOString()})`, components: [] }));

bot.on('reconnecting', (d) => console.warn('gateway lost, reconnecting', d));
bot.on('fatal', (e) => { console.error('fatal gateway error', e); process.exit(1); });
bot.on('error', (e) => console.error('handler error', e));

await bot.login();
await bot.registerCommands([{ name: 'ping', description: 'Check that the bot is alive' }]);
console.log(`ready as ${bot.user?.username}`);
