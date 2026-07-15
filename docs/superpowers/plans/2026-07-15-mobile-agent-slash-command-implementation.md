# Mobile Agent Slash Command Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** エージェント詳細の入力欄でClaude Code/Codexのスラッシュコマンドとスキル候補をLiquid Glass表示し、どちらも`/`から絞り込み・挿入・実行できるようにする。

**Architecture:** PC側のmobile relayがプロバイダー別の組み込みコマンドと固定設定ディレクトリのカスタム項目を正規化し、セッション検証付き`command-catalog`フレームでモバイルへ返す。モバイルはIMEを保護したuncontrolled TextInputを維持し、純粋関数で先頭トークンを検知・絞り込みして、既存`GlassSurface`上に候補を描画する。

**Tech Stack:** TypeScript, VS Code shared process, React Native, Expo Glass Effect, Zustand, Vitest, Mocha

## Global Constraints

- Claude CodeとCodexの両方を対象にする。
- 候補面は既存モデルセレクターと同じ`GlassSurface`系統を使う。
- モバイルからファイルパスを指定させない。
- TextInputをcontrolledへ変更しない。
- 既存の未コミット変更と`.serena/`を変更・ステージしない。
- ワークツリーを作らない。

---

### Task 1: Composer Slash Detection

**Files:**
- Create: `app/mobile/src/components/agentSlashCommands.test.ts`
- Create: `app/mobile/src/components/agentSlashCommands.ts`

**Interfaces:**
- Produces: `agentSlashQuery(text: string): string | undefined`, `filterAgentSlashCommands(commands, query, limit)`, `selectedAgentSlashCommandText(command)`, `normalizeAgentSlashSubmission(text, agent, commands)`

- [ ] **Step 1: Write failing tests** for exact leading-token detection, case-insensitive prefix filtering, stable ordering, selected insertion text, and catalog-verified Codex skill conversion from `/name` to `$name`.
- [ ] **Step 2: Run** `pnpm --dir app/mobile test -- agentSlashCommands.test.ts` and confirm failure because the module is absent.
- [ ] **Step 3: Implement** the three pure functions with no React Native dependency.
- [ ] **Step 4: Re-run** the focused test and confirm it passes.

### Task 2: Provider Catalog Builder

**Files:**
- Create: `src/vs/paradis/contrib/mobileRelay/test/node/paradisAgentCommandCatalog.test.ts`
- Create: `src/vs/paradis/contrib/mobileRelay/node/paradisAgentCommandCatalog.ts`

**Interfaces:**
- Produces: `IParadisAgentCommandOption`, `paradisBuildAgentCommandCatalog(agent, cwd, options?)`
- Consumes: PC-derived agent kind and cwd only.

- [ ] **Step 1: Write failing tests** using temporary user/project directories for Claude skills/commands and Codex prompts/skills, including front matter, hidden items, precedence, nested command names, and bounds.
- [ ] **Step 2: Run** the focused mobile relay test and confirm failure because the module is absent.
- [ ] **Step 3: Implement** provider built-ins, Claude and Codex skill roots, bounded Markdown metadata reads, project-parent discovery, validation, precedence, and a 200-item cap.
- [ ] **Step 4: Re-run** the focused test and confirm it passes.

### Task 3: Session-Validated Relay Protocol

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/test/node/paradisMobileAgentChat.test.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`

**Interfaces:**
- Consumes: inbound `{ t: 'command-catalog', id, token?, requestId }`.
- Produces: outbound `command-catalog` or `command-catalog-error` with the same request ID.

- [ ] **Step 1: Add failing inbound validation tests** for valid, missing-request-ID, and unexpected-shape requests.
- [ ] **Step 2: Run** the focused relay test and confirm the new request is rejected.
- [ ] **Step 3: Add protocol types, parser branch, dispatcher branch, and handler** that validates live subscription, pane owner, session and cwd before and after catalog construction.
- [ ] **Step 4: Re-run** the focused relay tests and confirm they pass.

### Task 4: Mobile Store Round Trip

**Files:**
- Modify: `app/mobile/src/store.test.ts`
- Modify: `app/mobile/src/store.ts`
- Modify: `app/mobile/src/appState.ts`

**Interfaces:**
- Produces: `AgentCommandCatalogState`, `requestAgentCommandCatalog(terminalKey)` and `AgentChatState.commandCatalog`.
- Consumes: relay candidates with `name`, `insertText`, `description`, `kind`, and `source`.

- [ ] **Step 1: Add failing store tests** for request framing, accepted response, stale response rejection, malformed item rejection, and timeout/error state.
- [ ] **Step 2: Run** the focused store tests and confirm failure due to the missing action/state.
- [ ] **Step 3: Implement** action forwarding, request ID/status state, a dedicated 15-second timer, response validation and session-epoch preservation.
- [ ] **Step 4: Re-run** the store tests and confirm they pass.

### Task 5: Liquid Glass Candidate UI

**Files:**
- Create: `app/mobile/src/components/agentSlashCommandMenu.tsx`
- Modify: `app/mobile/src/components/glassComposer.tsx`
- Modify: `app/mobile/src/components/agentComposer.tsx`
- Modify: `app/mobile/app/agent.tsx`

**Interfaces:**
- Consumes: `AgentCommandCatalogState`, query string, and command-selection callback.
- Produces: tappable anchored candidate panel rendered through `GlassSurface`.

- [ ] **Step 1: Extend the composer with selection/focus-safe callbacks** while keeping `defaultValue` and `setNativeProps` behavior unchanged.
- [ ] **Step 2: Add the menu component** with loading/error/empty states, accessibility labels, an eight-row display cap, and provider accent.
- [ ] **Step 3: Wire AgentComposer** to detect `/`, request once per session, filter live as text changes, replace the native input on selection, translate a catalog-verified Codex `/<skill>` to `$<skill>` only at submit time, and dismiss after selection or submit.
- [ ] **Step 4: Pass catalog state/action from the agent screen** using stable references.

### Task 6: Verification, Review, And Commit

**Files:**
- Review all task files plus the existing mock artifacts.

- [ ] **Step 1: Run** `pnpm --dir app/mobile typecheck` before test suites.
- [ ] **Step 2: Run** focused tests, then `pnpm --dir app/mobile test` and the focused mobile relay tests.
- [ ] **Step 3: Run** `npm run typecheck-client`.
- [ ] **Step 4: Inspect** `git diff --check`, `git diff --stat`, and the complete scoped diff using the code-review and security checklists.
- [ ] **Step 5: Fix findings and repeat affected verification.**
- [ ] **Step 6: Stage only** slash-command implementation, mock, spec, plan, and tests; exclude `.serena/` and unrelated files.
- [ ] **Step 7: Commit** with `feat: add mobile agent slash command catalog` and do not push.
