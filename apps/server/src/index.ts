import { buildApp } from './app';

const { app, ctx } = await buildApp();
await app.listen({ host: ctx.config.host, port: ctx.config.port });
app.log.info(`Jorcord server (${ctx.db.kind}) listening on ${ctx.config.host}:${ctx.config.port}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { app.close().finally(() => process.exit(0)); });
