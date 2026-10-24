import type { Config } from '../config';

export interface Mail { to: string; subject: string; text: string; html?: string }
export interface Mailer {
  send(mail: Mail): Promise<void>;
  /** Recent messages kept in memory for development and tests only (never in production). */
  outbox: Mail[];
}

type Log = { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };

/** SMTP when SMTP_URL is set; otherwise the message is printed to the log in development and dropped in production. */
/** Host:port of an SMTP URL for logging; never the credentials. */
export function describeSmtp(url: string): string {
  try { const u = new URL(url); return `${u.protocol.replace(':', '')}://${u.hostname}${u.port ? ':' + u.port : ''}`; } catch { return 'unparseable SMTP_URL'; }
}

export async function createMailer(cfg: Pick<Config, 'smtpUrl' | 'mailFrom' | 'isProd'>, log: Log): Promise<Mailer> {
  const outbox: Mail[] = [];
  if (cfg.smtpUrl) {
    const nodemailer = (await import('nodemailer')).default;
    const transport = nodemailer.createTransport(cfg.smtpUrl);
    log.info(`SMTP configured: mail is sent via ${describeSmtp(cfg.smtpUrl)} as ${cfg.mailFrom}`);
    return { outbox, async send(m) { await transport.sendMail({ from: cfg.mailFrom, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }); } };
  }
  log[cfg.isProd ? 'warn' : 'info']({}, cfg.isProd
    ? 'SMTP NOT configured (SMTP_URL unset): verification and password-reset emails will NOT be delivered. See docs/EMAIL.md'
    : 'SMTP not configured (SMTP_URL unset): emails are printed to this log (development only)');
  return {
    outbox,
    async send(m) {
      if (cfg.isProd) { log.warn({ to: m.to, subject: m.subject }, 'SMTP_URL is not configured: email was not sent'); return; }
      outbox.push(m); if (outbox.length > 100) outbox.shift();
      log.info(`\n[dev mail] to=${m.to} subject=${m.subject}\n${m.text}\n`);
    },
  };
}
