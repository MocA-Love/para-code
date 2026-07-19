# Codex Account Deduplication and Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codexアカウント追加時に同一 `account_id` を警告し、`~/.codex-2` 以降の追加ホームをOSのゴミ箱へ安全に移動できるようにする。

**Architecture:** shared processが認証ファイルを読み、機密IDをrendererへ出さずに重複情報と削除可否を計算する。rendererは削除直前にshared processの厳格なパス検証を通し、既存のVS Codeファイルサービスへ `useTrash: true` で移動を委譲する。既存のセットアップ状態ポーリングを拡張し、重複時だけユーザー判断を待つ。

**Tech Stack:** TypeScript、VS Code IPC/DI、Electron file service、DOM/Codicon、CSS theme tokens

## Global Constraints

- Claudeアカウントの動作は変更しない。
- `~/.codex` と外部Codexホームは削除不可とする。
- 削除はOSのゴミ箱だけを使い、失敗時に完全削除へ切り替えない。
- 同一性は空でない `tokens.account_id` の完全一致だけで判定し、メールアドレスへフォールバックしない。
- 生の `account_id` と認証トークンをrendererへ渡さない。
- ユーザー向け文字列は `localize()` を使う。
- UIの色はテーマトークン、削除アイコンは密な行の副次操作としてcompactサイズを使う。
- プロジェクト指示によりテストの追加・実行は行わない。必須のTypeScript型チェックと差分検査だけを行う。

---

## File Structure

- `src/vs/paradis/contrib/limitsMonitor/common/paradisLimitsMonitor.ts`: renderer/shared process間の重複・削除・セットアップ状態の共有型。
- `src/vs/paradis/contrib/limitsMonitor/node/paradisLimitsMonitorChannel.ts`: `account_id` の読み取り、重複集約、削除パス検証、セットアップ判断、IPC。
- `src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsMonitorClient.ts`: IPCとファイルサービスを組み合わせたゴミ箱移動API。
- `src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsSetupDialog.ts`: 追加時の重複警告と破棄・継続操作。
- `src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsMonitorWidget.ts`: 既存カード削除の確認、実行、通知、再取得。
- `src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsMonitorPanel.ts`: 重複バッジと削除ボタン。
- `src/vs/paradis/contrib/limitsMonitor/electron-browser/media/paradisLimitsMonitor.css`: 副次操作、警告、重複確認の見た目。

### Task 1: 共有型とバックエンドのアカウント集約

**Files:**
- Modify: `src/vs/paradis/contrib/limitsMonitor/common/paradisLimitsMonitor.ts`
- Modify: `src/vs/paradis/contrib/limitsMonitor/node/paradisLimitsMonitorChannel.ts`

**Interfaces:**
- Produces: `IParadisLimitsAccount.removable`, `IParadisLimitsAccount.duplicateHomeLabels`
- Produces: `ParadisLimitsSetupPhase` の `waiting_duplicate`
- Produces: `IParadisLimitsSetupState.homePath`, `duplicateHomeLabels`

- [ ] **Step 1: 共有型を拡張する**

```ts
export interface IParadisLimitsAccount {
	// existing fields
	readonly removable?: boolean;
	readonly duplicateHomeLabels?: readonly string[];
}

export type ParadisLimitsSetupPhase =
	| 'starting'
	| 'waiting_browser'
	| 'waiting_code'
	| 'registering'
	| 'waiting_duplicate'
	| 'done'
	| 'error';

export interface IParadisLimitsSetupState {
	// existing fields
	readonly homePath?: string;
	readonly duplicateHomeLabels?: readonly string[];
}

export type ParadisLimitsDuplicateDecision = 'keep' | 'discard';

export interface IParadisLimitsCodexRemovalTarget {
	readonly homePath: string;
}
```

- [ ] **Step 2: バックエンド内部だけの取得結果型を追加する**

```ts
interface ICodexAccountResult {
	readonly account: IParadisLimitsAccount;
	readonly accountId?: string;
}
```

`fetchCodexAccount()` はこの型を返し、`auth.tokens.account_id` が空でない場合だけ `accountId` に保持する。rendererへ返す `account` には含めない。

- [ ] **Step 3: 削除可能ホームの構文・ファイル種別を判定する**

