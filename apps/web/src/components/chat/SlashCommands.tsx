/** Slash-command picker data + the option form that replaces the text box while a command is being filled in. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SendHorizonal, X } from 'lucide-react';
import { CommandOptionType as OT } from '@jorcord/shared';
import type { ApplicationCommand, Channel, CommandOption, CommandOptionChoice } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { usePlatform } from '@/stores/platform';
import { autocompleteOptions, commandLabel, validateOptions, variantsOf, type OptionValues, type Variant } from '@/lib/commands';
import { runCommand } from '@/lib/interactions';
import { toastError } from '@/stores/ui';
import { cx, displayName } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';
import { t } from '@/i18n';

export function useCommandCatalog(guildId: string | null | undefined, channelId: string, enabled = true) {
  return useQuery({
    queryKey: ['commands', guildId, channelId], enabled: !!guildId && enabled, staleTime: 30_000, retry: false,
    queryFn: async () => { const r = await api.guilds.commands(guildId!, channelId); usePlatform.getState().setApps(r.applications ?? []); return r; },
  });
}

const typeHint = (o: CommandOption) => ({ [OT.STRING]: 'text', [OT.INTEGER]: 'whole number', [OT.NUMBER]: 'number', [OT.BOOLEAN]: 'true / false', [OT.USER]: 'member', [OT.CHANNEL]: 'channel', [OT.ROLE]: 'role', [OT.MENTIONABLE]: 'member or role', [OT.ATTACHMENT]: 'attachment' } as Record<number, string>)[o.type] ?? '';

function EntityOptions({ guildId, channelId, o }: { guildId: string | null; channelId: string; o: CommandOption }) {
  const g = useData((s) => (guildId ? s.guilds[guildId] : undefined)); const dm = useData((s) => s.dms[channelId]);
  const users = g ? Object.values(g.members).map((m) => ({ id: m.user.id, label: displayName(m.user, m) })) : (dm?.recipients ?? []).map((u) => ({ id: u.id, label: displayName(u) }));
  const roles = Object.values(g?.roles ?? {}).filter((r) => r.id !== guildId).map((r) => ({ id: r.id, label: `@${r.name}` }));
  const chans = Object.values(g?.channels ?? {}).filter((c) => c.type !== 'category' && c.type !== 'thread' && (!o.channelTypes?.length || o.channelTypes.includes(c.type))).sort((a, b) => a.position - b.position).map((c) => ({ id: c.id, label: `#${c.name}` }));
  const list = o.type === OT.USER ? users : o.type === OT.ROLE ? roles : o.type === OT.CHANNEL ? chans : [...users, ...roles];
  return <>{list.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</>;
}

function OptionInput({ o, v, set, guildId, channel, error, autoFocus, onAutocomplete, choices, onSubmit }: {
  o: CommandOption; v: OptionValues[string]; set: (x: string | number | boolean | undefined) => void; guildId: string | null; channel: Channel; error?: string; autoFocus?: boolean;
  onAutocomplete: (text: string) => void; choices: CommandOptionChoice[]; onSubmit: () => void;
}) {
  const id = `opt-${o.name}`;
  const common = { id, 'aria-label': o.name, className: cx('field !min-h-[36px] !py-1.5 text-sm', error && 'ring-1 ring-danger'), autoFocus } as const;
  let input: React.ReactNode;
  if (o.choices?.length) {
    input = <select {...common} value={v === undefined ? '' : String(v)} onChange={(e) => set(e.target.value === '' ? undefined : e.target.value)}><option value="">{o.required ? t('Choose…') : t('(none)')}</option>{o.choices.map((c) => <option key={String(c.value)} value={String(c.value)}>{c.name}</option>)}</select>;
  } else if (o.type === OT.BOOLEAN) {
    input = <select {...common} value={v === undefined ? '' : String(v)} onChange={(e) => set(e.target.value === '' ? undefined : e.target.value === 'true')}><option value="">{o.required ? t('Choose…') : t('(none)')}</option><option value="true">True</option><option value="false">False</option></select>;
  } else if (o.type === OT.USER || o.type === OT.CHANNEL || o.type === OT.ROLE || o.type === OT.MENTIONABLE) {
    input = <select {...common} value={v === undefined ? '' : String(v)} onChange={(e) => set(e.target.value === '' ? undefined : e.target.value)}><option value="">{o.required ? t('Choose…') : t('(none)')}</option><EntityOptions guildId={guildId} channelId={channel.id} o={o} /></select>;
  } else if (o.type === OT.INTEGER || o.type === OT.NUMBER) {
    input = <input {...common} type="number" step={o.type === OT.INTEGER ? 1 : 'any'} min={o.minValue} max={o.maxValue} value={v === undefined ? '' : String(v)} onChange={(e) => set(e.target.value === '' ? undefined : e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(); } }} />;
  } else if (o.type === OT.ATTACHMENT) {
    input = <span className="text-sm text-muted">{t('Attachments are not supported in the web client yet.')}</span>;
  } else {
    input = (
      <div className="relative">
        <input {...common} type="text" role={o.autocomplete ? 'combobox' : undefined} aria-expanded={o.autocomplete ? choices.length > 0 : undefined} autoComplete="off" minLength={o.minLength} maxLength={o.maxLength} value={v === undefined ? '' : String(v)}
          onChange={(e) => { set(e.target.value === '' ? undefined : e.target.value); if (o.autocomplete) onAutocomplete(e.target.value); }} onFocus={() => { if (o.autocomplete) onAutocomplete(v === undefined ? '' : String(v)); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !(o.autocomplete && choices.length)) { e.preventDefault(); onSubmit(); } }} />
        {o.autocomplete && choices.length > 0 && (
          <ul role="listbox" aria-label={`${o.name} suggestions`} className="absolute inset-x-0 bottom-full z-30 mb-1 max-h-48 overflow-y-auto rounded-md bg-float p-1 shadow-elev">
            {choices.slice(0, 25).map((c) => <li key={String(c.value)} role="option" aria-selected={String(c.value) === String(v)}><button type="button" onMouseDown={(e) => { e.preventDefault(); set(c.value); onAutocomplete(''); }} className="w-full rounded px-2 py-1 text-start text-sm hover:bg-hover">{c.name}</button></li>)}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 flex items-baseline gap-1 text-xs font-bold text-interactive"><span>{o.name}</span>{o.required && <span className="text-danger" aria-label="required">*</span>}<span className="font-normal text-muted">{typeHint(o)}</span></label>
      {input}
      {o.description && !error && <p className="mt-0.5 text-[11px] text-muted">{o.description}</p>}
      {error && <p role="alert" className="mt-0.5 text-[11px] text-danger">{error}</p>}
    </div>
  );
}

export function SlashForm({ channel, command, appName, onDone }: { channel: Channel; command: ApplicationCommand; appName?: string; onDone: () => void }) {
  const variants = useMemo(() => variantsOf(command), [command]);
  const [vi, setVi] = useState(0); const variant: Variant = variants[vi] ?? variants[0]!;
  const [values, setValues] = useState<OptionValues>({}); const [tried, setTried] = useState(false); const [busy, setBusy] = useState(false);
  const [acId, setAcId] = useState<string | null>(null); const acTimer = useRef<ReturnType<typeof setTimeout>>(); const acSeq = useRef(0);
  const choices = usePlatform((s) => (acId ? s.autocomplete[acId] : undefined)) ?? [];
  const errors = useMemo(() => validateOptions(variant.options, values), [variant, values]);
  const bad = Object.keys(errors).length > 0;
  useEffect(() => () => clearTimeout(acTimer.current), []);
  useEffect(() => { setValues({}); setTried(false); setAcId(null); }, [vi]);

  const autocomplete = (name: string) => (text: string) => {
    clearTimeout(acTimer.current);
    acTimer.current = setTimeout(async () => {
      const seq = ++acSeq.current;
      try {
        const r = await api.interactions.send({ type: 4, channelId: channel.id, data: { id: command.id, options: autocompleteOptions(variant, { ...values, [name]: text }, name) } });
        if (seq === acSeq.current) { usePlatform.getState().track({ id: r.id, channelId: channel.id, kind: 'autocomplete', at: Date.now() }); setAcId(r.id); }
      } catch { /* autocomplete is best effort */ }
    }, 250);
  };
  const submit = async () => {
    setTried(true); if (bad || busy) return;
    setBusy(true); const id = await runCommand(channel.id, command, variant, values); setBusy(false);
    if (id) onDone();
  };
  const app = appName ?? '';
  return (
    <form noValidate data-testid="slash-form" aria-label={`Run ${commandLabel(command, variant)}`} className="border-b border-divider/40 p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(); } }}>
      <div className="mb-2 flex items-start gap-2">
        <span className="rounded bg-brand px-1.5 py-0.5 text-sm font-semibold text-white" data-testid="slash-chip">{commandLabel(command, variant)}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted">{variant.description || command.description}{app && <span className="ms-2 text-xs">· {app}</span>}</span>
        <button type="button" aria-label={t('Cancel command')} onClick={onDone} className="text-interactive hover:text-header"><X size={18} /></button>
      </div>
      {variants.length > 1 && (
        <div className="mb-2"><label htmlFor="slash-sub" className="mb-1 block text-xs font-bold text-interactive">subcommand<span className="text-danger"> *</span></label>
          <select id="slash-sub" className="field !min-h-[36px] !py-1.5 text-sm" value={vi} onChange={(e) => setVi(Number(e.target.value))}>{variants.map((v, i) => <option key={v.label} value={i}>{v.label}</option>)}</select></div>
      )}
      {variant.options.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {variant.options.map((o, i) => <OptionInput key={`${vi}-${o.name}`} o={o} v={values[o.name]} set={(x) => setValues((s) => ({ ...s, [o.name]: x }))} guildId={channel.guildId} channel={channel} error={tried ? errors[o.name] : undefined}
            autoFocus={i === 0} onAutocomplete={autocomplete(o.name)} choices={o.autocomplete ? choices : []} onSubmit={() => void submit()} />)}
        </div>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        <span className="me-auto text-xs text-muted">{t('Press Enter to run, Esc to cancel')}</span>
        <button type="submit" disabled={busy} className="btn btn-primary" aria-label={t('Run command')}><SendHorizonal size={14} />{t('Run')}</button>
      </div>
    </form>
  );
}

export function CommandSuggestionIcon({ icon, name }: { icon: string | null | undefined; name: string }) {
  return <Avatar user={{ id: name, username: name, displayName: name, avatar: icon ?? null } as never} size={24} />;
}
