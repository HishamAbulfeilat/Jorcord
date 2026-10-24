import { useState } from 'react';
import { DISPLAY_NAME_EFFECTS, DISPLAY_NAME_FONTS, type DisplayNameStyle } from '@jorcord/shared';
import { api3c } from '@/lib/api3c';
import { nameStyleClass } from '@/lib/nameStyle';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { cx } from '@/lib/format';
import { t } from '@/i18n';

const PLAIN: DisplayNameStyle = { font: 'default', effect: 'none' };

/** Free display-name styles: a font preset and an effect preset, previewed live and saved on their own. */
export function DisplayNameStylePicker() {
  const me = useData((s) => s.me)!;
  const saved = me.displayNameStyle ?? PLAIN;
  const [s, setS] = useState<DisplayNameStyle>(saved); const [busy, setBusy] = useState(false);
  const dirty = s.font !== saved.font || s.effect !== saved.effect;
  const save = async () => {
    setBusy(true);
    try {
      const plain = s.font === 'default' && s.effect === 'none';
      const u = await api3c.setDisplayNameStyle(plain ? null : s);
      useData.getState().apply('USER_UPDATE', u); toast(t('Name style saved'), 'success');
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <div className="mb-4" data-testid="name-style-picker">
      <span className="label">{t('Name style')}</span>
      <div className="mb-2 rounded-lg bg-side px-3 py-2 text-lg text-header" aria-live="polite" data-testid="name-style-preview"><span className={nameStyleClass(s)}>{me.displayName || me.username}</span></div>
      <fieldset className="mb-2"><legend className="mb-1 text-xs font-semibold uppercase text-muted">{t('Font')}</legend>
        <div className="flex flex-wrap gap-2">{DISPLAY_NAME_FONTS.map((f) => <button key={f.id} type="button" aria-pressed={s.font === f.id} onClick={() => setS({ ...s, font: f.id })} className={cx('rounded border px-2 py-1 text-sm', s.font === f.id ? 'border-brand bg-active text-header' : 'border-divider text-interactive hover:bg-hover')}><span className={nameStyleClass({ font: f.id, effect: 'none' })}>{t(f.name)}</span></button>)}</div></fieldset>
      <fieldset className="mb-2"><legend className="mb-1 text-xs font-semibold uppercase text-muted">{t('Effect')}</legend>
        <div className="flex flex-wrap gap-2">{DISPLAY_NAME_EFFECTS.map((f) => <button key={f.id} type="button" aria-pressed={s.effect === f.id} onClick={() => setS({ ...s, effect: f.id })} className={cx('rounded border px-2 py-1 text-sm', s.effect === f.id ? 'border-brand bg-active text-header' : 'border-divider text-interactive hover:bg-hover')}><span className={nameStyleClass({ font: 'default', effect: f.id })}>{t(f.name)}</span></button>)}</div></fieldset>
      <div className="flex gap-2"><button type="button" className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>{t('Save name style')}</button>
        <button type="button" className="btn btn-secondary" disabled={s.font === 'default' && s.effect === 'none'} onClick={() => setS(PLAIN)}>{t('Plain name')}</button></div>
    </div>
  );
}