```ts
private async isRemovableCodexHome(homePath: string): Promise<boolean> {
	try {
		const resolvedHome = path.resolve(os.homedir());
		const resolvedCandidate = path.resolve(homePath);
		if (path.dirname(resolvedCandidate) !== resolvedHome) {
			return false;
		}
		const match = /^\.codex-(\d+)$/.exec(path.basename(resolvedCandidate));
		const index = match ? Number(match[1]) : NaN;
		if (!Number.isSafeInteger(index) || index < 2 || String(index) !== match?.[1]) {
			return false;
		}
		const stat = await fs.promises.lstat(resolvedCandidate);
		return stat.isDirectory() && !stat.isSymbolicLink() && await this.fileExists(path.join(resolvedCandidate, 'auth.json'));
	} catch {
		return false;
	}
}
```

- [ ] **Step 4: 同じIDの全カードへ重複情報を付ける**

`fetchCodexAccounts()` で `ICodexAccountResult[]` を取得し、空でない `accountId` ごとにグループ化する。2件以上のグループでは各カードへ、自分以外の `homeLabel` を並べた `duplicateHomeLabels` をコピーする。`removable` は各ホームに対する `isRemovableCodexHome()` の結果とする。

- [ ] **Step 5: Task 1の差分を検査してコミットする**

```bash
git diff --check -- src/vs/paradis/contrib/limitsMonitor/common/paradisLimitsMonitor.ts src/vs/paradis/contrib/limitsMonitor/node/paradisLimitsMonitorChannel.ts
git add -- src/vs/paradis/contrib/limitsMonitor/common/paradisLimitsMonitor.ts src/vs/paradis/contrib/limitsMonitor/node/paradisLimitsMonitorChannel.ts
git commit -m "para: detect duplicate Codex accounts"
```

### Task 2: 重複追加の判断と削除対象検証IPC

**Files:**
- Modify: `src/vs/paradis/contrib/limitsMonitor/node/paradisLimitsMonitorChannel.ts`
- Modify: `src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsMonitorClient.ts`

**Interfaces:**
- Consumes: `ParadisLimitsDuplicateDecision`, `IParadisLimitsCodexRemovalTarget`
- Produces: `resolveCodexDuplicate(sessionId, decision)`
- Produces: `validateCodexHomeRemoval(homePath)`
- Produces: `ParadisLimitsMonitorClient.moveCodexHomeToTrash(homePath)`

- [ ] **Step 1: セットアップセッションへ新規Codexホームを保持する**

```ts
interface ISetupSession {
	// existing fields
	codexHomePath?: string;
}
```

新規ログイン成功時に、新しい `auth.json` の空でない `account_id` と、他の発見済みホームのIDを比較する。一致時は次の状態にして、`done` に進めない。

```ts
session.codexHomePath = homePath;
session.state = {
	...session.state,
	phase: 'waiting_duplicate',
	email,
	homePath,
	duplicateHomeLabels,
};
```

再ログインでは新規ホームを作らないため、この重複確認を行わない。

- [ ] **Step 2: 重複判断を解決するサービスメソッドを追加する**

```ts
resolveCodexDuplicate(sessionId: string, decision: ParadisLimitsDuplicateDecision): void {
	const session = this.setupSessions.get(sessionId);
	if (!session || session.state.phase !== 'waiting_duplicate' || !session.codexHomePath) {
		throw new Error('setup session is not waiting for a duplicate-account decision');
	}
	if (decision === 'discard' && fs.existsSync(session.codexHomePath)) {
		throw new Error('Codex home must be moved to the trash before discarding the duplicate account');
	}
	if (decision !== 'keep' && decision !== 'discard') {
		throw new Error('invalid duplicate-account decision');
	}
	this.snapshotCache = undefined;
	session.state = { ...session.state, phase: 'done' };
	this.scheduleSetupCleanup(session);
}
```

- [ ] **Step 3: 削除直前の厳格な検証APIを追加する**

`validateCodexHomeRemoval(homePath)` は文字列長と絶対パスを検査し、`isRemovableCodexHome()` に通った正規化パスだけを返す。`discoverCodexHomes(undefined)` に現在含まれないホームは拒否する。

