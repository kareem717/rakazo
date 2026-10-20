# Use a Cursor plan for Rakazo agents

Cursor is an optional main-agent provider, available through the same backend on web,
Electron, and mobile. It is separate from [delegated cloud coding agents](./cloud-agents.md).

1. Create a **user API key** in [Cursor's dashboard](https://cursor.com/dashboard/api).
2. Open **Settings → Models**, search for **Cursor**, and enter the key.
3. Test the key, connect **Composer 2.5**, and select it as the space default or a bot's model.

The key uses Rakazo's existing encrypted, account-scoped model connection storage. No CLI
installation or additional environment variable is needed. API and worker need outbound
access to Cursor. Keep keys out of chat messages and repository files.

[Cursor's SDK](https://cursor.com/docs/sdk/typescript) bills user keys to the user's plan;
its usage allowances, model availability, and overage rules apply. Service-account keys
bill to their owning team. This connection does not provide unlimited model usage.

## Execution

The SDK runs on the backend. Its built-in shell, filesystem tools, web tools, and native
subagents are unavailable. Only Rakazo's tools are exposed, with their existing schemas,
credential redaction, approval rules, user-choice pauses, routes, and tool-call limits.
Rakazo helpers use the same restricted tool path. Cursor's ambient user, project, plugin,
and team settings are not loaded. Each turn uses a private temporary workspace and SDK
store, removed when the turn closes; the bot computer stays behind Rakazo's executor.

Cursor runs its own agent loop. Rakazo supplies bot instructions and conversation context
alongside the current request; it does not replace Cursor's system prompt, which requires
separate account access. Cursor manages its own context and token limits. Rakazo's Pi
context-selection strategies and automatic backup switching do not apply to this runtime.
A failed SDK run fails the Rakazo turn instead of silently rerunning tool effects on a
backup. Changing to another configured main model remains available. Callers requiring
per-model-call budget reservations fail before contacting Cursor because its SDK does not
expose that hook.

Token usage is recorded when Cursor reports it. Dollar cost stays unknown rather than
being reported as free. The offline tests use a scripted SDK transport; a real account
connection must be tested separately using the settings screen.
