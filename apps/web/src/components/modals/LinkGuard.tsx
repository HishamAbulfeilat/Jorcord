/** Confirmation dialogs for external links and risky file types (see lib/links.ts). */
import { useState } from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { Modal } from '@/components/ui/primitives';
import { hasDeceptiveExtension, linkHost, trustDomain } from '@/lib/links';
import { t } from '@/i18n';

const open = (url: string, download = false, filename?: string) => {
  if (download) { const a = document.createElement('a'); a.href = url; a.download = filename ?? ''; a.rel = 'noopener noreferrer'; document.body.appendChild(a); a.click(); a.remove(); return; }
  window.open(url, '_blank', 'noopener,noreferrer');
};

export function ExternalLinkModal({ url, close }: { url: string; close: () => void }) {
  const host = linkHost(url) ?? url; const [trust, setTrust] = useState(false);
  const go = () => { if (trust) trustDomain(host); open(url); close(); };
  return (
    <Modal title={t('Leaving Jorcord')} width={440} onClose={close}
      footer={<><button className="btn btn-link" onClick={close}>{t('Cancel')}</button><button className="btn btn-primary btn-lg sm:ms-auto" onClick={go} data-testid="link-continue"><ExternalLink size={16} />{t('Visit site')}</button></>}>
      <p className="mb-2 text-center text-normal">{t('This link takes you to an external site. Only continue if you trust it.')}</p>
      <div className="mb-3 break-all rounded bg-side p-2 text-sm text-header" data-testid="link-url">{url}</div>
      <label className="flex items-center gap-2 text-sm text-normal"><input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} data-testid="link-trust" />{t('Trust {host} and do not ask again', { host })}</label>
    </Modal>
  );
}

export function RiskyFileModal({ url, filename, download, close }: { url: string; filename: string; download: boolean; close: () => void }) {
  const deceptive = hasDeceptiveExtension(filename);
  return (
    <Modal title={t('Potentially unsafe file')} width={440} onClose={close}
      footer={<><button className="btn btn-link" onClick={close}>{t('Cancel')}</button><button className="btn btn-danger btn-lg sm:ms-auto" onClick={() => { open(url, download, filename); close(); }} data-testid="file-continue">{download ? t('Download anyway') : t('Open anyway')}</button></>}>
      <div className="mb-2 flex justify-center text-warn"><AlertTriangle size={32} /></div>
      <p className="mb-2 text-center text-normal">{t('This type of file can run code or install software on your device. Only open it if you know and trust the sender.')}</p>
      {deceptive && <p className="mb-2 text-center text-sm font-semibold text-danger">{t('The name looks like a document but the file is a program.')}</p>}
      <div className="break-all rounded bg-side p-2 text-sm text-header" data-testid="file-name">{filename}</div>
    </Modal>
  );
}