```ts
async validateCodexHomeRemoval(homePath: string): Promise<IParadisLimitsCodexRemovalTarget> {
	if (typeof homePath !== 'string' || homePath.length === 0 || homePath.length > 4096 || !path.isAbsolute(homePath)) {
		throw new Error('invalid Codex home path');
	}
	const resolved = path.resolve(homePath);
	const knownHomes = await this.discoverCodexHomes(undefined);
	if (!knownHomes.includes(resolved) || !await this.isRemovableCodexHome(resolved)) {
		throw new Error('Codex home is not removable');
	}
	return { homePath: resolved };
}
```

- [ ] **Step 4: IPCとrendererクライアントを追加する**

`ParadisLimitsMonitorChannel.call()` に `resolveCodexDuplicate` と `validateCodexHomeRemoval` を追加する。クライアントは `IFileService` をDIし、検証済みURIだけをゴミ箱へ移動する。

```ts
async moveCodexHomeToTrash(homePath: string): Promise<void> {
	const target = await this.channel.call<IParadisLimitsCodexRemovalTarget>('validateCodexHomeRemoval', [homePath]);
	await this.fileService.del(URI.file(target.homePath), { recursive: true, useTrash: true });
}

resolveCodexDuplicate(sessionId: string, decision: ParadisLimitsDuplicateDecision): Promise<void> {
	return this.channel.call<void>('resolveCodexDuplicate', [sessionId, decision]);
}
```

- [ ] **Step 5: Task 2の差分を検査してコミットする**

```bash
git diff --check -- src/vs/paradis/contrib/limitsMonitor/node/paradisLimitsMonitorChannel.ts src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsMonitorClient.ts
git add -- src/vs/paradis/contrib/limitsMonitor/node/paradisLimitsMonitorChannel.ts src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsMonitorClient.ts
git commit -m "para: guard Codex account removal"
```

### Task 3: 重複警告UI

**Files:**
- Modify: `src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsSetupDialog.ts`
- Modify: `src/vs/paradis/contrib/limitsMonitor/electron-browser/media/paradisLimitsMonitor.css`

**Interfaces:**
- Consumes: `waiting_duplicate`, `homePath`, `duplicateHomeLabels`
- Consumes: `moveCodexHomeToTrash()`, `resolveCodexDuplicate()`

- [ ] **Step 1: セットアップダイアログに重複警告領域と継続ボタンを追加する**

`pls-duplicate` は通常非表示とし、`waiting_duplicate` のときだけメール、既存ホーム、新規ホーム、重複理由を表示する。既存footerには `それでも追加` ボタンを追加し、通常phaseでは非表示にする。

- [ ] **Step 2: 重複を破棄する処理を追加する**

```ts
private async discardDuplicate(): Promise<void> {
	if (!this.sessionId || !this.latestState.homePath || this.resolvingDuplicate) {
		return;
	}
	this.setDuplicateResolving(true);
	try {
		await this.client.moveCodexHomeToTrash(this.latestState.homePath);
		await this.client.resolveCodexDuplicate(this.sessionId, 'discard');
		await this.pollState();
	} catch (error) {
		this.setDuplicateResolving(false);
		this.showError((error as Error).message);
	}
}
```

- [ ] **Step 3: 重複を許可する処理と終了処理を追加する**

`keepDuplicate()` は `resolveCodexDuplicate(sessionId, 'keep')` を1回だけ呼ぶ。Escapeまたはキャンセルで `waiting_duplicate` を閉じた場合は新規ホームを残し、`onClose(true)` でリミット一覧を再取得させる。

- [ ] **Step 4: 警告UIを既存ダイアログの階層へ合わせる**

`pls-duplicate` は内側コンテナとしてtheme tokenを使い、ボタン・余白・角丸は既存のControl/Inner tierとspacing rampに合わせる。固定hex色を追加しない。処理中は両判断ボタンを無効化する。

- [ ] **Step 5: Task 3の差分を検査してコミットする**

```bash
git diff --check -- src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsSetupDialog.ts src/vs/paradis/contrib/limitsMonitor/electron-browser/media/paradisLimitsMonitor.css
git add -- src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsSetupDialog.ts src/vs/paradis/contrib/limitsMonitor/electron-browser/media/paradisLimitsMonitor.css
git commit -m "para: warn before adding duplicate Codex accounts"
```

### Task 4: 既存カードの重複表示と削除操作

**Files:**
- Modify: `src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsMonitorPanel.ts`
- Modify: `src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsMonitorWidget.ts`
- Modify: `src/vs/paradis/contrib/limitsMonitor/electron-browser/media/paradisLimitsMonitor.css`

