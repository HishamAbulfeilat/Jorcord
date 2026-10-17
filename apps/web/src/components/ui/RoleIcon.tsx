import type { Role } from '@jorcord/shared';
import { fileUrl } from '@/lib/format';

export function RoleIcon({ role, size = 16, className = '' }: { role?: Pick<Role, 'icon' | 'name'> | null; size?: number; className?: string }) {
  const url = fileUrl(role?.icon);
  if (!role || !url) return null;
  return <img src={url} alt="" title={role.name} data-testid="role-icon" width={size} height={size} loading="lazy" draggable={false} className={`inline-block shrink-0 rounded-[3px] object-cover align-text-bottom ${className}`} style={{ width: size, height: size }} />;
}
