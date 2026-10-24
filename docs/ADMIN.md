# Instance administration

Two roles, both answered with **404 to everyone else** (the panel's existence is never advertised):

- **Super admin**: the single account named by env `SUPER_ADMIN_USER_ID`. Not stored in the DB, cannot be disabled, banned, demoted or targeted by any API, and is the only account that can use god mode.
- **Delegated admin**: a human account with `users.instance_admin = true` (migration 090, default `false`; also `instance_admin_granted_by/_at`). Only the super admin can set or clear it.

The role is read from the database on **every** request (`adminRole()` in `routes/admin.ts`, no cache), so a revoke, disable or deletion takes effect on the very next request, live sessions included. Bots, deleted and disabled accounts are never admins.

## Granting

- `POST /admin/users/:id/admin` and `DELETE /admin/users/:id/admin` (super only).
- Refused: the super admin (400), bots, deleted or disabled users (400), unknown ids (404).
- Audited in `admin_audit` as `GRANT_ADMIN` / `REVOKE_ADMIN`.

## Route matrix

| Route | Super | Delegated | Notes |
|---|---|---|---|
| `GET /admin/me` | yes | yes | `{admin:true, role:'super'\|'delegated', ...}` |
| `GET /admin/stats` | yes | yes | |
| `GET /admin/users`, `/admin/users/:id` | yes | yes | include `instanceAdmin` |
| `POST /admin/users/:id/disable`, `/enable` | yes | yes | delegated: 403 on the super admin or another admin; audited `DISABLE_USER`/`ENABLE_USER` |
| `POST /admin/users/:id/clear-dm-limit` | yes | yes | same target rule; audited |
| `GET /admin/guilds`, `/admin/guilds/:id` | yes | yes | |
| `GET /admin/channels/:id/messages` | yes | guild channels only | DMs need god mode: 404 for delegated |
| `GET /admin/reports`, `/admin/mass-dm` | yes | yes | |
| `GET /admin/admins` | yes (with granter) | yes (without granter) | |
| `POST\|DELETE /admin/users/:id/admin` | yes | **no (404)** | grant/revoke |
| `POST /admin/god-mode` | yes | **no (404)** | password (+2FA) re-auth |
| `POST /admin/guilds/:id/join` | yes | **no (404)** | needs god mode |
| `PATCH /admin/users/:id/flags` | yes | **no (404)** | badges, incl. STAFF |
| `GET /admin/audit` | yes | **no (404)** | log contains super-admin activity |

Super-only means dangerous (god mode, joining guilds, reading private DMs), privilege-shaping (grants, badges) or sensitive (audit log).

## Visibility

`/users/@me` and the public user DTO never expose `instance_admin`. The super admin carries the STAFF badge as before. **Delegated admins do not get an automatic STAFF badge** (to avoid advertising who has admin access); the super admin can still set the badge manually via flags.

## Web

The dashboard shows an Admin column (users list), an Admins tab, and on the user page an admin status. "Make admin" / "Remove admin" (with a confirm dialog naming the user), god mode, badge editing, server join and the Admin log appear only for the super admin.
