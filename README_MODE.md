# Claude mode switch (for cloud / desktop sessions)

This repo is a Discord clone (Jorcord) — it does **not** contain a Claude-mode switch itself. The switch lives in Claude Code's own configuration.

## How to set a persistent free-model mode

Claude Code uses the cheapest model (Haiku) when you set it in the settings file. Add a `.claude/settings.json` file **in your home Claude config directory** (not in this repo) with one of the following:

### Option A: Per-machine persistent (recommended)

`~/.claude/settings.json` (Linux/macOS)  
`%APPDATA%\Claude\settings.json` (Windows)

```json
{
  "model": "claude-haiku-5-5"
}
```

After adding this, **restart Claude Code** (close and reopen). Every new session will start with Haiku unless you override it with `/model` in that conversation.

### Option B: Per-session only (no restart needed)

In any Claude conversation, run:

```
/model haiku
```

This only affects that conversation. The next conversation will use whatever the settings file specifies (or Sonnet by default if no settings file exists).

### Option C: Via `/config` command

You can also use the `/config` skill to set it temporarily or persistently, depending on your Claude Code version and permissions.

## Why Haiku?

- **Haiku** (`claude-haiku-5-5`) is the cheapest, fastest model in the Claude 5 family.
- It handles most assistant tasks (editing, writing, analysis, coding) well enough for everyday use.
- Using it reduces token cost significantly compared to Sonnet or Opus.
- All features remain available — only the underlying model changes.

## Repo contents

This repo (`/c/Users/User/Desktop/Jorcord`) contains:

- `docs/JORCORD_MASTER_PLAN.md` — master plan and agent instructions for Jorcord
- `docs/DISCORD_DESKTOP_RE_PLAN.md` — desktop-shell gap analysis from Discord install analysis
- `README.md` — project overview
- `PLAN.md` — high-level Jorcord roadmap
- `docs/PARITY.md` — Discord-versus-Jorcard feature gap analysis
- `docs/CONTRACT.md` — API contract
- `docs/PLATFORMS.md` — desktop and mobile platform specs
- Everything else is the Jorcord codebase itself.

The `README_MODE.md` you just added documents how to configure the model switch **outside** this repo. Commit it if you want, or add the `.claude/settings.json` to your own machine.

## Committing to this repo

If you want `README_MODE.md` version‑controlled in this repo, I can add and commit it. The actual `settings.json` must live in your personal Claude config directory, not here.

To commit `README_MODE.md` to the Jorcord repo:

```bash
cd /c/Users/User/Desktop/Jorcord
git add README_MODE.md
git commit -m "docs: add Claude mode-switch documentation"
git push
```

But note: the settings file itself still belongs in `~/.claude/settings.json`, not in this repo.