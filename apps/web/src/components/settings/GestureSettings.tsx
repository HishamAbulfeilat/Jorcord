import { Row } from '@/components/ui/primitives';
import { useUI } from '@/stores/ui';
import { SWIPE_ACTIONS, SWIPE_LABEL, sanitizeSwipe, type SwipeAction } from '@/lib/swipe';
import { t } from '@/i18n';

/** Settings > Appearance > Message gestures: what swiping a message does on touch screens. */
export function GestureSettings() {
  const prefs = useUI((s) => s.prefs); const set = useUI((s) => s.setPref);
  const sw = sanitizeSwipe(prefs);
  const sel = (key: 'swipeRight' | 'swipeLeft', label: string) => (
    <select aria-label={label} value={sw[key]} onChange={(e) => set(key, e.target.value as SwipeAction)} className="field min-h-[44px]">
      {SWIPE_ACTIONS.map((a) => <option key={a} value={a}>{t(SWIPE_LABEL[a])}</option>)}
    </select>
  );
  return (
    <section aria-label={t('Message gestures')} data-testid="gesture-settings">
      <h3 className="section-title mb-2 mt-4">{t('Message gestures')}</h3>
      <Row title={t('Swipe right on a message')} desc={t('Touch screens. Swipes that start at the screen edge still open the side menus.')}>{sel('swipeRight', t('Swipe right action'))}</Row>
      <Row title={t('Swipe left on a message')}>{sel('swipeLeft', t('Swipe left action'))}</Row>
    </section>
  );
}
