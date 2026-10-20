/** Branded account emails. Every message ships a plain-text part as well, so clients that block HTML still get the link. */
export interface ActionEmail {
  subject: string;
  heading: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  footnote?: string[];
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Table layout + inline styles: the only markup email clients render consistently. */
export function actionEmail(m: ActionEmail): { subject: string; text: string; html: string } {
  const text = [
    m.heading,
    '',
    ...m.paragraphs.flatMap((p) => [p, '']),
    ...(m.action ? [`${m.action.label}:`, m.action.url, ''] : []),
    ...(m.footnote ?? []),
  ].join('\n').trim();
  const paragraphs = m.paragraphs
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#313338;">${escapeHtml(p)}</p>`)
    .join('');
  const action = m.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 18px;"><tr><td style="border-radius:4px;background:#5865f2;">
<a href="${escapeHtml(m.action.url)}" style="display:inline-block;padding:12px 24px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;border-radius:4px;">${escapeHtml(m.action.label)}</a>
</td></tr></table>
<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:#5c5e66;">If the button does not work, copy this link into your browser:</p>
<p style="margin:0 0 14px;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${escapeHtml(m.action.url)}" style="color:#006ce7;">${escapeHtml(m.action.url)}</a></p>`
    : '';
  const footnote = (m.footnote ?? [])
    .map((f) => `<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:#5c5e66;">${escapeHtml(f)}</p>`)
    .join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(m.subject)}</title></head>
<body style="margin:0;padding:0;background:#f2f3f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f5;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="background:#5865f2;padding:20px 28px;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;letter-spacing:.2px;">Jorcord</td></tr>
<tr><td style="padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#060607;">${escapeHtml(m.heading)}</h1>
${paragraphs}
${action}
</td></tr>
${footnote ? `<tr><td style="padding:16px 28px;background:#f7f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">${footnote}</td></tr>` : ''}
</table>
<p style="max-width:520px;margin:16px auto 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.5;color:#5c5e66;text-align:center;">You are receiving this email because this address is registered on Jorcord. If it was not you, you can ignore it.</p>
</td></tr></table>
</body></html>`;
  return { subject: m.subject, text, html };
}