**Interfaces:**
- Consumes: `IParadisLimitsAccount.removable`, `duplicateHomeLabels`
- Consumes: `ParadisLimitsMonitorClient.moveCodexHomeToTrash()`
- Produces: `IParadisLimitsMonitorPanelOptions.onRemoveAccount`

- [ ] **Step 1: カード上部の副次操作領域を作る**

`plm-account-actions` にリセット時刻と削除ボタンをまとめ、右端に配置する。削除ボタンは `account.provider === 'codex' && account.removable` の場合だけ作り、Codicon.trash、aria-label、managed hoverを付ける。

- [ ] **Step 2: 重複バッジを追加する**

`duplicateHomeLabels` が空でなければ `重複` バッジを表示する。managed hoverには `同じアカウント: {0}` として他ホームを列挙する。エラー状態のカードにもバッジと削除操作を残す。

- [ ] **Step 3: Widgetで削除確認と実行を行う**

`IDialogService` と `INotificationService` をWidgetへDIし、確認後だけ移動する。

```ts
private async removeAccount(account: IParadisLimitsAccount): Promise<void> {
	const { confirmed } = await this.dialogService.confirm({
		message: localize('paradis.limitsMonitor.removeConfirm', "このCodexアカウントを削除しますか？"),
		detail: localize('paradis.limitsMonitor.removeDetail', "{0} ({1}) の認証情報、設定、セッション履歴を含むホーム全体をゴミ箱へ移動します。利用中のCodexプロセスに影響する可能性があります。", account.email ?? localize('paradis.limitsMonitor.unknownAccount', "不明なアカウント"), account.homeLabel ?? account.id),
		primaryButton: localize('paradis.limitsMonitor.moveToTrash', "ゴミ箱へ移動"),
	});
	if (!confirmed) {
		return;
	}
	try {
		await this.client.moveCodexHomeToTrash(account.id);
		await this.poll(true);
	} catch (error) {
		this.notificationService.error(localize('paradis.limitsMonitor.removeFailed', "Codexアカウントをゴミ箱へ移動できませんでした: {0}", (error as Error).message));
	}
}
```

- [ ] **Step 4: 削除操作をquiet-at-restで整える**

削除ボタンは透明背景・compact iconとし、hover/focus-visible時だけtoolbar hover backgroundとfocus borderを出す。重複バッジは既存のerror badgeより弱い警告トークンを使い、利用率表示より強く主張させない。

- [ ] **Step 5: Task 4の差分を検査してコミットする**

```bash
git diff --check -- src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsMonitorPanel.ts src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsMonitorWidget.ts src/vs/paradis/contrib/limitsMonitor/electron-browser/media/paradisLimitsMonitor.css
git add -- src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsMonitorPanel.ts src/vs/paradis/contrib/limitsMonitor/electron-browser/paradisLimitsMonitorWidget.ts src/vs/paradis/contrib/limitsMonitor/electron-browser/media/paradisLimitsMonitor.css
git commit -m "para: remove additional Codex accounts from limits monitor"
```

### Task 5: 型チェック、自己レビュー、プッシュ

**Files:**
- Review: all files changed by Tasks 1-4

- [ ] **Step 1: 必須のTypeScript型チェックを実行する**

```bash
npm run typecheck-client
```

Expected: exit code 0。テストコマンドは実行しない。

- [ ] **Step 2: 差分の機械検査を行う**

```bash
git diff HEAD~4 --check
git status --short
```

Expected: whitespace errorなし。既存の未追跡ファイルは変更・追加しない。

- [ ] **Step 3: セキュリティと品質の自己レビューを行う**

削除対象が標準ホーム・外部パス・symlinkへ広がらないこと、生のIDやtokenがrenderer・ログへ出ないこと、ゴミ箱失敗時に完全削除しないこと、重複phaseで連打できないこと、Claudeフローへ分岐漏れがないことを差分単位で確認する。

- [ ] **Step 4: 自己レビュー修正をコミットする**

修正がある場合だけ対象ファイルを明示してstageし、次でコミットする。

```bash
git commit -m "para: harden Codex account management"
```

- [ ] **Step 5: 現在のブランチをpushする**

```bash
git push origin main
```

Expected: design commitと実装commitが`origin/main`へ送信される。
