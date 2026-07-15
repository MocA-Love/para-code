# Terminal TUI and Agent Hook Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 実行中TUIのDownArrowを奪わず、Para Code外の大容量agent hook stdinでもBroken pipeを起こさない。

**Architecture:** terminal suggestの適格性をlive prompt stateとcommand execution stateから計算する純粋関数へ分離する。agent hookは全経路でstdin ownershipを完遂し、schema 2と4 MiBのbodyless fallbackで旧版競合と大容量入力を安全に扱う。

**Tech Stack:** TypeScript、VS Code terminal capabilities/context keys、POSIX sh、PowerShell、Node.js HTTP、Mocha

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-07-15-terminal-tui-hook-reliability-design.md`
- 現在のmainで作業し、worktreeを作成しない。
- 既存の未コミットファイルへ触れない。
- コマンド名ではなくprompt stateとforeground command stateで判定する。
- hookはstdinをEOFまで消費し、Agent CLI本体へ失敗を返さない。
- HTTP body上限4 MiBを引き上げない。
- TDDで各不具合のREDを確認してからproduction codeを書く。
- 各Task後に差分レビューと関連テストを行う。
- pushしない。

---

### Task 1: 実行中TUIからDownArrowを奪わない

**Files:**
- Create: `src/vs/paradis/contrib/terminalHistorySuggest/common/paradisTerminalSuggestEligibility.ts`
- Create: `src/vs/paradis/contrib/terminalHistorySuggest/test/common/paradisTerminalSuggestEligibility.test.ts`
- Modify: `src/vs/paradis/contrib/terminalHistorySuggest/browser/paradisTerminalSuggestDownKey.contribution.ts`

**Interfaces:**
- Produces: `paradisIsTerminalPromptSuggestEligible(model, executingCommand): boolean`
- Consumes: `IPromptInputModel.state/value/ghostTextIndex`、`ICommandDetectionCapability.executingCommand`

- [x] **Step 1: Execute状態とforeground commandを拒否する失敗テストを書く**

```ts
assert.strictEqual(paradisIsTerminalPromptSuggestEligible({
	state: PromptInputState.Execute,
	value: 'codex',
	ghostTextIndex: -1,
}, undefined), false);
assert.strictEqual(paradisIsTerminalPromptSuggestEligible({
	state: PromptInputState.Input,
	value: 'codex',
	ghostTextIndex: -1,
}, 'codex'), false);
```

- [x] **Step 2: REDを確認する**

Run: `npm run compile && npm run test-node -- --run src/vs/paradis/contrib/terminalHistorySuggest/test/common/paradisTerminalSuggestEligibility.test.ts`

Expected: eligibility moduleが存在しないためcompileまたはtestがFAIL。

- [x] **Step 3: 最小の共通判定を実装し、contributionをlive model参照へ変更する**

```ts
export function paradisIsTerminalPromptSuggestEligible(
	model: Pick<IPromptInputModel, 'state' | 'value' | 'ghostTextIndex'>,
	executingCommand: string | undefined,
): boolean {
	if (model.state !== PromptInputState.Input || executingCommand !== undefined) {
		return false;
	}
	const value = model.ghostTextIndex === -1 ? model.value : model.value.substring(0, model.ghostTextIndex);
	return value.trim().length > 0;
}
```

`onDidStartInput`、`onDidChangeInput`、`onDidFinishInput`、`onCommandExecuted`、`onCommandFinished`から同じ`_update(commandDetection)`を呼び、snapshotではなく`commandDetection.promptInputModel`を評価する。

- [x] **Step 4: GREENと関連回帰を確認する**

Run: `npm run compile && npm run test-node -- --run src/vs/paradis/contrib/terminalHistorySuggest/test/common/paradisTerminalSuggestEligibility.test.ts`

Expected: 対象suiteが全件PASS。

- [x] **Step 5: Task 1を自己レビューする**

Execute中の非空commandでfalse、次のInputでtrue、ghost textのみでfalse、capability除去でcontext keyがfalseになることを確認する。

### Task 2: Agent hook stdinを全経路で完遂する

**Files:**
- Modify: `src/vs/paradis/contrib/agentBrowser/common/paradisAgentHooks.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentHooksSetup.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentBrowserService.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/test/node/paradisAgentHooksSetup.test.ts`

**Interfaces:**
- Produces: `PARADIS_AGENT_HOOK_MAX_BODY_BYTES = 4 * 1024 * 1024`
- Changes: `PARADIS_AGENT_HOOK_SCHEMA_VERSION`を`2`へ更新
- Preserves: 小容量payloadのraw POST、既存ユーザーhook、HTTP受信上限

- [x] **Step 1: 大容量inactive stdin、schema移行、oversize fallbackの失敗テストを書く**

生成scriptを一時ファイルへ書き、`bash -o pipefail`から8 MiB payloadをpipeして、環境変数なしでも終了コード0を要求する。schema 1コマンドをマージしてschema 2へ置換されること、有効な4 MiB超payloadがGET・body 0でlocal HTTP serverへ届くことも要求する。

- [x] **Step 2: REDを確認する**

Run: `npm run compile && npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisAgentHooksSetup.test.ts`

Expected: inactive pipelineがSIGPIPE、schemaが1、oversize requestがPOSTのためFAIL。

- [x] **Step 3: schema 2、stdin drain、size-aware deliveryを実装する**

POSIX scriptは無効経路でargvがない場合に`cat >/dev/null`を実行する。有効経路は`umask 077`、`mktemp`、trap cleanupを使い、最大4 MiB + 1 byteだけ保存して残りをdrainする。本文サイズが共通上限以下なら`curl --data-binary @file`、超過ならGETを使う。PowerShellもbuffer単位でstdinを読み切り、最大4 MiB + 1 byteのUTF-8 bytesだけを保持してPOST/GETを切り替える。

- [x] **Step 4: GREENと関連回帰を確認する**

Run: `npm run compile && npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisAgentHooksSetup.test.ts`

Expected: 対象suiteが全件PASS。

- [x] **Step 5: Task 2を自己レビューする**

すべての早期終了がstdin ownershipを完遂すること、temp fileが0600相当で削除されること、4 MiB定数がscript/serverで一致すること、future-schema保護とユーザーhook保持が維持されることを確認する。

### Task 3: 全体検証とコミット

**Files:**
- Review: Task 1、Task 2、設計書、計画書の全変更

**Interfaces:**
- Produces: 2件の独立したreviewed commit

- [x] **Step 1: 変更ファイルと差分をレビューする**

Run: `git diff --name-only HEAD`、`git diff --check`、`git diff -- <対象ファイル>`

- [x] **Step 2: 型、lint、対象テストをfresh実行する**

Run: `npm run compile`、対象node test 2 suite、変更TypeScriptファイルへのeslint。

- [x] **Step 3: Task 1をコミットする**

`git add`にはterminalHistorySuggestの実装・テストと本設計/計画だけを明示し、`git commit -m "fix: keep terminal suggestions out of running commands"`を実行する。

- [x] **Step 4: Task 2をコミットする**

agentBrowserの実装・テストだけを明示し、`git commit -m "fix: drain agent hook input before exiting"`を実行する。

- [x] **Step 5: commit内容とworktree残差を確認する**

Run: `git show --stat --oneline HEAD~1..HEAD`、`git status --short`。既存の未コミットファイルだけが残っていることを確認する。
