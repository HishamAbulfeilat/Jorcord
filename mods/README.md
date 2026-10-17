# Claude mods

## agent-deck
Live view of your Claude agents and usage: a line above the prompt (context bar, tokens, cache hit rate, cost, running agents),
an Agent Deck pane (`/deck`), `/tokens` summary, alerts at 75%/90% context, long-running agent and token-spike warnings, and tips when a tool returns a huge output.
It only observes events; it never blocks or rewrites a call. If your surface cannot draw a pane, `/deck` prints the same data as text and the status line shows context use.

Install (in a terminal Claude Code session, any machine):
```
/plugin install agent-deck --marketplace HishamAbulfeilat/Jorcord
```
Answer `y` to add the marketplace, then pick the user scope. Develop locally with `claude --plugin-dir mods/agent-deck`.
Check it: `claude plugin validate mods/agent-deck` and `claude plugin test mods/agent-deck`.
