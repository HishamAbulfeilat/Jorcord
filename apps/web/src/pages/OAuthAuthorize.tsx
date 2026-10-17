/** /oauth2/authorize: the page behind "add bot" links. Shows the application, the scopes, a server picker and the permission checklist. */
import { useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bot, Check, ShieldAlert } from 'lucide-react';
import { Perm, type OAuthScope, type PermName } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { Logo } from '@/components/ui/Logo';
import { Spinner } from '@/components/ui/primitives';
import { fileUrl, initials } from '@/lib/format';
import { PERMISSION_META } from '@/lib/perms';
import { needsGuild, parseAuthorizeQuery, permissionBits, permissionNames, redirectWithCode, SCOPE_INFO, validScopes } from '@/lib/oauth';
import { errorText } from '@/stores/ui';
import { t } from '@/i18n';

const metaOf = (n: PermName) => PERMISSION_META.find((m) => m.name === n);
const label = (n: PermName) => metaOf(n)?.label ?? n.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function OAuthAuthorize() {
  const loc = useLocation(); const nav = useNavigate(); const access = useAuth((s) => s.access);
  const q = useMemo(() => parseAuthorizeQuery(loc.search), [loc.search]);
  const ok = !!q.clientId && validScopes(q.scopes);
  const preview = useQuery({ queryKey: ['oauth-preview', q.clientId, q.scopes.join(' '), q.permissions], enabled: !!access && ok, retry: false, queryFn: () => api.oauth.preview({ clientId: q.clientId, scope: q.scopes.join(' '), permissions: q.permissions }) });
  const [guildId, setGuildId] = useState(q.guildId ?? ''); const [unchecked, setUnchecked] = useState<Set<PermName>>(new Set());
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [done, setDone] = useState<{ guildId?: string } | null>(null);
  if (!access) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;

  const shell = (children: React.ReactNode) => (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-[#1e1f22] bg-[radial-gradient(ellipse_at_top,rgba(88,101,242,.35),transparent_60%)] p-4" data-theme="dark" data-testid="oauth-page">
      <main className="my-auto w-full max-w-[520px] animate-pop rounded-md bg-[#313338] p-6 text-[#dbdee1] shadow-elev sm:p-8">{children}</main>
    </div>
  );
  if (!ok) return shell(<><Logo size={40} className="mx-auto mb-4" /><h1 className="mb-2 text-center text-2xl font-semibold text-[#f2f3f5]">{t('Invalid authorization link')}</h1><p className="mb-6 text-center text-[#b5bac1]">{t('The link is missing a client_id or uses an unknown scope.')}</p><Link to="/channels/@me" className="block h-11 rounded-[3px] bg-[#5865f2] text-center leading-[44px] text-white">{t('Back to Jorcord')}</Link></>);
  if (preview.isLoading) return shell(<Spinner className="mx-auto" />);
  if (preview.isError || !preview.data) return shell(<><Logo size={40} className="mx-auto mb-4" /><h1 className="mb-2 text-center text-2xl font-semibold text-[#f2f3f5]">{t('Application not found')}</h1><p className="mb-6 text-center text-[#b5bac1]">{errorText(preview.error) === 'Application not found' ? t('Check the link, and that the application lets you add it.') : errorText(preview.error)}</p><Link to="/channels/@me" className="block h-11 rounded-[3px] bg-[#5865f2] text-center leading-[44px] text-white">{t('Back to Jorcord')}</Link></>);

  const { application: app, scopes, guilds } = preview.data;
  const wantsBot = scopes.includes('bot'); const wantsGuild = needsGuild(scopes);
  const requested = permissionNames(preview.data.permissions);
  const chosenGuild = guildId || guilds[0]?.id || '';
  // you can only give the bot what you hold yourself in that server: the rest is shown, switched off and locked (the server refuses it otherwise)
  const grantable = BigInt(guilds.find((g) => g.id === chosenGuild)?.grantable ?? preview.data.permissions);
  const lockedPerms = requested.filter((n) => (grantable & Perm[n]) === 0n);
  const granted = requested.filter((n) => !unchecked.has(n) && !lockedPerms.includes(n));
  const icon = fileUrl(app.icon);

  const authorize = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.oauth.authorize({ clientId: app.id, scope: scopes.join(' '), ...(wantsBot ? { permissions: permissionBits(granted) } : {}), ...(wantsGuild ? { guildId: chosenGuild } : {}), ...(q.redirectUri ? { redirectUri: q.redirectUri } : {}), ...(q.state ? { state: q.state } : {}) });
      if (r.code && r.redirectUri) { window.location.assign(redirectWithCode(r.redirectUri, r.code, r.state)); return; }
      setDone({ guildId: r.guildId });
    } catch (e) { setErr(errorText(e)); setBusy(false); }
  };

  if (done) return shell(
    <div className="text-center" data-testid="oauth-done">
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#23a559] text-white"><Check size={34} /></div>
      <h1 className="mb-2 text-2xl font-semibold text-[#f2f3f5]">{t('Authorized')}</h1>
      <p className="mb-6 text-[#b5bac1]">{wantsBot ? t('{name} was added to your server.', { name: app.name }) : t('{name} can now use the access you granted.', { name: app.name })}</p>
      <button className="h-11 w-full rounded-[3px] bg-[#5865f2] font-medium text-white hover:bg-[#4752c4]" onClick={() => nav(done.guildId ? `/channels/${done.guildId}` : '/channels/@me')}>{done.guildId ? t('Go to server') : t('Back to Jorcord')}</button>
    </div>);

  return shell(<>
    <div className="mb-5 flex items-center justify-center gap-3">
      <span className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-[#5865f2] text-xl font-bold text-white">{icon ? <img src={icon} alt="" className="h-full w-full object-cover" /> : initials(app.name)}</span>
    </div>
    <h1 className="mb-1 text-center text-2xl font-semibold text-[#f2f3f5]" data-testid="oauth-title">{wantsBot ? t('Add {name} to a server', { name: app.name }) : t('{name} wants to access your account', { name: app.name })}</h1>
    {app.description && <p className="mb-4 text-center text-sm text-[#b5bac1]">{app.description}</p>}
    <h2 className="mb-2 mt-4 text-xs font-bold uppercase tracking-wide text-[#b5bac1]">{t('This will allow the application to')}</h2>
    <ul className="mb-4 flex flex-col gap-2" aria-label={t('Scopes')}>{scopes.map((s: OAuthScope) => <li key={s} className="flex items-start gap-2 text-sm"><Check size={16} className="mt-0.5 shrink-0 text-[#23a559]" aria-hidden /><span><span className="font-medium text-[#f2f3f5]">{SCOPE_INFO[s].label}</span><span className="block text-xs text-[#b5bac1]">{SCOPE_INFO[s].desc}</span></span></li>)}</ul>
    {wantsGuild && (<label className="mb-4 block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[#b5bac1]">{t('Add to server')}</span>
      {guilds.length ? <select aria-label={t('Add to server')} value={chosenGuild} onChange={(e) => setGuildId(e.target.value)} className="h-11 w-full rounded-[3px] bg-[#1e1f22] px-3 text-[#dbdee1]">{guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
        : <p className="rounded bg-[#1e1f22] p-3 text-sm text-[#b5bac1]">{t('You need the Manage Server permission in a server to add a bot.')}</p>}</label>)}
    {wantsBot && requested.length > 0 && (
      <fieldset className="mb-4"><legend className="mb-1.5 text-xs font-bold uppercase tracking-wide text-[#b5bac1]">{t('Bot permissions')}</legend>
        <div className="grid max-h-60 gap-1 overflow-y-auto rounded bg-[#1e1f22] p-2 sm:grid-cols-2">{requested.map((n) => <label key={n} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-[#35373c]">
          <input type="checkbox" className="h-4 w-4 accent-[#5865f2]" checked={!unchecked.has(n) && !lockedPerms.includes(n)} disabled={lockedPerms.includes(n)} title={lockedPerms.includes(n) ? t('You do not have this permission in this server, so you cannot give it to the bot.') : undefined} onChange={(e) => setUnchecked((cur) => { const s = new Set(cur); e.target.checked ? s.delete(n) : s.add(n); return s; })} />
          <span className={n === 'ADMINISTRATOR' ? 'font-semibold text-[#f23f43]' : ''}>{label(n)}</span>{n === 'ADMINISTRATOR' && <ShieldAlert size={14} className="text-[#f23f43]" aria-label={t('Dangerous')} />}</label>)}</div></fieldset>)}
    {wantsBot && !requested.length && <p className="mb-4 flex items-center gap-2 rounded bg-[#1e1f22] p-3 text-sm text-[#b5bac1]"><Bot size={16} aria-hidden />{t('The bot asks for no special permissions.')}</p>}
    {err && <p role="alert" className="mb-3 text-sm text-[#f23f43]">{err}</p>}
    <div className="flex gap-3"><Link to="/channels/@me" className="flex h-11 flex-1 items-center justify-center rounded-[3px] bg-[#4e5058] font-medium text-white hover:bg-[#6d6f78]">{t('Cancel')}</Link>
      <button disabled={busy || (wantsGuild && !chosenGuild)} onClick={authorize} className="h-11 flex-1 rounded-[3px] bg-[#5865f2] font-medium text-white hover:bg-[#4752c4] disabled:opacity-60">{t('Authorize')}</button></div>
  </>);
}
