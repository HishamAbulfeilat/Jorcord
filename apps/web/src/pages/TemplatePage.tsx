import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { useData } from '@/stores/data';
import { Logo } from '@/components/ui/Logo';
import { Spinner } from '@/components/ui/primitives';
import { t } from '@/i18n';

/** /template/:code: preview a shared server template and create a server from it. */
export function TemplatePage() {
  const { code = '' } = useParams(); const nav = useNavigate(); const authed = !!useAuth((s) => s.access);
  const q = useQuery({ queryKey: ['template', code], enabled: authed, queryFn: () => api.guilds.template(code), retry: false });
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const tpl = q.data; const shown = name || (tpl ? `${tpl.sourceGuild?.name ?? tpl.name} copy` : '');
  const create = async () => {
    setBusy(true); setErr('');
    try { const g = await api.guilds.createFromTemplate(code, { name: shown.trim() }); useData.getState().putGuild(g); const ch = g.channels.find((c) => c.type === 'text'); nav(`/channels/${g.id}/${ch?.id ?? ''}`); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-[#1e1f22] bg-[radial-gradient(ellipse_at_top,rgba(88,101,242,.35),transparent_60%)] p-4" data-theme="dark">
      <main className="w-full max-w-[520px] animate-pop rounded-md bg-[#313338] p-8 text-[#f2f3f5] shadow-elev" data-testid="template-page">
        <Logo size={44} className="mx-auto mb-4" />
        {!authed ? (<><h1 className="mb-2 text-center text-2xl font-semibold">{t('Server template')}</h1><button className="h-11 w-full rounded-[3px] bg-[#5865f2] font-medium text-white hover:bg-[#4752c4]" onClick={() => nav(`/login?next=${encodeURIComponent('/template/' + code)}`)}>{t('Log in to continue')}</button></>)
          : q.isLoading ? <Spinner className="mx-auto" />
          : q.isError || !tpl ? <h1 className="text-center text-2xl font-semibold">{t('Template not found')}</h1> : (<>
            <p className="mb-1 text-center text-xs font-bold uppercase tracking-wide text-[#b5bac1]">{t('Server template')}</p>
            <h1 className="mb-1 text-center text-2xl font-semibold">{tpl.name}</h1>
            {tpl.description && <p className="mb-3 text-center text-sm text-[#b5bac1]">{tpl.description}</p>}
            <p className="mb-4 text-center text-sm text-[#b5bac1]">{t('{n} roles', { n: tpl.preview?.roles.length ?? 0 })} · {t('{n} channels', { n: tpl.preview?.channels.length ?? 0 })} · {t('Used {n} times', { n: tpl.usageCount })}</p>
            <ul className="mb-4 max-h-40 overflow-auto rounded bg-[#2b2d31] p-3 text-sm text-[#b5bac1]">{tpl.preview?.channels.map((c, i) => <li key={i} className={c.type === 'category' ? 'mt-1 font-bold uppercase text-xs' : 'ps-3'}>{c.type === 'category' ? c.name : `# ${c.name}`}</li>)}</ul>
            <label className="mb-1 block text-xs font-bold uppercase text-[#b5bac1]" htmlFor="tpl-name">{t('Server Name')}</label>
            <input id="tpl-name" className="mb-3 h-10 w-full rounded bg-[#1e1f22] px-3 outline-none" value={shown} onChange={(e) => setName(e.target.value)} maxLength={100} />
            {err && <p role="alert" className="mb-3 text-sm text-[#f23f43]">{err}</p>}
            <button disabled={busy || shown.trim().length < 2} onClick={create} className="h-11 w-full rounded-[3px] bg-[#5865f2] font-medium text-white hover:bg-[#4752c4] disabled:opacity-60">{t('Create Server')}</button>
          </>)}
      </main>
    </div>
  );
}
