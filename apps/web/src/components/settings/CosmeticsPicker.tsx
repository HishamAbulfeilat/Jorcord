import { useMemo } from 'react';
import { AVATAR_DECORATIONS, NAME_PLATES, PROFILE_EFFECTS, TAG_BADGES, type CosmeticItem } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { Avatar } from '@/components/ui/Avatar';
import { ProfileEffect, ServerTagBadge, TAG_ICONS, plateClass } from '@/components/ui/Cosmetics';
import { cx } from '@/lib/format';
import { t } from '@/i18n';

export interface CosmeticsValue { avatarDecoration: string | null; profileEffect: string | null; namePlate: string | null; serverTagGuildId: string | null }

function Grid({ label, items, value, onChange, render }: { label: string; items: CosmeticItem[]; value: string | null; onChange: (v: string | null) => void; render: (i: CosmeticItem) => React.ReactNode }) {
  return (
    <fieldset className="mb-4">
      <legend className="label">{label}</legend>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {[{ id: '', name: t('None') } as CosmeticItem, ...items].map((i) => {
          const on = (value ?? '') === i.id;
          return <button key={i.id || 'none'} type="button" role="radio" aria-checked={on} aria-label={i.name} title={i.name} onClick={() => onChange(i.id || null)}
            className={cx('flex h-[72px] w-[72px] flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border-2 bg-side text-[11px] text-muted hover:bg-hover', on ? 'border-brand text-header' : 'border-transparent')}>{i.id ? render(i) : <span className="text-lg">∅</span>}<span className="max-w-full truncate px-1">{i.name}</span></button>;
        })}
      </div>
    </fieldset>
  );
}

/** Profile settings: free avatar decorations, profile effects, name plates and the server tag to wear. */
export function CosmeticsPicker({ value, onChange, me }: { value: CosmeticsValue; onChange: (v: CosmeticsValue) => void; me: { id: string; username: string; displayName: string | null; avatar: string | null } }) {
  const all = useData((s) => s.guilds); const guilds = useMemo(() => Object.values(all).map((g) => g.guild).filter((g) => g.tag), [all]);
  const set = (p: Partial<CosmeticsValue>) => onChange({ ...value, ...p });
  return (
    <div data-testid="cosmetics-picker">
      <Grid label={t('Avatar Decoration')} items={AVATAR_DECORATIONS} value={value.avatarDecoration} onChange={(v) => set({ avatarDecoration: v })}
        render={(i) => <span className="relative block h-7 w-7"><Avatar user={me} size={28} decoration={i.id} /></span>} />
      <Grid label={t('Profile Effect')} items={PROFILE_EFFECTS} value={value.profileEffect} onChange={(v) => set({ profileEffect: v })}
        render={(i) => <span className="relative block h-8 w-full bg-black/30"><ProfileEffect id={i.id} /></span>} />
      <Grid label={t('Name Plate')} items={NAME_PLATES} value={value.namePlate} onChange={(v) => set({ namePlate: v })}
        render={(i) => <span className={cx('block w-14 px-1 py-1 text-xs font-semibold text-header', plateClass(i.id))}>Name</span>} />
      <fieldset className="mb-4">
        <legend className="label">{t('Server Tag')}</legend>
        {!guilds.length ? <p className="text-sm text-muted">{t('None of your servers has a tag yet. Server owners can set one in Server Settings.')}</p> : (
          <div role="radiogroup" aria-label={t('Server Tag')} className="flex flex-wrap gap-2">
            <button type="button" role="radio" aria-checked={!value.serverTagGuildId} onClick={() => set({ serverTagGuildId: null })} className={cx('btn', !value.serverTagGuildId ? 'btn-primary' : 'btn-secondary')}>{t('None')}</button>
            {guilds.map((g) => <button key={g.id} type="button" role="radio" aria-checked={value.serverTagGuildId === g.id} aria-label={`${g.name} tag ${g.tag}`} onClick={() => set({ serverTagGuildId: g.id })} className={cx('btn flex items-center gap-2', value.serverTagGuildId === g.id ? 'btn-primary' : 'btn-secondary')}>
              <ServerTagBadge tag={{ guildId: g.id, tag: g.tag!, badge: g.tagBadge ?? null }} />{g.name}</button>)}
          </div>)}
      </fieldset>
    </div>
  );
}

/** Server Settings > Overview: the tag members may wear and its badge. */
export function ServerTagEditor({ tag, badge, onChange }: { tag: string; badge: string | null; onChange: (v: { tag: string; badge: string | null }) => void }) {
  return (
    <div className="mb-4" data-testid="server-tag-editor">
      <span className="label">{t('Server Tag')}</span>
      <p className="mb-2 text-xs text-muted">{t('Members can wear a 3-4 character tag of this server beside their name. Everyone can use it, it is free.')}</p>
      <div className="flex flex-wrap items-center gap-3">
        <input className="field !w-28 uppercase" aria-label={t('Server tag')} maxLength={4} placeholder="TAG" value={tag} onChange={(e) => onChange({ tag: e.target.value.replace(/[^A-Za-z0-9]/g, ''), badge })} />
        <div role="radiogroup" aria-label={t('Tag badge')} className="flex flex-wrap gap-1">
          {TAG_BADGES.map((b) => { const Icon = TAG_ICONS[b.id as keyof typeof TAG_ICONS]; return <button key={b.id} type="button" role="radio" aria-checked={badge === b.id} aria-label={b.name} title={b.name} onClick={() => onChange({ tag, badge: badge === b.id ? null : b.id })} className={cx('flex h-8 w-8 items-center justify-center rounded border-2 bg-side', badge === b.id ? 'border-brand text-header' : 'border-transparent text-muted hover:bg-hover')}><Icon size={16} /></button>; })}
        </div>
        {tag.length >= 3 && <ServerTagBadge tag={{ guildId: '', tag: tag.toUpperCase(), badge }} />}
      </div>
    </div>
  );
}
