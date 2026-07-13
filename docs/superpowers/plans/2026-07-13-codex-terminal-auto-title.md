# Codex Terminal Auto Title Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Codex CLI の通常起動と `codex resume` を Para Code 側で厳密に識別し、最初のユーザープロンプトから生成した短いタイトルを、その Codex が動くターミナルタブだけへ自動設定する。

**Architecture:** ターミナルの信頼済みコマンド検出と Codex の UUID 形式 OSC タイトルを組み合わせて対象を fail-closed で識別する。Codex のローカル状態は shared process の読み取り専用サービスから取得し、表示タイトルは永続化されない所有者付き transient title として適用する。手動リネーム、Codex `/rename`、プロセス再起動を検知したら transient title を解除する。

**Tech Stack:** TypeScript, VS Code workbench/terminal services, shared-process IPC, Node `node:sqlite`

## Global Constraints

- Codex 本体と Codex App Server は変更・起動しない。
- `codex exec`、`app-server`、信頼できないコマンドライン、UUID を確認できないターミナルは変更しない。
- Claude、Copilot、Gemini、通常シェルのターミナルタイトルへ影響させない。
- 既存のユーザー変更を保持し、今回のファイルだけをコミットする。
- ユーザー指示に従い、テストコマンドは実行しない。型・差分・対象ファイルの静的確認を行う。

---

### Task 1: 永続化されない transient terminal title を追加する

**Files:**

- Modify: `src/vs/workbench/contrib/terminal/browser/terminal.ts`
- Modify: `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts`
- Modify: `src/vs/workbench/contrib/terminal/browser/terminalLabelComputer.ts`
- Modify: `src/vs/workbench/contrib/terminal/browser/terminalService.ts`
- Modify: ターミナルエディターのシリアライズ処理（探索で特定）
- Test: 既存 terminal label/instance test の適切なファイル

**Interfaces:**

```ts
interface ITerminalInstance {
	readonly transientTitle: string | undefined;
	setTransientTitle(owner: string, title: string, expectedSequence: string): boolean;
	clearTransientTitle(owner: string): void;
}
```

**Checklist:**

1. transient title は `staticTitle` より低く、通常の sequence/process title より高い優先度にする。
2. 設定時に現在の sequence が `expectedSequence` と一致することを確認する。
3. 別の sequence、API rename、再起動、終了時に解除する。
4. 所有者が一致する場合だけ解除できるようにする。
5. terminal backend/editor の永続化対象から除外する。

### Task 2: Codex 状態の読み取り専用 shared-process サービスを追加する

**Files:**

- Modify: `src/vs/paradis/contrib/codexTerminalTitle/common/paradisCodexTerminalTitle.ts`
- Create: `src/vs/paradis/contrib/codexTerminalTitle/node/paradisCodexTerminalTitleChannel.ts`
- Modify: `src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts`
- Test: `src/vs/paradis/contrib/codexTerminalTitle/test/node/paradisCodexTerminalTitleChannel.test.ts`

**IPC contract:**

```ts
interface IParadisCodexThreadPromptRequest {
	readonly threadId: string;
	readonly cwd: string;
}

interface IParadisCodexThreadPromptResult {
	readonly prompt: string;
}
```

**Checklist:**

1. canonical UUID と絶対 cwd 以外は拒否する。
2. `CODEX_HOME` または `~/.codex` 配下の最新 `state_*.sqlite` を `readOnly: true` で開く。
3. schema を確認してから exact UUID、CLI source、cwd 一致で検索する。
4. `first_user_message`、`preview`、安全な rollout JSONL の順に最初のユーザー入力を取得する。
5. JSONL は Codex home 配下の実在ファイルだけを開き、環境コンテキスト等の擬似ユーザー入力を除外する。
6. 不一致・不明・例外時は空結果を返し、ターミナル側を変更しない。

### Task 3: Codex 実行を厳密に追跡する controller を追加する

**Files:**

- Modify: `src/vs/paradis/contrib/codexTerminalTitle/electron-browser/paradisCodexTerminalTitle.contribution.ts`
- Modify: `src/vs/paradis/paradis.electron-browser.contribution.ts`（必要な場合のみ）
- Test: `src/vs/paradis/contrib/codexTerminalTitle/test/electron-browser/paradisCodexTerminalTitle.contribution.test.ts`

**State:**

```ts
interface ICodexRunState {
	readonly generation: number;
	readonly commandId: string | undefined;
	readonly processId: number | undefined;
	readonly cwd: string;
	threadId?: string;
	expectedSequence?: string;
}
```

**Checklist:**

1. `CommandDetection` の trusted/high-confidence/non-replayed command だけを採用する。
2. argv と shell quoting を考慮し、通常 TUI の `codex` と `codex resume` だけを候補にする。
3. `codex exec`、`app-server`、シェル連結、alias/wrapper の曖昧ケースを除外する。
4. 候補実行後に同一ターミナルから `codex | <canonical UUID>` が届いた場合だけ確定する。
5. process id、command id、generation、cwd、UUID、sequence を非同期処理の各境界で再検証する。
6. prompt から短い安全なフォールバックタイトルを作成し、transient title として適用する。
7. 新しい command、終了、再起動、手動 rename、別 sequence で run state と title を解除する。

### Task 4: 設定・既存機能との統合を整える

**Files:**

- Modify: `src/vs/paradis/contrib/codexTerminalTitle/browser/paradisCodexTerminalTitleSettings.contribution.ts`
- Modify: `src/vs/paradis/contrib/codexTerminalTitle/common/paradisCodexTerminalTitle.ts`
- Modify: `src/vs/paradis/contrib/codexTerminalTitle/electron-browser/paradisCodexTerminalTitle.contribution.ts`

**Checklist:**

1. 既存の `[tui].terminal_title = ["app-name", "thread-title"]` 設定を UUID 検証用シグナルとして維持する。
2. `paradis.codex.terminalTitle.enabled` が false の場合は監視・設定更新とも行わない。
3. `terminal.integrated.tabs.allowAgentCliTitle` が false の場合は適用しない。
4. 無効化時に Para Code 所有の transient title を解除する。

### Task 5: 自己レビューとコミット

**Files:**

- Review: 今回変更した全ファイル

**Checklist:**

1. `git diff --check` で空白エラーを確認する。
2. 対象ファイルの差分を通読し、Codex 以外へ到達する経路、永続化、race、手動 rename 優先を確認する。
3. placeholder、不要なログ、秘密情報、広すぎる catch、未使用 import を確認する。
4. テストコマンドを実行していないことを明記する。
5. 今回分だけを stage し、1コミットにまとめる。
