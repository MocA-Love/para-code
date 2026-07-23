<!-- PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md. -->

# Para Code Sentry

Sentry is split into two projects:

- `para-code-desktop`: Electron main, renderer, shared/utility process, and native minidumps
- `para-code-mobile`: Expo / React Native JavaScript, native crashes, app hangs, and app start

Desktop JavaScript events are accepted only when they are explicitly tagged `para.scope=owned` or
`para.scope=patched`, or when an automatic stack trace contains `vs/paradis`. Native minidumps are
retained as `para.scope=unknown` because a minidump cannot be reliably attributed to one TypeScript
module. Upstream-only VS Code JavaScript errors are dropped before transmission.

Useful issue filters:

```text
para.scope:owned
para.scope:patched
para.feature:codex-app-server
para.feature:terminal-environment
para.feature:terminal-preset
para.feature:agent-browser
para.feature:desktop-relay
```

Explicit diagnostics should go through `reportParadisDiagnosticError` on desktop and
`reportMobileDiagnosticError` on mobile. Do not pass paths, commands, prompts, URLs, credentials, or
terminal contents in `safeExtra`. The shared sanitizer removes user/request fields, non-allowlisted
extras, non-Para breadcrumbs, URL queries, user home directory names, and common credential forms.

Each process sends at most three copies of the same normalized error in a ten-minute window. Sentry
Spike Protection is also enabled on both projects.

Desktop release builds inject Debug IDs before integrity checksums and packaging, then upload the
unshipped maps from `out-vscode-min` under release `para-code@<version>+<commit>`. Mobile native
build scripts map the ignored repository-root `.env` value `SENTRY_PAT` to `SENTRY_AUTH_TOKEN` only
for the Expo child process so Hermes maps and native symbols can be uploaded without storing the
token in source or an artifact.
