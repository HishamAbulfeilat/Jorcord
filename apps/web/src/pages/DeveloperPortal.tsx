/** Developer portal: create applications, reset the bot token, build OAuth2 invite URLs and review slash commands. Lives at /developers. */
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, Code2, Copy, KeyRound, Link2, Plus, Settings as Cog, Terminal, Trash2, TriangleAlert } from 'lucide-react';
import { DIRECTORY_CATEGORIES, OAuthScopes } from '@jorcord/shared';
import type { Application, DirectoryCategory, OAuthScope, PermName } from '@jorcord/shared';
import { create } from 'zustand';
import { api } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { useUI, toast, toastError } from '@/stores/ui';
import { Logo } from '@/components/ui/Logo';
import { Avatar } from '@/components/ui/Avatar';
import { Empty, Field, Row, Spinner, Toggle, Modal } from '@/components/ui/primitives';
import { IconPicker } from '@/components/modals/ModalHost';
import { cx, copyText, fileUrl, initials } from '@/lib/format';
import { buildAuthorizeUrl, permissionBits, permissionNames, SCOPE_INFO } from '@/lib/oauth';
import { PERMISSION_META } from '@/lib/perms';
import { publicOrigin } from '@/lib/server';
import { variantsOf } from '@/lib/commands';
import { Perm } from '@jorcord/shared';
import { t } from '@/i18n';

/** Secrets only exist in the create / reset responses. They live in memory for this tab only and vanish on reload. */
interface SecretsState { token: Record<string, string>; secret: Record<string, string>; setToken(id: string, v: string | null): void; setSecret(id: string, v: string | null): void }
export const useSecrets = create<SecretsState>((set) => ({
  token: {}, secret: {},
  setToken: (id, v) => set((s) => { const { [id]: _, ...rest } = s.token; return { token: v ? { ...rest, [id]: v } : rest }; }),
  setSecret: (id, v) => set((s) => { const { [id]: _, ...rest } = s.secret; return { secret: v ? { ...rest, [id]: v } : rest }; }),
}));

const copy = (text: string, what: string) => copyText(text).then((ok) => toast(ok ? `${what} copied` : 'Copy failed', ok ? 'success' : 'error'));

function CopyField({ label, value, mono = true, testid, multiline }: { label: string; value: string; mono?: boolean; testid?: string; multiline?: boolean }) {
  const cls = cx('min-w-0 flex-1 bg-transparent px-2 text-sm outline-none', mono && 'font-mono');
  return (
    <div className="mb-4"><span className="label">{label}</span>
      <div className="flex gap-2 rounded bg-input p-1">
        {multiline ? <textarea readOnly rows={3} aria-label={label} data-testid={testid} value={value} onFocus={(e) => e.target.select()} className={cx(cls, 'resize-none break-all py-1.5')} />
          : <input readOnly aria-label={label} data-testid={testid} value={value} onFocus={(e) => e.target.select()} className={cls} />}
        <button type="button" className={cx('btn btn-primary shrink-0 whitespace-nowrap', multiline && 'self-start')} onClick={() => void copy(value, label)}><Copy size={14} />{t('Copy')}</button></div></div>
  );
}

/** One-time secret reveal: a warning banner with the value. */
function SecretBanner({ title, value, onClose, testid }: { title: string; value: string; onClose: () => void; testid: string }) {
  return (
    <div role="alert" className="mb-5 rounded-lg border border-warn/60 bg-warn/10 p-4">
      <div className="mb-1 flex items-center gap-2 font-bold text-header"><TriangleAlert size={18} className="text-warn" aria-hidden />{title}</div>
      <p className="mb-2 text-sm text-muted">{t('Copy it now. For your security it is only shown once and cannot be recovered; you can always generate a new one.')}</p>
      <div className="flex gap-2 rounded bg-input p-1"><input readOnly data-testid={testid} aria-label={title} value={value} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 bg-transparent px-2 font-mono text-sm outline-none" /><button className="btn btn-primary" onClick={() => void copy(value, title)}><Copy size={14} />{t('Copy')}</button></div>
      <button className="mt-2 text-sm text-link hover:underline" onClick={onClose}>{t('I have saved it')}</button>
    </div>
  );
}

