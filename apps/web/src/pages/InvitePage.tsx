import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { useData } from '@/stores/data';
import { Logo } from '@/components/ui/Logo';
import { Spinner } from '@/components/ui/primitives';
import { fileUrl, initials } from '@/lib/format';

export function InvitePage() {
  const { code = '' } = useParams(); const nav = useNavigate(); const authed = !!useAuth((s) => s.access);
  const q = useQuery({ queryKey: ['invite', code], queryFn: () => api.invites.get(code), retry: false });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const g = q.data?.guild;
  const accept = async () => {
    if (!authed) { nav(`/login?next=${encodeURIComponent('/invite/' + code)}`); return; }
    setBusy(true); setErr('');
    try { const r = await api.invites.join(code); const gid = r.guild?.id ?? r.guildId ?? q.data?.guildId ?? r.id; if (r.guild) useData.getState().putGuild(r.guild); else if ((r as any).channels) useData.getState().putGuild(r as any); nav(`/channels/${gid}${q.data?.channelId ? '/' + q.data.channelId : ''}`); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-[#1e1f22] bg-[radial-gradient(ellipse_at_top,rgba(88,101,242,.35),transparent_60%)] p-4" data-theme="dark">
      <main className="w-full max-w-[480px] animate-pop rounded-md bg-[#313338] p-8 text-center shadow-elev">
        <Logo size={44} className="mx-auto mb-4" />
        {q.isLoading ? <Spinner className="mx-auto" /> : q.isError ? (<><h1 className="mb-2 text-2xl font-semibold text-[#f2f3f5]">Invite Invalid</h1><p className="mb-6 text-[#b5bac1]">This invite may be expired, or you might not have permission to join.</p><button className="h-11 w-full rounded-[3px] bg-[#5865f2] text-white" onClick={() => nav('/')}>Continue to Jorcord</button></>) : (<>
          <p className="mb-4 text-xs font-bold uppercase tracking-wide text-[#b5bac1]">You've been invited to join</p>
          <div className="mx-auto mb-3 flex h-20 w-20 items-center justify-center overflow-hidden rounded-[24px] bg-[#5865f2] text-2xl font-bold text-white">{g?.icon ? <img src={fileUrl(g.icon)!} alt="" className="h-full w-full object-cover" /> : initials(g?.name ?? '?')}</div>
          <h1 className="mb-1 text-2xl font-semibold text-[#f2f3f5]">{g?.name ?? 'a server'}</h1>
          {q.data?.approxMembers != null && <p className="mb-6 text-sm text-[#b5bac1]">{q.data.approxMembers.toLocaleString()} Members</p>}
          {err && <p role="alert" className="mb-3 text-sm text-[#f23f43]">{err}</p>}
          <button disabled={busy} onClick={accept} className="h-11 w-full rounded-[3px] bg-[#5865f2] font-medium text-white hover:bg-[#4752c4] disabled:opacity-60">{authed ? 'Accept Invite' : 'Log in to accept'}</button>
        </>)}
      </main>
    </div>
  );
}
