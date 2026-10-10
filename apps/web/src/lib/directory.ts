/** App Directory helpers (pure, unit tested). Installing reuses the existing OAuth2 add-bot page. */
import { DIRECTORY_CATEGORIES, type DirectoryApp } from '@jorcord/shared';
import { permissionNames } from './oauth';

/** In-app path of the add-bot consent page for a listed app (the page asks which server and re-checks MANAGE_GUILD). */
export function installPath(app: Pick<DirectoryApp, 'id' | 'permissions'>): string {
  const p = new URLSearchParams({ client_id: app.id, scope: 'bot applications.commands' });
  if (app.permissions && app.permissions !== '0') p.set('permissions', app.permissions);
  return `/oauth2/authorize?${p.toString().replace(/\+/g, '%20')}`;
}
export const categoryName = (id: string) => DIRECTORY_CATEGORIES.find((c) => c.id === id)?.name ?? 'Other';
/** Short human list of what the app asks for ("Send Messages, Embed Links +3"). */
export function permissionSummary(bits: string, max = 3): string {
  const names = permissionNames(bits).map((n) => n.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()));
  if (!names.length) return 'No special permissions';
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} +${names.length - max}`;
}
export const installsLabel = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));