/* ------------------------------------------------------------------ list */

function AppIcon({ app, size = 48 }: { app: Pick<Application, 'name' | 'icon'>; size?: number }) {
  const src = fileUrl(app.icon);
  return <span className="flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand font-bold text-white" style={{ width: size, height: size, fontSize: size / 3 }}>{src ? <img src={src} alt="" className="h-full w-full object-cover" /> : initials(app.name)}</span>;
}

function NewApplication({ close }: { close: () => void }) {
  const nav = useNavigate(); const qc = useQueryClient(); const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  return (
    <Modal title={t('Create an application')} width={440} onClose={close} footer={<><button className="btn btn-link" onClick={close}>{t('Cancel')}</button><button form="new-app" type="submit" disabled={!name.trim() || busy} className="btn btn-primary btn-lg sm:ms-auto">{t('Create')}</button></>}>
      <form id="new-app" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true);
        try { const a = await api.applications.create({ name: name.trim() }); if (a.token) useSecrets.getState().setToken(a.id, a.token); if (a.clientSecret) useSecrets.getState().setSecret(a.id, a.clientSecret); await qc.invalidateQueries({ queryKey: ['apps'] }); close(); nav(`/developers/${a.id}/information`); }
        catch (err) { toastError(err); setBusy(false); }
      }}>
        <Field label={t('Name')} hint={t('Your bot gets this name. You can change it later.')}><input className="field" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder={t('My Awesome Bot')} autoFocus /></Field>
      </form>
    </Modal>
  );
}

