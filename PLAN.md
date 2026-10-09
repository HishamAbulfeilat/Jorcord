# Jorcord: Build Plan

A Discord-style chat platform that runs on web, desktop, iOS and Android. This is the plan for review before any code is written.

## 0. Ground rules

- **Name and assets are our own.** We copy Discord's UX, layout, behaviour and feature set. We do not copy its logo, its mascot, its trademarked name, its fonts or its sound files. Using those would get the app taken down.
- **Nitro is simulated.** There are no real payments in v1. Nitro and server boosts are real *features* (upload limits, animated avatars, custom emoji everywhere, profile banners, boost tiers) gated by a subscription record. Checkout is a stub that can later be swapped for Stripe.
- **"Works on all devices" means one codebase.** It is a responsive PWA, wrapped for the stores and desktop (see section 3).

## 1. Research summary

### Discord feature inventory (what "exact" means)

| Area | Features |
|---|---|
| Accounts | Register and login, email verification, 2FA (TOTP), sessions and devices, display name and username, avatar, banner, bio, pronouns, custom status, presence (online, idle, DND, invisible) |
| Social | Friends list, friend requests, blocking, DMs, group DMs, user profiles and mutual servers, activity status |
| Servers (guilds) | Create, join by invite link, server icon, banner and description, channel categories, server settings, audit log, bans and kicks, timeouts, onboarding and rules screening, discovery |
| Channels | Text, voice, announcement, stage, forum, categories, threads, per-channel permission overrides, slowmode, NSFW and age gate |
| Messaging | Real-time send and edit and delete, replies, mentions (@user, @role, @everyone, #channel), markdown, code blocks, spoilers, embeds and link previews, attachments, image and video previews, emoji and custom emoji, stickers, GIF picker, reactions, pins, typing indicator, unread and mention badges, search, message history pagination |
| Roles and permissions | Roles with colours and hoist, about 40 permission bits, channel overrides, role hierarchy, `@everyone` |
| Voice and video | Voice channels, mute and deafen, push-to-talk, camera, screen share, stage speakers and audience, DM calls, noise suppression, soundboard |
| Moderation | Audit log, AutoMod rules (keyword and spam), reports, bans and timeouts |
| Extensibility | Bots and webhooks, slash commands, REST API, gateway API, OAuth2 |
| Nitro | Larger uploads (10 MB free, 500 MB Nitro), custom emoji everywhere, animated avatar and banner, profile themes and colours, server boosts with 3 tiers, HD streaming, custom tags |
| Settings | Appearance (dark, light, AMOLED, density), notifications (per server and channel), keybinds, voice and video devices, privacy, language, accessibility |

### Open-source references and what we take from each

| Project | Take | Skip |
|---|---|---|
| **Stoat (formerly Revolt)** (Rust backend, Svelte/Solid client, LiveKit voice) | Closest Discord clone. Service layout (API, events gateway, file server, voice via LiveKit) | Rust, because it slows a feature race |
| **Spacebar (formerly Fosscord)** (TypeScript) | Discord API and gateway-opcode compatibility, permission-bit model, snowflake IDs | Its client is incomplete and has no voice |
| **Matrix/Element, Rocket.Chat, Mattermost** | Notification and unread-state logic, search indexing | Heavy protocol |
| **LiveKit** (Apache-2.0 SFU) | Voice, video and screen share. Writing our own WebRTC SFU would take months | None |

> Spacebar and Stoat were found through web search. I have **not** cloned or read their source yet. Phase 0 includes a short code read of both before we freeze the schema.

## 2. Architecture

```
 clients (web PWA / Tauri desktop / Capacitor mobile)
        |  HTTPS REST            |  WSS gateway           |  WebRTC
        v                        v                        v
   +----------+          +-------------+           +-----------+
   | API      |<-------->| Gateway     |           | LiveKit   |
   | Fastify  |  Redis   | ws, sharded |           | SFU       |
   +----+-----+  pub/sub +------+------+           +-----------+
        |                       |
   Postgres  (users, guilds, channels, messages, roles)
   Redis     (presence, typing, pub/sub, rate limits)
   MinIO/S3  (attachments, avatars, emoji)
   Meilisearch (message search)  [phase 4]
```

- **Language:** TypeScript end to end.
- **Monorepo:** pnpm workspaces and Turborepo.
  - `apps/web`: React 18, Vite, TanStack Query, Zustand, Tailwind with Discord-style design tokens. It is a PWA.
  - `apps/server`: Fastify REST API plus a `ws` gateway that speaks a Discord-like opcode protocol (HELLO, IDENTIFY, DISPATCH, HEARTBEAT).
  - `packages/shared`: types, permission bits, Zod schemas, snowflake IDs.
  - `packages/ui`: shared components.
  - `apps/desktop`: Tauri shell. `apps/mobile`: Capacitor shell (iOS and Android).
- **IDs:** snowflake IDs, so messages sort by time and can be sharded later.
- **Messages:** Postgres with `(channel_id, id DESC)` indexing and keyset pagination. Partition by time later if needed.
- **Auth:** Argon2id password hashes, short-lived access JWT plus rotating refresh token, TOTP 2FA.
- **Permissions:** 64-bit permission bitfield computed server-side (base roles, then channel overrides). The client only hides UI. The server enforces.
- **Existing `package.json`:** it uses Create React App (`react-scripts`), which is deprecated. I will replace it with the Vite monorepo above.
- **README idea ("seeds like torrent to host"):** optional P2P-hosted servers are out of scope for v1. I would revisit this after phase 5.

## 3. Platform coverage

| Target | How | Notes |
|---|---|---|
| Web (desktop and mobile browsers) | Responsive React app, installable PWA | Mobile layout uses swipe drawers for the server list and member list, like Discord's phone app |
| Windows, macOS, Linux | Tauri wrapper | Native notifications, tray, auto-start |
| Android and iOS | Capacitor wrapper | Push notifications. iOS builds need a Mac and an Apple developer account, which I can't do from this cloud container. I would prepare the project and you build it. |

## 4. Phases

| Phase | Scope | Done when |
|---|---|---|
| **0. Foundation** | Monorepo, CI, Docker Compose (Postgres, Redis, MinIO), design tokens, schema and migrations, read Spacebar and Stoat source | `docker compose up` brings up the stack. Lint and typecheck are green |
| **1. Core chat** | Auth, servers, text channels and categories, invites, real-time messages (edit, delete, reply), typing, presence, unread badges, DMs, member list, user settings, Discord-style 4-column layout | Two browsers chat live in a server |
| **2. Roles, rich messages** | Roles and permissions with overrides, mentions, markdown, attachments, embeds, emoji, reactions, pins, threads, friends, group DMs, audit log, moderation | A mod can restrict a channel and ban a user |
| **3. Voice and video** | LiveKit voice channels, camera, screen share, DM calls, mute and deafen, PTT, stage channels | Three users talk and share a screen |
| **4. Nitro and polish** | Nitro plans (stub checkout), boosts and tiers, upload limits, animated avatars, profile themes, custom emoji everywhere, GIF picker, search, forum channels, AutoMod | Subscribing visibly changes limits and cosmetics |
| **5. Ship** | PWA install, Tauri and Capacitor shells, push notifications, accessibility pass, e2e tests, bots and webhooks API, deploy docs | Installable on desktop and phone, with docs |

## 5. How I'll use agents, skills and design tools

| Need | Tool |
|---|---|
| Discord-faithful UI design | Artifact design skills for a clickable design reference of the main screens (server rail, channel list, chat, member list, settings, Nitro page, mobile drawers). Figma MCP is configured here but failed to connect, so it is unavailable. |
| Parallel implementation | One `general-purpose` sub-agent per workstream, each in its own git worktree: (a) server REST and DB, (b) gateway and presence, (c) web UI shell and chat, (d) voice and LiveKit, (e) settings, profiles and Nitro UI. I merge, then run integration tests. |
| Architecture and schema | `backend-design` skills and agents: `schema-reviewer`, `security-reviewer`, `auth-and-authorization`, `idempotency-and-side-effects` |
| Quality gates | `code-review`, `security-review`, `testing-strategy`, `accessibility-review` before each phase is merged |
| UI verification | The pre-installed Chromium with Playwright, for screenshots and two-browser e2e chat tests |

## 6. Honest limits

- **"Exact clone of everything" is not achievable in one session.** Discord has hundreds of engineers and many years behind it. This plan gets the full feature *surface* in phases. Phases 0 to 2 are a realistic first deliverable, and each later phase is a further large chunk.
- Real payments, real push notifications on iOS, and App Store or Play Store publishing need your accounts and credentials.
- Discord's own servers, bots and user accounts can't be used. This is a separate network.
- Voice quality and scale depend on LiveKit and your hosting, not on the client code.

## 7. Decisions for you

1. Is the name **Jorcord** with our own logo OK? (Recommended, to avoid trademark problems.)
2. Is the stack (TypeScript, Postgres, Redis, LiveKit, Tauri, Capacitor) OK?
3. Should I start with phases 0 to 1 and show you a working chat, or push through to phase 5 in one run? (Recommended: 0 to 1 first, then review.)
