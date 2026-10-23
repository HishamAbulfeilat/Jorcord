/** Server Settings > Import & Export: back up a server's structure, or bring one over from a Jorcord export or a Discord server template. */
import { useRef, useState } from 'react';
import type { ImportReport } from '@jorcord/shared';
import { api } from '@/lib/api';
import { toast, toastError } from '@/stores/ui';
import { useData } from '@/stores/data';
import { H1, H3 } from './SettingsLayout';
import { Row, Toggle } from '@/components/ui/primitives';
import { t } from '@/i18n';

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function Report({ r }: { r: ImportReport }) {
  const c = r.created;
  return (<div data-testid="import-report" className="mt-3 rounded-lg bg-side p-3 text-sm">
    <div className="font-semibold text-header">{r.dryRun ? t('Nothing has been created yet. This is what would be added:') : t('Imported.')}</div>
    <ul className="mt-1 list-disc ps-5 text-interactive">
      <li>{t('{n} roles', { n: c.roles })}</li><li>{t('{n} categories', { n: c.categories })}</li><li>{t('{n} channels', { n: c.channels })}</li><li>{t('{n} emoji', { n: c.emoji })}</li>
    </ul>
    {r.warnings.length > 0 && (<>
      <div className="mt-2 font-semibold text-header">{t('Notes')}</div>
      <ul className="max-h-40 list-disc overflow-y-auto ps-5 text-muted">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
    </>)}
  </div>);
}

export function ServerPortTab({ guildId }: { guildId: string }) {
  const name = useData((s) => s.guilds[guildId]?.guild.name ?? 'server');
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [everyone, setEveryone] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const base = name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'server';

  const download = async (format: 'json' | 'zip') => {
    setBusy(true);
    try { save(await api.serverPort.exportFile(guildId, format), `${base}-structure.${format}`); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const choose = async (f: File | null) => {
    setFile(f); setReport(null);
    if (!f) return;
    setBusy(true);
    try { setReport(await api.serverPort.importFile(guildId, f, { dryRun: true, applyEveryone: everyone })); } catch (e) { toastError(e); setFile(null); } finally { setBusy(false); }
  };
  const run = async () => {
    if (!file) return;
    setBusy(true);
    try { const r = await api.serverPort.importFile(guildId, file, { applyEveryone: everyone }); setReport(r); setFile(null); if (input.current) input.current.value = ''; toast(t('Server structure imported'), 'success'); } catch (e) { toastError(e); } finally { setBusy(false); }
  };

  return (<div data-testid="server-port-tab">
    <H1>{t('Import & Export')}</H1>
    <H3>{t('Back up this server')}</H3>
    <p className="mb-3 text-sm text-muted">{t('Download this server\'s structure: settings, roles with their permissions, categories, channels with their permission overrides, and emoji names. Messages, members, webhooks and bots are never included. The ZIP also carries the emoji images.')}</p>
    <div className="flex flex-wrap gap-2">
      <button className="btn btn-secondary" disabled={busy} onClick={() => void download('json')}>{t('Download JSON')}</button>
      <button className="btn btn-secondary" disabled={busy} onClick={() => void download('zip')}>{t('Download ZIP with emoji')}</button>
    </div>

    <H3>{t('Bring a server over')}</H3>
    <p className="mb-3 text-sm text-muted">{t('Choose a Jorcord export (.json or .zip) or a Discord server template saved as .json. Channels, categories, roles and emoji are added to this server; nothing existing is changed or deleted, and imported roles never carry more permission than you have. Message history cannot be imported.')}</p>
    <input ref={input} type="file" accept=".json,.zip,application/json,application/zip" aria-label={t('Server file to import')} disabled={busy} onChange={(e) => void choose(e.target.files?.[0] ?? null)} className="mb-2 block text-sm" />
    <Row title={t('Also replace the @everyone permissions')} desc={t('Off by default: it changes what every member of this server can do.')}>
      <Toggle label={t('Also replace the @everyone permissions')} checked={everyone} disabled={busy} onChange={(v) => { setEveryone(v); if (file) void choose(file); }} />
    </Row>
    {report && <Report r={report} />}
    {file && report?.dryRun && <button className="btn btn-primary btn-lg mt-3" disabled={busy} onClick={() => void run()}>{t('Import into this server')}</button>}
  </div>);
}