function AppList() {
  const q = useQuery({ queryKey: ['apps'], queryFn: api.applications.list }); const [creating, setCreating] = useState(false);
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between gap-3"><h1 className="text-2xl font-extrabold text-header">{t('Applications')}</h1><button className="btn btn-primary btn-lg" onClick={() => setCreating(true)}><Plus size={16} />{t('New Application')}</button></div>
      {q.isLoading && <Spinner className="mx-auto my-10" />}
      {q.isError && <Empty icon={<TriangleAlert size={40} />} title={t('Could not load your applications')} />}
      {q.data && !q.data.length && <Empty icon={<Bot size={44} />} title={t('No applications yet')}>{t('Create one to get a bot user, a token and slash commands.')}</Empty>}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{q.data?.map((a) => (
        <li key={a.id}><Link data-app={a.id} to={`/developers/${a.id}/information`} className="flex items-center gap-3 rounded-lg bg-side p-4 transition-colors hover:bg-hover"><AppIcon app={a} /><span className="min-w-0"><span className="block truncate font-bold text-header">{a.name}</span><span className="block truncate text-xs text-muted">{a.id}</span></span></Link></li>))}</ul>
      {creating && <NewApplication close={() => setCreating(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ app tabs */

function General({ app }: { app: Application }) {
  const qc = useQueryClient(); const nav = useNavigate(); const openModal = useUI((s) => s.openModal);
  const [f, setF] = useState({ name: app.name, description: app.description, icon: app.icon, endpoint: app.interactionsEndpointUrl ?? '' }); const [busy, setBusy] = useState(false);
  const dirty = f.name !== app.name || f.description !== app.description || f.icon !== app.icon || f.endpoint !== (app.interactionsEndpointUrl ?? '');
  const save = async () => {
    setBusy(true);
    try { await api.applications.patch(app.id, { name: f.name.trim(), description: f.description, icon: f.icon, interactionsEndpointUrl: f.endpoint.trim() || null }); await qc.invalidateQueries({ queryKey: ['apps'] }); toast(t('Application saved'), 'success'); }
    catch (e) { toastError(e); } setBusy(false);
  };
  return (<>
    <h1 className="mb-5 text-xl font-bold text-header">{t('General Information')}</h1>
    <div className="mb-5 flex flex-wrap items-start gap-6"><div><span className="label">{t('App Icon')}</span><IconPicker value={f.icon} onChange={(v) => setF({ ...f, icon: v })} size={72} label={t('Icon')} /></div>
      <div className="min-w-[220px] flex-1"><Field label={t('Name')}><input className="field" value={f.name} maxLength={32} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div></div>
    <Field label={t('Description')}><textarea className="field min-h-[90px]" value={f.description} maxLength={400} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    <CopyField label={t('Application ID')} value={app.id} testid="app-id" />
    <CopyField label={t('Public Key')} value={app.publicKey} testid="app-public-key" />
    <Field label={t('Interactions Endpoint URL')} hint={t('Optional. Jorcord sends signed HTTP requests here instead of the gateway. It must answer a signed PING with {type:1}.')}><input className="field" type="url" aria-label={t('Interactions Endpoint URL')} value={f.endpoint} onChange={(e) => setF({ ...f, endpoint: e.target.value })} placeholder="https://example.com/interactions" /></Field>
    <div className="flex items-center gap-2"><button className="btn btn-primary btn-lg" disabled={!dirty || busy || !f.name.trim()} onClick={save}>{t('Save Changes')}</button>{dirty && <button className="btn btn-link" onClick={() => setF({ name: app.name, description: app.description, icon: app.icon, endpoint: app.interactionsEndpointUrl ?? '' })}>{t('Reset')}</button>}</div>
    <h3 className="mb-2 mt-10 text-xs font-bold uppercase tracking-wide text-danger">{t('Danger zone')}</h3>
    <button className="btn btn-danger btn-lg" onClick={() => openModal({ kind: 'prompt', title: `Delete '${app.name}'`, label: `Type the application name (${app.name}) to confirm. The bot is removed from every server.`, onSubmit: async (v) => { if (v !== app.name) { toast(t('Name did not match'), 'error'); return; } try { await api.applications.delete(app.id); await qc.invalidateQueries({ queryKey: ['apps'] }); nav('/developers'); } catch (e) { toastError(e); } } })}>{t('Delete App')}</button>
  </>);
}

function OAuth({ app }: { app: Application }) {
  const qc = useQueryClient(); const secret = useSecrets((s) => s.secret[app.id]); const setSecret = useSecrets((s) => s.setSecret); const openModal = useUI((s) => s.openModal);
  const [uris, setUris] = useState(app.redirectUris); const [draft, setDraft] = useState(''); const [busy, setBusy] = useState(false);
  const [scopes, setScopes] = useState<OAuthScope[]>(['bot', 'applications.commands']); const [bits, setBits] = useState<Set<PermName>>(new Set()); const [redirect, setRedirect] = useState('');
  const dirty = JSON.stringify(uris) !== JSON.stringify(app.redirectUris);
  const url = useMemo(() => buildAuthorizeUrl(publicOrigin(), { clientId: app.id, scopes, permissions: permissionBits(bits), redirectUri: scopes.includes('identify') ? redirect || undefined : undefined }), [app.id, scopes, bits, redirect]);
  const toggleScope = (s: OAuthScope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const addUri = () => { const v = draft.trim(); if (!v) return; try { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { toast(t('Enter a valid http(s) URL'), 'error'); return; } if (!uris.includes(v)) setUris([...uris, v]); setDraft(''); };
  const saveUris = async () => { setBusy(true); try { await api.applications.patch(app.id, { redirectUris: uris }); await qc.invalidateQueries({ queryKey: ['apps'] }); toast(t('Redirects saved'), 'success'); } catch (e) { toastError(e); } setBusy(false); };
  return (<>
    <h1 className="mb-5 text-xl font-bold text-header">OAuth2</h1>
    <CopyField label={t('Client ID')} value={app.id} testid="client-id" />
    {secret && <SecretBanner title={t('Client Secret')} value={secret} onClose={() => setSecret(app.id, null)} testid="client-secret" />}
    <div className="mb-6"><span className="label">{t('Client Secret')}</span>
      <button className="btn btn-secondary" onClick={() => openModal({ kind: 'confirm', title: 'Reset client secret?', body: 'The old secret stops working and every OAuth2 access token of this application is revoked.', confirmLabel: 'Reset Secret', danger: true, onConfirm: () => api.applications.resetSecret(app.id).then((r) => setSecret(app.id, r.clientSecret)).catch(toastError) })}><KeyRound size={14} />{t('Reset Secret')}</button></div>
    <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-interactive">{t('Redirects')}</h2>
    <ul className="mb-2" aria-label={t('Redirects')}>{uris.map((u) => <li key={u} className="flex items-center gap-2 border-b border-divider/50 py-1.5 text-sm"><span className="min-w-0 flex-1 truncate font-mono">{u}</span><button aria-label={`Remove ${u}`} className="p-1.5 text-danger" onClick={() => setUris(uris.filter((x) => x !== u))}><Trash2 size={14} /></button></li>)}</ul>
    <div className="mb-2 flex gap-2"><input className="field" aria-label={t('Redirect URI')} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addUri(); } }} placeholder="https://example.com/callback" /><button className="btn btn-secondary shrink-0 whitespace-nowrap" onClick={addUri}>{t('Add Redirect')}</button></div>
    {dirty && <button className="btn btn-primary mb-4" disabled={busy} onClick={saveUris}>{t('Save Changes')}</button>}

    <h2 className="mb-2 mt-8 text-xs font-bold uppercase tracking-wide text-interactive">{t('OAuth2 URL Generator')}</h2>
    <p className="mb-3 text-sm text-muted">{t('Build the link people use to add your bot to their server.')}</p>
    <fieldset className="mb-4"><legend className="label">{t('Scopes')}</legend>
      <div className="grid gap-1 sm:grid-cols-2">{OAuthScopes.map((s) => <label key={s} className="flex cursor-pointer items-center gap-2 rounded bg-side p-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand" checked={scopes.includes(s)} onChange={() => toggleScope(s)} /><span><b className="text-header">{s}</b><span className="block text-xs text-muted">{SCOPE_INFO[s].label}</span></span></label>)}</div></fieldset>
    {scopes.includes('identify') && <Field label={t('Redirect URL')}><select className="field" value={redirect} onChange={(e) => setRedirect(e.target.value)}><option value="">{t('Select a redirect')}</option>{app.redirectUris.map((u) => <option key={u} value={u}>{u}</option>)}</select></Field>}
    {scopes.includes('bot') && (
      <fieldset className="mb-4"><legend className="label">{t('Bot Permissions')}</legend>
        <div className="grid max-h-72 gap-1 overflow-y-auto sm:grid-cols-2">{PERMISSION_META.map((p) => <label key={p.name} className="flex cursor-pointer items-center gap-2 rounded bg-side p-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand" checked={bits.has(p.name)} onChange={(e) => setBits((cur) => { const n = new Set(cur); e.target.checked ? n.add(p.name) : n.delete(p.name); return n; })} /><span className="min-w-0 truncate" title={p.desc}>{p.label}</span></label>)}</div></fieldset>)}
    <div className="mb-2"><CopyField label={t('Generated URL')} value={url} testid="generated-url" mono multiline /></div>
  </>);
}

function BotTab({ app }: { app: Application }) {
  const qc = useQueryClient(); const token = useSecrets((s) => s.token[app.id]); const setToken = useSecrets((s) => s.setToken); const openModal = useUI((s) => s.openModal);
  return (<>
    <h1 className="mb-5 text-xl font-bold text-header">Bot</h1>
    <div className="mb-5 flex items-center gap-3 rounded-lg bg-side p-4"><Avatar user={app.botUser} size={56} /><div className="min-w-0"><div className="flex items-center gap-2 font-bold text-header">{app.botUser.displayName || app.botUser.username}<span className="rounded bg-brand px-1 text-[10px] font-bold uppercase text-white">Bot</span></div><div className="truncate text-xs text-muted">{app.botUser.id}</div></div></div>
    {token && <SecretBanner title={t('Bot Token')} value={token} onClose={() => setToken(app.id, null)} testid="bot-token" />}
    <div className="mb-6"><span className="label">{t('Token')}</span><p className="mb-2 text-sm text-muted">{t('Tokens are stored hashed and can not be shown again. Resetting signs the bot out of the gateway immediately.')}</p>
      <button className="btn btn-primary" onClick={() => openModal({ kind: 'confirm', title: 'Reset bot token?', body: 'The current token stops working at once and the bot is disconnected from the gateway.', confirmLabel: 'Yes, do it!', danger: true, onConfirm: () => api.applications.resetToken(app.id).then((r) => setToken(app.id, r.token)).catch(toastError) })}><KeyRound size={14} />{t('Reset Token')}</button></div>
    <Row title={t('Public Bot')} desc={t('Anyone can add your bot to their server. When off, only you can.')}><Toggle label={t('Public Bot')} checked={app.botPublic} onChange={(v) => api.applications.patch(app.id, { botPublic: v }).then(() => qc.invalidateQueries({ queryKey: ['apps'] })).catch(toastError)} /></Row>
    <DirectoryListing app={app} />
  </>);
}

/** Opt a public bot into the App Directory (Discover > Apps). */
function DirectoryListing({ app }: { app: Application }) {
  const qc = useQueryClient(); const d = app.directory;
  const [summary, setSummary] = useState(d?.summary ?? ''); const [category, setCategory] = useState<DirectoryCategory>((d?.category as DirectoryCategory) ?? 'other'); const [tags, setTags] = useState((d?.tags ?? []).join(', '));
  const [bits, setBits] = useState<Set<PermName>>(new Set(permissionNames(d?.permissions ?? '0'))); const [busy, setBusy] = useState(false);
  const tagList = tags.split(/[,\s]+/).map((x) => x.trim().toLowerCase().replace(/^#/, '')).filter(Boolean);
  const save = async (listed: boolean) => {
    setBusy(true);
    try { await api.applications.patch(app.id, { directorySummary: summary.trim(), directoryCategory: category, directoryTags: tagList, directoryPermissions: permissionBits(bits), directoryListed: listed }); await qc.invalidateQueries({ queryKey: ['apps'] }); toast(listed ? t('Saved') : t('Removed from the App Directory'), 'success'); } catch (e) { toastError(e); }
    setBusy(false);
  };
  return (<section className="mt-8" data-testid="directory-listing" aria-label={t('App Directory')}>
    <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-interactive">{t('App Directory')}</h2>
    <p className="mb-3 text-sm text-muted">{t('List your public bot so people can find it under Discover > Apps and add it with one click. Needs a description of at least 10 characters (General Information) and a summary.')}</p>
    {!app.botPublic && <p className="mb-3 text-sm text-warn">{t('Turn on Public Bot to list it.')}</p>}
    <Field label={t('Summary (shown on the card, max 140 characters)')}><input className="field" maxLength={140} value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('Category')}><select className="field" aria-label={t('Category')} value={category} onChange={(e) => setCategory(e.target.value as DirectoryCategory)}>{DIRECTORY_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{t(c.name)}</option>)}</select></Field>
      <Field label={t('Tags (up to 5, comma separated)')}><input className="field" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="dice, games" /></Field>
    </div>
    <details className="mb-4"><summary className="cursor-pointer text-sm font-medium text-header">{t('Suggested permissions')} ({bits.size})</summary>
      <div className="mt-2 grid max-h-60 gap-1 overflow-y-auto sm:grid-cols-2">{PERMISSION_META.map((p) => <label key={p.name} className="flex cursor-pointer items-center gap-2 rounded bg-side p-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand" checked={bits.has(p.name)} onChange={(e) => setBits((cur) => { const n = new Set(cur); if (e.target.checked) n.add(p.name); else n.delete(p.name); return n; })} />{p.label}</label>)}</div></details>
    <div className="flex gap-2"><button className="btn btn-primary" disabled={busy || !app.botPublic} onClick={() => void save(true)}>{d?.listed ? t('Save Listing') : t('List in App Directory')}</button>
      {d?.listed && <button className="btn btn-secondary" disabled={busy} onClick={() => void save(false)}>{t('Remove Listing')}</button>}</div>
  </section>);
}

function CommandsTab({ app }: { app: Application }) {
  const qc = useQueryClient();
  const installs = useQuery({ queryKey: ['installs', app.id], queryFn: () => api.applications.installs(app.id) });
  const guilds = useQuery({ queryKey: ['my-guilds'], queryFn: api.users.guilds, retry: false });
  const scopes = useMemo(() => [{ id: undefined as string | undefined, name: t('Global commands') }, ...(installs.data ?? []).filter((i) => i.scopes.includes('applications.commands') || i.scopes.includes('bot')).slice(0, 10).map((i) => ({ id: i.guildId as string | undefined, name: guilds.data?.find((g) => g.id === i.guildId)?.name ?? `Server ${i.guildId}` }))], [installs.data, guilds.data]);
  return (<>
    <h1 className="mb-1 text-xl font-bold text-header">{t('Commands')}</h1>
    <p className="mb-5 text-sm text-muted">{t('Slash and context-menu commands your application registered. Register them from your bot with PUT /applications/{id}/commands.')}</p>
    {scopes.map((sc) => <CommandScope key={sc.id ?? 'global'} app={app} scope={sc} onChange={() => qc.invalidateQueries({ queryKey: ['commands-list', app.id] })} />)}
    <h2 className="mb-2 mt-8 text-xs font-bold uppercase tracking-wide text-interactive">{t('Installed in')}</h2>
    {installs.isLoading ? <Spinner /> : !installs.data?.length ? <p className="text-sm text-muted">{t('Not added to any server yet. Use the URL generator under OAuth2.')}</p> : <ul>{installs.data.map((i) => <li key={i.guildId} className="flex items-center gap-2 border-b border-divider/50 py-2 text-sm"><span className="font-medium text-header">{guilds.data?.find((g) => g.id === i.guildId)?.name ?? i.guildId}</span><span className="ms-auto text-xs text-muted">{i.scopes.join(', ')}</span></li>)}</ul>}
  </>);
}

function CommandScope({ app, scope, onChange }: { app: Application; scope: { id?: string; name: string }; onChange: () => void }) {
  const q = useQuery({ queryKey: ['commands-list', app.id, scope.id ?? 'global'], queryFn: () => api.applications.commands(app.id, scope.id) });
  const openModal = useUI((s) => s.openModal);
  return (
    <section className="mb-6" aria-label={scope.name} data-scope={scope.id ?? 'global'}>
      <h2 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-interactive"><Terminal size={14} aria-hidden />{scope.name}{q.data && <span className="font-normal text-muted">({q.data.length})</span>}</h2>
      {q.isLoading && <Spinner />}
      {q.data && !q.data.length && <p className="rounded bg-side p-3 text-sm text-muted">{t('No commands registered.')}</p>}
      <ul className="divide-y divide-divider/50 rounded-lg bg-side">{q.data?.map((c) => (
        <li key={c.id} data-command={c.name} className="flex items-start gap-3 p-3 text-sm">
          <span className="rounded bg-active px-1.5 py-0.5 font-mono font-semibold text-header">{c.type === 1 ? '/' : c.type === 2 ? 'user:' : 'msg:'}{c.name}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-normal">{c.description || <i className="text-muted">{t('context menu command')}</i>}</span>
            {variantsOf(c).some((v) => v.options.length || v.label) && <span className="block truncate text-xs text-muted">{variantsOf(c).map((v) => [v.label, ...v.options.map((o) => `${o.name}${o.required ? '*' : ''}`)].filter(Boolean).join(' ')).join(' · ')}</span>}</span>
          <button aria-label={`Delete /${c.name}`} className="p-1.5 text-danger" onClick={() => openModal({ kind: 'confirm', title: `Delete /${c.name}`, body: 'Remove this command?', confirmLabel: 'Delete', danger: true, onConfirm: () => api.applications.deleteCommand(app.id, c.id, scope.id).then(() => { void q.refetch(); onChange(); }).catch(toastError) })}><Trash2 size={14} /></button>
        </li>))}</ul>
    </section>
  );
}

const TABS = [['information', 'General Information', Cog], ['oauth2', 'OAuth2', Link2], ['bot', 'Bot', Bot], ['commands', 'Commands', Terminal]] as const;

function AppPage() {
  const { appId = '', tab = 'information' } = useParams(); const token = useSecrets((s) => s.token[appId]); const secret = useSecrets((s) => s.secret[appId]);
  const q = useQuery({ queryKey: ['apps'], queryFn: api.applications.list });
  const app = q.data?.find((a) => a.id === appId);
  if (q.isLoading) return <Spinner className="mx-auto my-16" />;
  if (!app) return <div className="p-8"><Empty icon={<TriangleAlert size={40} />} title={t('Application not found')}><Link className="text-link hover:underline" to="/developers">{t('Back to applications')}</Link></Empty></div>;
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:flex-row">
      <nav aria-label={app.name} className="shrink-0 md:w-56">
        <div className="mb-4 flex items-center gap-2"><AppIcon app={app} size={36} /><span className="truncate font-bold text-header">{app.name}</span></div>
        <ul className="flex gap-1 overflow-x-auto md:flex-col">{TABS.map(([id, label, Icon]) => <li key={id}><Link to={`/developers/${app.id}/${id}`} aria-current={tab === id ? 'page' : undefined} className={cx('flex items-center gap-2 whitespace-nowrap rounded px-2.5 py-1.5 text-[15px] font-medium', tab === id ? 'bg-active text-header' : 'text-interactive hover:bg-hover hover:text-interactive-hover')}><Icon size={17} aria-hidden />{t(label)}</Link></li>)}</ul>
      </nav>
      <section className="min-w-0 flex-1">
        {(token || secret) && tab === 'information' && (<div data-testid="fresh-secrets">
          {token && <SecretBanner title={t('Bot Token')} value={token} onClose={() => useSecrets.getState().setToken(app.id, null)} testid="bot-token" />}
          {secret && <SecretBanner title={t('Client Secret')} value={secret} onClose={() => useSecrets.getState().setSecret(app.id, null)} testid="client-secret" />}
        </div>)}
        {tab === 'information' && <General key={app.id} app={app} />}
        {tab === 'oauth2' && <OAuth key={app.id} app={app} />}
        {tab === 'bot' && <BotTab key={app.id} app={app} />}
        {tab === 'commands' && <CommandsTab key={app.id} app={app} />}
        {!TABS.some(([id]) => id === tab) && <Navigate to={`/developers/${app.id}/information`} replace />}
      </section>
    </div>
  );
}

export function DeveloperPortal() {
  const access = useAuth((s) => s.access); const loc = useLocation();
  const me = useQuery({ queryKey: ['dev-me'], queryFn: api.users.me, enabled: !!access, retry: false });
  useEffect(() => { document.title = 'Jorcord Developer Portal'; return () => { document.title = 'Jorcord'; }; }, []);
  if (!access) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  return (
    <div data-testid="dev-portal" className="flex h-full flex-col overflow-y-auto bg-chat">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-divider bg-rail px-4 safe-top box-content">
        <Link to="/developers" className="flex items-center gap-2 font-bold text-header"><Logo size={26} /><span>Jorcord</span><span className="rounded bg-brand px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">Developers</span></Link>
        <Link to="/channels/@me" className="ms-auto flex items-center gap-1 whitespace-nowrap text-sm text-interactive hover:text-header" aria-label={t('Back to Jorcord')}><ArrowLeft size={16} aria-hidden /><span className="max-sm:hidden">{t('Back to Jorcord')}</span></Link>
        {me.data && <Avatar user={me.data} size={28} />}
      </header>
      <main className="flex-1">
        <Routes>
          <Route index element={<AppList />} />
          <Route path=":appId/:tab?" element={<AppPage />} />
        </Routes>
      </main>
      <footer className="flex items-center justify-center gap-2 py-4 text-xs text-muted"><Code2 size={14} aria-hidden />{t('Interactions, OAuth2 and webhooks: see docs/CONTRACT.md')}</footer>
    </div>
  );
}
void Perm;
