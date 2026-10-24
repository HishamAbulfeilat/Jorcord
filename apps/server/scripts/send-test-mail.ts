/**
 * Sends one test email through the configured SMTP server and prints the real SMTP error if it fails.
 *
 *   SMTP_URL='smtp://user:pass@smtp-relay.brevo.com:587' MAIL_FROM='Jorcord <you@example.com>' \
 *     pnpm --filter @jorcord/server exec tsx scripts/send-test-mail.ts you@example.com
 */
import nodemailer from 'nodemailer';
import { loadConfig } from '../src/config';
import { describeSmtp } from '../src/services/mailer';
import { actionEmail } from '../src/services/emailTemplates';

const to = process.argv[2];
if (!to || !/^\S+@\S+\.\S+$/.test(to)) { console.error('usage: tsx scripts/send-test-mail.ts <recipient@example.com>'); process.exit(2); }
const cfg = loadConfig();
if (!cfg.smtpUrl) { console.error('SMTP_URL is not set. See docs/EMAIL.md for example values.'); process.exit(1); }
console.log(`Sending via ${describeSmtp(cfg.smtpUrl)} as ${cfg.mailFrom} to ${to} ...`);
const transport = nodemailer.createTransport(cfg.smtpUrl);
try {
  await transport.verify();
  const mail = actionEmail({
    subject: 'Jorcord test email', heading: 'SMTP works',
    paragraphs: ['This is a test message from your Jorcord server. If you can read it, verification and password-reset emails will be delivered.'],
    action: { label: 'Open Jorcord', url: cfg.publicUrl },
  });
  const info = await transport.sendMail({ from: cfg.mailFrom, to, ...mail });
  console.log(`OK: accepted=${JSON.stringify(info.accepted)} rejected=${JSON.stringify(info.rejected)} id=${info.messageId}`);
} catch (e: any) {
  console.error(`FAILED: ${e?.code ?? ''} ${e?.message ?? e}`);
  if (e?.responseCode) console.error(`SMTP response ${e.responseCode}: ${e.response}`);
  console.error('Check SMTP_URL (URL-encode special characters in the password), the port (587 STARTTLS / 465 smtps://) and that MAIL_FROM is an address your provider allows.');
  process.exit(1);
}
