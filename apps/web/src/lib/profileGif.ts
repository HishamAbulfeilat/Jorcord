import { api } from '@/lib/api';
import { useUI, toast, toastError } from '@/stores/ui';
import { t } from '@/i18n';

/**
 * Open the GIF search for an avatar/banner. The picked GIF is fetched and re-hosted by the server
 * (POST /users/@me/{avatar,banner}/from-url) and the stored URL is handed to `onUrl`, to be saved with the form.
 */
export function pickProfileGif(kind: 'avatar' | 'banner', onUrl: (url: string) => void) {
  useUI.getState().openModal({
    kind: 'gifPicker', title: kind === 'avatar' ? t('Choose an avatar GIF') : t('Choose a banner GIF'),
    onPick: (url) => { api.files.uploadImageFromUrl(kind, url).then((u) => { onUrl(u); toast(t('GIF added. Save to apply it.'), 'success'); }).catch(toastError); },
  });
}
