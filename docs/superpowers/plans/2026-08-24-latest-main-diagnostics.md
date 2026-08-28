# Latest Main Diagnostics Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 最新の <code>origin/main</code>（監査基準 <code>8c5bd783f57008a6347eaa18ca8d3730983ba6b8</code>）で確定した #17、#19、#20、#21、#22 を、診断経路から利用者データを除きつつ重複・誤報を抑える回帰テスト付き修正として実装する。

**Architecture:** ドメイン側の reporter 契約は維持し、Sentry に渡る最後の境界だけを3プロセス共通の safe Error 変換で防御する。ブックマークとサービスステータスは発生地点でも固定 Error に置換し、サービスステータス、Browser Live、word separator はそれぞれ小さな状態機械または遅延 contribution に分離して純粋ロジックをテストする。

**Tech Stack:** TypeScript、Mocha、VS Code Node/Electron/browser unit test runners、<code>@sentry/electron</code>、Playwright Chromium、Git、GitHub CLI

**Spec:** docs/superpowers/specs/2026-08-24-regression-resource-mobile-audit-design.md

## Global Constraints

- 実装は <code>8c5bd783f57008a6347eaa18ca8d3730983ba6b8</code> 以降の最新 <code>origin/main</code> から、<code>superpowers:using-git-worktrees</code> で作った専用 worktree で行う。
- 各 issue は RED、最小実装、GREEN、独立コミットの順で進める。RED が期待した理由で落ちたことを確認せず製品コードへ進まない。
- <code>reportParadisDiagnosticError</code> と <code>configureParadisDiagnosticReporter</code> の契約は変えない。ドメイン test spy には、呼び出し元が渡した Error と同一オブジェクトを届ける。
- <code>toParadisSentrySafeError</code> は renderer、main、utility の各 adapter 内、<code>captureException</code> の直前だけで適用する。reporter 共通関数、rate limiter、<code>beforeSend</code> には移さない。元 Error の stack frame も filesystem path や任意の custom stack を含み得るため一切コピーしない。
- ブックマーク破損とサービスステータス取得失敗は、中央境界に依存せず発生地点から固定 Error を渡す。raw JSON、HTTP body、URL、ローカルパスを Error message や cause に含めない。
- サービスステータスは provider ごとに「失敗開始時だけ1件、失敗継続中は0件、成功後の再失敗で再び1件」とする。UI に返す既存の <code>unknown</code> entry と短縮済みローカル error 表示は変えない。
- Browser Live の backoff 用 <code>failures</code> は変えず、Sentry 判定だけを実際の screenshot capture failure 5回で数える。model 未解決は診断閾値へ加算しない。
- terminal word separator の default override 登録は module load 時のまま維持し、欠落診断だけを <code>WorkbenchPhase.AfterRestored</code> へ移す。
- 既存の未追跡 HTML、監査外コード、公開 API、UI copy、ポーリング間隔、retry/backoff 値には触れない。
- 編集には <code>apply_patch</code> を使う。formatter や一括修正で担当外ファイルを書き換えない。
- コマンドは repository root から実行し、すべて <code>rtk</code> を先頭に付ける。
- rebase で conflict が発生した場合は勝手に解消せず、対象ファイルと conflict 内容を報告して指示を待つ。

---

### Task 1: #17 Browser bookmark の破損ストレージ診断を固定 Error にする

**Files:**
- Modify: <code>src/vs/paradis/contrib/browserBookmarks/test/electron-browser/paradisBookmarksService.test.ts</code>
- Modify: <code>src/vs/paradis/contrib/browserBookmarks/electron-browser/paradisBookmarksService.ts</code>

**Interfaces:**
- Consumes: <code>configureParadisDiagnosticReporter(reporter: ParadisDiagnosticReporter): void</code>
- Preserves: 破損値の <code>paradis.browser.bookmarks.recoveryBackup</code> 退避、空配列への復旧、その後の保存
- Produces: <code>browser-bookmarks/storage-corrupt</code> が常に <code>Error("Browser bookmark storage could not be parsed")</code> を渡す site-level 契約

- [ ] **Step 1: raw bookmark 内容を reporter に渡さない failing test を追加する**

<code>paradisBookmarksService.test.ts</code> に import と次の test を追加する。

~~~ts
import { configureParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';

test('reports corrupt storage with a fixed error without exposing bookmark content', () => {
	const storedBookmarks = '{"title":"private-title","url":"file:///Users/alice/secret.ts",}';
	const reports: Array<{
		readonly scope: string;
		readonly feature: string;
		readonly operation: string;
		readonly error: unknown;
		readonly severity: string | undefined;
	}> = [];
	configureParadisDiagnosticReporter((scope, feature, operation, error, _safeExtra, severity) => {
		reports.push({ scope, feature, operation, error, severity });
	});

	try {
		const { service, storage } = createService(storedBookmarks);

		assert.deepStrictEqual(service.nodes, []);
		assert.strictEqual(
			storage.get(BOOKMARKS_STORAGE_RECOVERY_BACKUP_KEY, StorageScope.APPLICATION),
			storedBookmarks,
		);
		assert.deepStrictEqual(reports.map(report => ({
			scope: report.scope,
			feature: report.feature,
			operation: report.operation,
			name: report.error instanceof Error ? report.error.name : undefined,
			message: report.error instanceof Error ? report.error.message : undefined,
			severity: report.severity,
		})), [{
			scope: 'owned',
			feature: 'browser-bookmarks',
			operation: 'storage-corrupt',
			name: 'Error',
			message: 'Browser bookmark storage could not be parsed',
			severity: 'warning',
		}]);
		assert.ok(!String((reports[0].error as Error).message).includes('private-title'));
		assert.ok(!String((reports[0].error as Error).message).includes('/Users/alice'));
	} finally {
		configureParadisDiagnosticReporter(() => { });
	}
});
~~~

- [ ] **Step 2: focused Electron test を実行して RED を確認する**

Run: <code>rtk npm run transpile-client</code>

Run: <code>rtk ./scripts/test.sh --run src/vs/paradis/contrib/browserBookmarks/test/electron-browser/paradisBookmarksService.test.ts --grep "reports corrupt storage with a fixed error"</code>

Expected: FAIL。最新 main は <code>JSON.parse</code> の raw <code>SyntaxError</code> を reporter へ渡すため、固定 message の期待と一致しない。

- [ ] **Step 3: catch した parse error を捨て、固定 Error を報告する最小実装を行う**

<code>ParadisBookmarksService._loadNodes()</code> の catch を次の形にする。復旧と backup の順序は変更しない。

~~~ts
		try {
			nodes = raw ? recoverParadisBookmarkNodes(JSON.parse(raw)) : [];
		} catch {
			nodes = [];
			if (raw) {
				this._storageService.store(BOOKMARKS_STORAGE_RECOVERY_BACKUP_KEY, raw, StorageScope.APPLICATION, StorageTarget.USER);
			}
			reportParadisDiagnosticError(
				'owned',
				'browser-bookmarks',
				'storage-corrupt',
				new Error('Browser bookmark storage could not be parsed'),
				undefined,
				'warning',
			);
		}
~~~

- [ ] **Step 4: focused suite を再実行して GREEN を確認する**

Run: <code>rtk npm run transpile-client</code>

Run: <code>rtk ./scripts/test.sh --run src/vs/paradis/contrib/browserBookmarks/test/electron-browser/paradisBookmarksService.test.ts</code>

Expected: PASS。既存の recovery、legacy migration、duplicate URL の test も同時に通る。

- [ ] **Step 5: #17 を独立コミットする**

~~~bash
rtk git add src/vs/paradis/contrib/browserBookmarks/electron-browser/paradisBookmarksService.ts src/vs/paradis/contrib/browserBookmarks/test/electron-browser/paradisBookmarksService.test.ts
rtk git commit -m "fix: sanitize bookmark recovery diagnostics"
~~~

---

### Task 2: #19 Service status を provider failure episode 単位で報告する

**Files:**
- Modify: <code>src/vs/paradis/contrib/serviceStatus/common/paradisServiceStatus.ts</code>
- Modify: <code>src/vs/paradis/contrib/serviceStatus/test/common/paradisServiceStatus.test.ts</code>
- Create: <code>src/vs/paradis/contrib/serviceStatus/test/electron-browser/paradisServiceStatusClient.test.ts</code>
- Modify: <code>src/vs/paradis/contrib/serviceStatus/electron-browser/paradisServiceStatusClient.ts</code>

**Interfaces:**
- Produces: <code>ParadisServiceStatusFailureEpisodeTracker.recordFailure(provider): boolean</code>
- Produces: <code>ParadisServiceStatusFailureEpisodeTracker.recordSuccess(provider): void</code>
- Preserves: <code>ParadisServiceStatusClient.getSnapshot()</code> の3 provider 並行取得、8秒 timeout、<code>unknown</code> entry、UI 用 error の160文字上限
- Produces: 1 provider の failure/failure/success/failure が Sentry report 2件になる契約。provider 間の episode は独立する

- [ ] **Step 1: provider 単位の episode 状態機械の failing test を追加する**

<code>paradisServiceStatus.test.ts</code> の import に class を追加し、suite 内へ次を追加する。

~~~ts
import {
	ParadisServiceStatusFailureEpisodeTracker,
	paradisParseServiceStatusIndicator,
	paradisServiceStatusSeverity,
} from '../../common/paradisServiceStatus.js';

test('tracks one report per provider failure episode and rearms after success', () => {
	const tracker = new ParadisServiceStatusFailureEpisodeTracker();

	assert.deepStrictEqual([
		tracker.recordFailure('claude'),
		tracker.recordFailure('claude'),
		tracker.recordFailure('codex'),
	], [true, false, true]);

	tracker.recordSuccess('claude');

	assert.deepStrictEqual([
		tracker.recordFailure('claude'),
		tracker.recordFailure('codex'),
	], [true, false]);
});
~~~

- [ ] **Step 2: client wiring、固定 Error、成功後の再 arm を検証する failing integration test を作る**

<code>paradisServiceStatusClient.test.ts</code> を次の内容で作る。

~~~ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { IRequestContext, IRequestOptions } from '../../../../../base/parts/request/common/request.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AuthInfo, Credentials, IRequestService } from '../../../../../platform/request/common/request.js';
import { configureParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { PARADIS_SERVICE_STATUS_SOURCES } from '../../common/paradisServiceStatus.js';
import { ParadisServiceStatusClient } from '../../electron-browser/paradisServiceStatusClient.js';

function response(body: string): IRequestContext {
	return {
		res: { headers: {}, statusCode: 200 },
		stream: bufferToStream(VSBuffer.fromString(body)),
	};
}

class SequencedStatusRequestService implements IRequestService {
	declare readonly _serviceBrand: undefined;
	readonly onDidCompleteRequest = Event.None;
	private claudeAttempt = 0;

	async request(options: IRequestOptions, _token: CancellationToken): Promise<IRequestContext> {
		if (options.url === PARADIS_SERVICE_STATUS_SOURCES.claude.apiUrl) {
			const attempt = this.claudeAttempt++;
			if (attempt === 2) {
				return response(JSON.stringify({ status: { indicator: 'none', description: 'All Systems Operational' } }));
			}
			return response(
				'{"status":{"indicator":"none"},"private":"file:///Users/alice/service-' + attempt + '.json",',
			);
		}
		return response(JSON.stringify({ status: { indicator: 'none', description: 'All Systems Operational' } }));
	}

	async resolveProxy(_url: string): Promise<string | undefined> { return undefined; }
	async lookupAuthorization(_authInfo: AuthInfo): Promise<Credentials | undefined> { return undefined; }
	async lookupKerberosAuthorization(_url: string): Promise<string | undefined> { return undefined; }
	async loadCertificates(): Promise<string[]> { return []; }
}

suite('ParadisServiceStatusClient diagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports only the start of each provider failure episode with a fixed error', async () => {
		const reports: Array<{
			readonly scope: string;
			readonly feature: string;
			readonly operation: string;
			readonly error: unknown;
			readonly provider: unknown;
			readonly severity: string | undefined;
		}> = [];
		configureParadisDiagnosticReporter((scope, feature, operation, error, safeExtra, severity) => {
			reports.push({
				scope,
				feature,
				operation,
				error,
				provider: safeExtra?.['safe_provider'],
				severity,
			});
		});

		try {
			const client = new ParadisServiceStatusClient(new SequencedStatusRequestService());
			const snapshots = [];
			for (let index = 0; index < 4; index++) {
				snapshots.push(await client.getSnapshot());
			}

			assert.deepStrictEqual(
				snapshots.map(snapshot => snapshot.entries.claude.severity),
				['unknown', 'unknown', 'ok', 'unknown'],
			);
			assert.deepStrictEqual(reports.map(report => ({
				scope: report.scope,
				feature: report.feature,
				operation: report.operation,
				message: report.error instanceof Error ? report.error.message : String(report.error),
				provider: report.provider,
				severity: report.severity,
			})), [{
				scope: 'owned',
				feature: 'service-status',
				operation: 'fetch-failed',
				message: 'Service status provider request failed',
				provider: 'claude',
				severity: 'warning',
			}, {
				scope: 'owned',
				feature: 'service-status',
				operation: 'fetch-failed',
				message: 'Service status provider request failed',
				provider: 'claude',
				severity: 'warning',
			}]);
			assert.ok(reports.every(report => !String((report.error as Error).message).includes('/Users/alice')));
		} finally {
			configureParadisDiagnosticReporter(() => { });
		}
	});
});
~~~

- [ ] **Step 3: pure test と Electron integration test を実行して RED を確認する**

Run: <code>rtk npm run transpile-client</code>

Expected: transpile は完了し、追加した test JavaScript が <code>out/</code> に生成される。

Run: <code>rtk npm run test-node -- --run src/vs/paradis/contrib/serviceStatus/test/common/paradisServiceStatus.test.ts</code>

Expected: FAIL with missing export <code>ParadisServiceStatusFailureEpisodeTracker</code>。

Run: <code>rtk ./scripts/test.sh --run src/vs/paradis/contrib/serviceStatus/test/electron-browser/paradisServiceStatusClient.test.ts</code>

Expected: FAIL。最新 main の client behavior は連続3失敗を3件とも raw Error で報告するため、2件の固定 Error expectation と一致しない。

- [ ] **Step 4: provider failure episode tracker と client wiring を最小実装する**

<code>paradisServiceStatus.ts</code> の provider 定義直後へ次を追加する。

~~~ts
export class ParadisServiceStatusFailureEpisodeTracker {
	private readonly failingProviders = new Set<ParadisServiceStatusProvider>();

	recordFailure(provider: ParadisServiceStatusProvider): boolean {
		if (this.failingProviders.has(provider)) {
			return false;
		}
		this.failingProviders.add(provider);
		return true;
	}

	recordSuccess(provider: ParadisServiceStatusProvider): void {
		this.failingProviders.delete(provider);
	}
}
~~~

<code>paradisServiceStatusClient.ts</code> の common import に class を加え、client に tracker を保持する。

~~~ts
export class ParadisServiceStatusClient {

	private readonly failureEpisodes = new ParadisServiceStatusFailureEpisodeTracker();

	constructor(
		@IRequestService private readonly requestService: IRequestService,
	) { }
~~~

parsed response が有効と確定した直後に provider を成功へ戻す。

~~~ts
			if (!parsed) {
				throw new Error(localize('paradis.serviceStatus.unexpectedResponse', "予期しない応答形式です"));
			}
			this.failureEpisodes.recordSuccess(provider);
			return {
				provider,
				severity: paradisServiceStatusSeverity(parsed.indicator),
				description: parsed.description,
				fetchedAt: Date.now(),
				error: undefined,
			};
~~~

catch 内の report を episode の先頭だけに限定し、Sentry 用 Error は固定する。UI entry の既存 error 生成はその後に残す。

~~~ts
		} catch (error) {
			if (this.failureEpisodes.recordFailure(provider)) {
				reportParadisDiagnosticError(
					'owned',
					'service-status',
					'fetch-failed',
					new Error('Service status provider request failed'),
					{ safe_provider: provider },
					'warning',
				);
			}
			return {
				provider,
				severity: 'unknown',
				description: undefined,
				fetchedAt: Date.now(),
				error: truncateErrorMessage(error instanceof Error ? error.message : String(error)),
			};
~~~

- [ ] **Step 5: pure test と実 client test を GREEN で確認する**

Run: <code>rtk npm run transpile-client</code>

Run: <code>rtk npm run test-node -- --run src/vs/paradis/contrib/serviceStatus/test/common/paradisServiceStatus.test.ts</code>

Run: <code>rtk ./scripts/test.sh --run src/vs/paradis/contrib/serviceStatus/test/electron-browser/paradisServiceStatusClient.test.ts</code>

Expected: 2 suites PASS。Claude の failure/failure/success/failure は2 report、Codex/GitHub の成功は episode に影響しない。

- [ ] **Step 6: #19 を独立コミットする**

~~~bash
rtk git add src/vs/paradis/contrib/serviceStatus/common/paradisServiceStatus.ts src/vs/paradis/contrib/serviceStatus/test/common/paradisServiceStatus.test.ts src/vs/paradis/contrib/serviceStatus/test/electron-browser/paradisServiceStatusClient.test.ts src/vs/paradis/contrib/serviceStatus/electron-browser/paradisServiceStatusClient.ts
rtk git commit -m "fix: deduplicate service status failure reports"
~~~

---

### Task 3: #20 Browser Live の永続失敗 gate を実 screenshot failure だけで進める

**Files:**
- Modify: <code>src/vs/paradis/contrib/browserLiveWindow/common/paradisBrowserLiveWindow.ts</code>
- Modify: <code>src/vs/paradis/contrib/browserLiveWindow/test/common/paradisBrowserLiveWindow.test.ts</code>
- Modify: <code>src/vs/paradis/contrib/browserLiveWindow/electron-browser/paradisBrowserLiveThumbnail.ts</code>

**Interfaces:**
- Produces: <code>ParadisBrowserLivePersistentFailureGate.record(outcome, hasFrame): boolean</code>
- Produces: <code>ParadisBrowserLiveCaptureOutcome = 'model-unavailable' | 'capture-succeeded' | 'capture-failed'</code>
- Preserves: retry/backoff 用 <code>failures</code>、5回閾値、first-frame retry、capture cadence、blob URL lifecycle
- Produces: model 未解決4回後の最初の capture failure では report せず、実 capture failure 5回目だけ report する契約

- [ ] **Step 1: gate の failure episode を表す failing common test を追加する**

<code>paradisBrowserLiveWindow.test.ts</code> の import に class を追加し、suite 内へ次を追加する。

~~~ts
import {
	IParadisBrowserLiveEntry,
	IParadisBrowserLiveViewState,
	ParadisBrowserLivePersistentFailureGate,
	PARADIS_BROWSER_LIVE_MAX_COLUMNS,
	paradisBrowserLiveCaptureDelayMs,
	paradisBrowserLiveCoverPoint,
	paradisBrowserLiveDisplayTitle,
	paradisBrowserLiveDisplayUrl,
	paradisBrowserLiveInActiveSpace,
	paradisBrowserLiveRetryDelayMs,
	paradisDefaultBrowserLiveViewState,
	paradisFilterBrowserLiveEntries,
	paradisGroupBrowserLiveEntries,
	paradisHasBrowserLiveFilter,
	paradisParseBrowserLiveViewState,
	paradisSerializeBrowserLiveViewState,
	paradisSortBrowserLiveEntries,
	paradisSummarizeBrowserLiveEntries,
} from '../../common/paradisBrowserLiveWindow.js';

test('counts only real capture failures and rearms after a successful capture', () => {
	const gate = new ParadisBrowserLivePersistentFailureGate();

	const unresolvedModelDecisions = Array.from(
		{ length: 4 },
		() => gate.record('model-unavailable', false),
	);
	const firstEpisode = Array.from(
		{ length: 6 },
		() => gate.record('capture-failed', false),
	);

	gate.record('capture-succeeded', false);
	const secondEpisode = Array.from(
		{ length: 5 },
		() => gate.record('capture-failed', false),
	);

	gate.record('capture-succeeded', false);
	const failuresAfterAFrame = Array.from(
		{ length: 5 },
		() => gate.record('capture-failed', true),
	);

	assert.deepStrictEqual(unresolvedModelDecisions, [false, false, false, false]);
	assert.deepStrictEqual(firstEpisode, [false, false, false, false, true, false]);
	assert.deepStrictEqual(secondEpisode, [false, false, false, false, true]);
	assert.deepStrictEqual(failuresAfterAFrame, [false, false, false, false, false]);
});
~~~

- [ ] **Step 2: focused Node test を実行して RED を確認する**

Run: <code>rtk npm run transpile-client</code>

Expected: transpile は完了し、追加した test JavaScript が <code>out/</code> に生成される。

Run: <code>rtk npm run test-node -- --run src/vs/paradis/contrib/browserLiveWindow/test/common/paradisBrowserLiveWindow.test.ts</code>

Expected: FAIL with missing export <code>ParadisBrowserLivePersistentFailureGate</code>。

- [ ] **Step 3: 診断専用の小さな state machine を common に実装する**

<code>paradisBrowserLiveWindow.ts</code> の retry delay helper の前へ次を追加する。

~~~ts
export type ParadisBrowserLiveCaptureOutcome =
	| 'model-unavailable'
	| 'capture-succeeded'
	| 'capture-failed';

export class ParadisBrowserLivePersistentFailureGate {
	private static readonly threshold = 5;
	private consecutiveFirstFrameCaptureFailures = 0;

	record(outcome: ParadisBrowserLiveCaptureOutcome, hasFrame: boolean): boolean {
		if (outcome === 'capture-succeeded') {
			this.consecutiveFirstFrameCaptureFailures = 0;
			return false;
		}
		if (outcome === 'model-unavailable' || hasFrame) {
			return false;
		}
		this.consecutiveFirstFrameCaptureFailures++;
		return this.consecutiveFirstFrameCaptureFailures === ParadisBrowserLivePersistentFailureGate.threshold;
	}
}
~~~

- [ ] **Step 4: thumbnail の backoff counter と diagnostic gate を分離する**

<code>paradisBrowserLiveThumbnail.ts</code> の common import に class を加え、旧 <code>PERSISTENT_FAILURE_THRESHOLD</code> 定数とその説明を削除する。

~~~ts
import {
	ParadisBrowserLiveCadence,
	ParadisBrowserLivePersistentFailureGate,
	paradisBrowserLiveCaptureDelayMs,
	paradisBrowserLiveRetryDelayMs,
} from '../common/paradisBrowserLiveWindow.js';
~~~

class field に gate を1つ持たせる。

~~~ts
	private timer: number | undefined;
	private capturing = false;
	private failures = 0;
	private readonly persistentFailureGate = new ParadisBrowserLivePersistentFailureGate();
~~~

model 未解決、成功、失敗の各分岐を gate に記録する。backoff 用 <code>failures</code> の増減はそのまま残す。

~~~ts
		const model = this.resolveModel();
		if (!model) {
			this.failures++;
			this.persistentFailureGate.record('model-unavailable', this.hasFrame);
			this.scheduleNext();
			return;
		}
~~~

~~~ts
			if (this._store.isDisposed) {
				return;
			}
			this.failures = 0;
			this.persistentFailureGate.record('capture-succeeded', this.hasFrame);
			this.show(buffer);
~~~

~~~ts
		} catch (error) {
			this.failures++;
			this.logService.trace('[paradisBrowserLive] capture failed (' + this.failures + '): ' + String(error));
			if (this.persistentFailureGate.record('capture-failed', this.hasFrame)) {
				reportParadisDiagnosticError(
					'owned',
					'browser-live-window',
					'capture-persistently-failing',
					error,
					undefined,
					'warning',
				);
			}
~~~

- [ ] **Step 5: focused suite を再実行して GREEN を確認する**

Run: <code>rtk npm run transpile-client</code>

Run: <code>rtk npm run test-node -- --run src/vs/paradis/contrib/browserLiveWindow/test/common/paradisBrowserLiveWindow.test.ts</code>

Expected: PASS。既存 cadence/backoff test と新しい gate test が両方通る。

- [ ] **Step 6: #20 を独立コミットする**

~~~bash
rtk git add src/vs/paradis/contrib/browserLiveWindow/common/paradisBrowserLiveWindow.ts src/vs/paradis/contrib/browserLiveWindow/test/common/paradisBrowserLiveWindow.test.ts src/vs/paradis/contrib/browserLiveWindow/electron-browser/paradisBrowserLiveThumbnail.ts
rtk git commit -m "fix: gate browser live capture diagnostics"
~~~

---

### Task 4: #21 Word separator 欠落診断を AfterRestored へ遅延する

**Files:**
- Create: <code>src/vs/paradis/contrib/terminalWordSeparators/test/browser/paradisTerminalWordSeparators.contribution.test.ts</code>
- Modify: <code>src/vs/paradis/contrib/terminalWordSeparators/browser/paradisTerminalWordSeparators.contribution.ts</code>

**Interfaces:**
- Produces: <code>reportParadisTerminalWordSeparatorsDefault(defaultValue, report): void</code>
- Produces: <code>ParadisTerminalWordSeparatorsDiagnosticsContribution</code>
- Produces: <code>registerParadisTerminalWordSeparatorsDiagnosticsContribution(register?): void</code>
- Preserves: module load 時の upstream default 読み取り、fallback、<code>registerDefaultConfigurations</code> による全角 separator 注入
- Produces: 欠落診断 class が <code>WorkbenchPhase.AfterRestored</code> でのみ workbench から生成される registration 契約

- [ ] **Step 1: diagnostic helper と registration phase の failing browser test を作る**

<code>paradisTerminalWordSeparators.contribution.test.ts</code> を次の内容で作る。

~~~ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import type { ParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';
import {
	ParadisTerminalWordSeparatorsDiagnosticsContribution,
	registerParadisTerminalWordSeparatorsDiagnosticsContribution,
	reportParadisTerminalWordSeparatorsDefault,
} from '../../browser/paradisTerminalWordSeparators.contribution.js';

suite('Paradis terminal word separator diagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers the diagnostic contribution after the workbench is restored', () => {
		const registrations: Array<{
			readonly id: string;
			readonly ctor: typeof ParadisTerminalWordSeparatorsDiagnosticsContribution;
			readonly phase: WorkbenchPhase;
		}> = [];

		registerParadisTerminalWordSeparatorsDiagnosticsContribution(
			(id, ctor, phase) => registrations.push({ id, ctor, phase }),
		);

		assert.deepStrictEqual(registrations, [{
			id: 'workbench.contrib.paradisTerminalWordSeparatorsDiagnostics',
			ctor: ParadisTerminalWordSeparatorsDiagnosticsContribution,
			phase: WorkbenchPhase.AfterRestored,
		}]);
	});

	test('reports a fixed error only when the captured upstream default is missing', () => {
		const reports: Array<Parameters<ParadisDiagnosticReporter>> = [];
		const reporter: ParadisDiagnosticReporter = (scope, feature, operation, error, safeExtra, severity) => {
			reports.push([scope, feature, operation, error, safeExtra, severity]);
		};

		reportParadisTerminalWordSeparatorsDefault(undefined, reporter);
		reportParadisTerminalWordSeparatorsDefault(' ()[]{}', reporter);

		assert.deepStrictEqual(reports.map(report => ({
			scope: report[0],
			feature: report[1],
			operation: report[2],
			message: report[3] instanceof Error ? report[3].message : undefined,
		})), [{
			scope: 'owned',
			feature: 'terminal-word-separators',
			operation: 'default-missing',
			message: 'terminal.integrated.wordSeparators default was not found in the configuration registry',
		}]);
	});
});
~~~

- [ ] **Step 2: Chromium browser test を実行して RED を確認する**

Run: <code>rtk npm run transpile-client</code>

Expected: transpile は完了し、追加した browser test JavaScript が <code>out/</code> に生成される。

Run: <code>rtk npm run test-browser-no-install -- --run src/vs/paradis/contrib/terminalWordSeparators/test/browser/paradisTerminalWordSeparators.contribution.test.ts --browser chromium</code>

Expected: FAIL with missing exported contribution/helper symbols。

- [ ] **Step 3: module-top report を pure helper と AfterRestored contribution に移す**

<code>paradisTerminalWordSeparators.contribution.ts</code> に workbench contribution と reporter type の import を追加する。

~~~ts
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { type ParadisDiagnosticReporter, reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
~~~

現在の module-top <code>if (typeof paradisUpstreamWordSeparators !== 'string')</code> block を削除し、default override 登録の後へ次を追加する。

~~~ts
export function reportParadisTerminalWordSeparatorsDefault(
	defaultValue: unknown,
	report: ParadisDiagnosticReporter = reportParadisDiagnosticError,
): void {
	if (typeof defaultValue === 'string') {
		return;
	}
	report(
		'owned',
		'terminal-word-separators',
		'default-missing',
		new Error('terminal.integrated.wordSeparators default was not found in the configuration registry'),
	);
}

export class ParadisTerminalWordSeparatorsDiagnosticsContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisTerminalWordSeparatorsDiagnostics';

	constructor() {
		reportParadisTerminalWordSeparatorsDefault(paradisUpstreamWordSeparators);
	}
}

type ParadisTerminalWordSeparatorsDiagnosticsRegistrar = (
	id: string,
	ctor: typeof ParadisTerminalWordSeparatorsDiagnosticsContribution,
	phase: WorkbenchPhase,
) => void;

export function registerParadisTerminalWordSeparatorsDiagnosticsContribution(
	register: ParadisTerminalWordSeparatorsDiagnosticsRegistrar = registerWorkbenchContribution2,
): void {
	register(
		ParadisTerminalWordSeparatorsDiagnosticsContribution.ID,
		ParadisTerminalWordSeparatorsDiagnosticsContribution,
		WorkbenchPhase.AfterRestored,
	);
}

registerParadisTerminalWordSeparatorsDiagnosticsContribution();
~~~

この class は module load 時に捕捉済みの <code>paradisUpstreamWordSeparators</code> を検査するため、後から登録した Para Code override を upstream default と誤認しない。

- [ ] **Step 4: browser test を GREEN で確認する**

Run: <code>rtk npm run transpile-client</code>

Run: <code>rtk npm run test-browser-no-install -- --run src/vs/paradis/contrib/terminalWordSeparators/test/browser/paradisTerminalWordSeparators.contribution.test.ts --browser chromium</code>

Expected: PASS。registration は <code>AfterRestored</code>、有効な string default は0 report、欠落時は固定 Error 1件になる。

- [ ] **Step 5: #21 を独立コミットする**

~~~bash
rtk git add src/vs/paradis/contrib/terminalWordSeparators/browser/paradisTerminalWordSeparators.contribution.ts src/vs/paradis/contrib/terminalWordSeparators/test/browser/paradisTerminalWordSeparators.contribution.test.ts
rtk git commit -m "fix: defer word separator diagnostics"
~~~

---

### Task 5: #22 3つの Sentry adapter に共通 safe Error 境界を置く

**Files:**
- Modify: <code>src/vs/paradis/contrib/sentry/common/paradisSentryDiagnostics.ts</code>
- Create: <code>src/vs/paradis/contrib/sentry/test/common/paradisSentryDiagnostics.test.ts</code>
- Modify: <code>src/vs/paradis/contrib/sentry/electron-browser/paradisSentryRenderer.ts</code>
- Modify: <code>src/vs/paradis/contrib/sentry/electron-main/paradisSentryMain.ts</code>
- Modify: <code>src/vs/paradis/contrib/sentry/electron-utility/paradisSentryUtility.ts</code>
- Modify: <code>src/vs/paradis/contrib/sentry/test/electron-utility/paradisSentryUtility.child.ts</code>
- Modify: <code>src/vs/paradis/contrib/sentry/test/electron-utility/paradisSentryUtility.test.ts</code>

**Interfaces:**
- Produces: <code>toParadisSentrySafeError(feature: string, operation: string, error: unknown): Error</code>
- Produces: <code>Error("Para Code diagnostic: feature.operation")</code> と、その固定 first line だけから成る stack。元 Error の message、name、stack、cause、custom property、非 Error の文字列表現は参照・コピーしない
- Preserves: <code>reportParadisDiagnosticError</code> は元 Error を reporter へそのまま渡す
- Consumes: renderer/main/utility の <code>feature</code> と <code>operation</code> tag
- Produces: 3 adapter が <code>captureException(toParadisSentrySafeError(feature, operation, error))</code> を実行する共通 privacy boundary

- [ ] **Step 1: safe Error 変換と domain reporter identity の failing common test を作る**

<code>paradisSentryDiagnostics.test.ts</code> を次の内容で作る。

~~~ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	configureParadisDiagnosticReporter,
	reportParadisDiagnosticError,
	toParadisSentrySafeError,
} from '../../common/paradisSentryDiagnostics.js';

suite('ParadisSentryDiagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('replaces every source field with a fixed message and a frame-free stack', () => {
		const source = new Error('private response body at file:///Users/alice/private.ts', {
			cause: new Error('private cause'),
		});
		source.stack = [
			'Error: private response body at file:///Users/alice/private.ts',
			'    at parse (/Users/alice/private.ts:1:2)',
			'private multiline continuation',
			'    at request (app:///out/request.js:2:3)',
		].join('\n');

		const safe = toParadisSentrySafeError('service-status', 'fetch-failed', source);

		assert.notStrictEqual(safe, source);
		assert.strictEqual(safe.name, 'Error');
		assert.strictEqual(safe.message, 'Para Code diagnostic: service-status.fetch-failed');
		assert.strictEqual(safe.stack, 'Error: Para Code diagnostic: service-status.fetch-failed');
		assert.strictEqual(Object.hasOwn(safe, 'cause'), false);
		assert.ok(!safe.stack?.includes('private response body'));
		assert.ok(!safe.stack?.includes('/Users/alice'));
		assert.ok(!safe.stack?.includes('private multiline continuation'));
	});

	test('does not stringify thrown values or read a throwing stack getter', () => {
		let stackReads = 0;
		const thrownObject = {
			secret: 'private-object-value',
			get stack(): string {
				stackReads++;
				throw new Error('private getter value');
			},
		};

		const fromString = toParadisSentrySafeError('terminal', 'spawn', 'private-string-value');
		const fromObject = toParadisSentrySafeError('terminal', 'spawn', thrownObject);

		assert.strictEqual(fromString.message, 'Para Code diagnostic: terminal.spawn');
		assert.strictEqual(fromObject.message, 'Para Code diagnostic: terminal.spawn');
		assert.ok(!fromString.stack?.includes('private-string-value'));
		assert.ok(!fromObject.stack?.includes('private-object-value'));
		assert.ok(!fromObject.stack?.includes('private getter value'));
		assert.strictEqual(stackReads, 0);
	});

	test('keeps the original error identity until the process adapter boundary', () => {
		const original = new Error('domain-visible-error');
		let received: unknown;
		configureParadisDiagnosticReporter((_scope, _feature, _operation, error) => {
			received = error;
		});

		try {
			reportParadisDiagnosticError('owned', 'mobile-relay', 'backend-acquire', original);
			assert.strictEqual(received, original);
		} finally {
			configureParadisDiagnosticReporter(() => { });
		}
	});
});
~~~

- [ ] **Step 2: utility adapter integration expectation を safe message に変更する**

<code>paradisSentryUtility.child.ts</code> で adapter へ渡す2つの Error に、漏らしてはいけない内容を入れる。

~~~ts
	const directCaptureId = utilitySentry.captureParadisUtilityException(
		'patched',
		'mobile-relay',
		'reconnect',
		new Error('relay failed for file:///Users/alice/private.ts'),
		{ attempt: 2 },
	);
	reportParadisDiagnosticError(
		'owned',
		'terminal-environment',
		'resolve',
		new Error('diagnostic failed with private response body'),
		{ duration_ms: 321, phase: 'resolve' },
	);
~~~

<code>paradisSentryUtility.test.ts</code> の既存 <code>result.captures</code> expectation の message だけを次へ変更する。scope、extra、breadcrumb expectation は変更しない。

~~~ts
		assert.deepStrictEqual(result.captures, [{
			errorMessage: 'Para Code diagnostic: mobile-relay.reconnect',
			scope: {
				tags: {
					'para.scope': 'patched',
					'para.feature': 'mobile-relay',
					'para.operation': 'reconnect',
				},
				extras: { attempt: 2 },
			},
		}, {
			errorMessage: 'Para Code diagnostic: terminal-environment.resolve',
			scope: {
				tags: {
					'para.scope': 'owned',
					'para.feature': 'terminal-environment',
					'para.operation': 'resolve',
				},
				extras: { duration_ms: 321, phase: 'resolve' },
			},
		}]);
~~~

- [ ] **Step 3: common test と utility integration test を実行して RED を確認する**

Run: <code>rtk npm run transpile-client</code>

Expected: transpile は完了し、追加した test JavaScript が <code>out/</code> に生成される。

Run: <code>rtk npm run test-node -- --run src/vs/paradis/contrib/sentry/test/common/paradisSentryDiagnostics.test.ts</code>

Expected: FAIL with missing export <code>toParadisSentrySafeError</code>。

Run: <code>rtk ./scripts/test.sh --run src/vs/paradis/contrib/sentry/test/electron-utility/paradisSentryUtility.test.ts</code>

Expected: FAIL。utility adapter は raw Error message を capture するため、固定 <code>Para Code diagnostic: feature.operation</code> expectation と一致しない。

最新 main の utility adapter は raw Error を直接 capture するため、Step 4 の frame-free 契約と Step 5 の3 adapter 配線を一続きの最小実装として行う。

- [ ] **Step 4: raw Error を参照せず、固定 message と frame-free stack だけを作る共通 helper を実装する**

<code>paradisSentryDiagnostics.ts</code> へ次を追加する。

~~~ts
export function toParadisSentrySafeError(
	feature: string,
	operation: string,
	_error: unknown,
): Error {
	const safeError = new Error('Para Code diagnostic: ' + feature + '.' + operation);
	safeError.stack = safeError.name + ': ' + safeError.message;
	return safeError;
}
~~~

この helper は元 Error の message/name/stack/cause/property を参照しない。既存 sanitizer は home prefix を <code>~</code> にするだけで残りの path を保持するため、source frame 自体をコピーしないことが privacy 契約である。

- [ ] **Step 5: renderer、main、utility の capture 直前だけで helper を適用する**

3 adapter の import に <code>toParadisSentrySafeError</code> を加える。各 <code>captureParadis*Exception</code> の最後の1行をそれぞれ同じ形にする。

~~~ts
		return Sentry.captureException(toParadisSentrySafeError(feature, operation, error));
~~~

変更対象は次の3関数だけである。

- <code>captureParadisRendererException</code> in <code>paradisSentryRenderer.ts</code>
- <code>captureParadisMainException</code> in <code>paradisSentryMain.ts</code>
- <code>captureParadisUtilityException</code> in <code>paradisSentryUtility.ts</code>

<code>Sentry.addBreadcrumb</code>、tag、safe extra、severity 設定の後、上記 capture 行の直前以外では helper を呼ばない。

- [ ] **Step 6: common、utility、既存 domain spy 契約を GREEN で確認する**

Run: <code>rtk npm run transpile-client</code>

Run: <code>rtk npm run test-node -- --run src/vs/paradis/contrib/sentry/test/common/paradisSentryDiagnostics.test.ts</code>

Run: <code>rtk ./scripts/test.sh --run src/vs/paradis/contrib/sentry/test/electron-utility/paradisSentryUtility.test.ts</code>

Run: <code>rtk ./scripts/test.sh --run src/vs/paradis/contrib/mobileRelay/test/electron-browser/paradisMobileWorkspaceProvider.test.ts --grep "reports failed backend actions and retries an acquire on the next mobile heartbeat"</code>

Run: <code>rtk rg -n "captureException\(toParadisSentrySafeError" src/vs/paradis/contrib/sentry/electron-browser/paradisSentryRenderer.ts src/vs/paradis/contrib/sentry/electron-main/paradisSentryMain.ts src/vs/paradis/contrib/sentry/electron-utility/paradisSentryUtility.ts</code>

Expected: 全 test PASS、最後の検索は3 adapter に各1件の合計3件。Mobile workspace provider は acquire/release の元 Error identity を引き続き strict equality で確認する。

- [ ] **Step 7: #22 を独立コミットする**

~~~bash
rtk git add src/vs/paradis/contrib/sentry/common/paradisSentryDiagnostics.ts src/vs/paradis/contrib/sentry/test/common/paradisSentryDiagnostics.test.ts src/vs/paradis/contrib/sentry/electron-browser/paradisSentryRenderer.ts src/vs/paradis/contrib/sentry/electron-main/paradisSentryMain.ts src/vs/paradis/contrib/sentry/electron-utility/paradisSentryUtility.ts src/vs/paradis/contrib/sentry/test/electron-utility/paradisSentryUtility.child.ts src/vs/paradis/contrib/sentry/test/electron-utility/paradisSentryUtility.test.ts
rtk git commit -m "fix: sanitize errors at sentry capture boundaries"
~~~

---

## Completion Gate

- [ ] <code>rtk npm run typecheck-client</code> を実行し、変更範囲の TypeScript error が0件であることを確認する。
- [ ] 次の対象限定 ESLint を実行し、warning/error が0件であることを確認する。

~~~bash
rtk npm run eslint -- src/vs/paradis/contrib/browserBookmarks/electron-browser/paradisBookmarksService.ts src/vs/paradis/contrib/browserBookmarks/test/electron-browser/paradisBookmarksService.test.ts src/vs/paradis/contrib/serviceStatus/common/paradisServiceStatus.ts src/vs/paradis/contrib/serviceStatus/test/common/paradisServiceStatus.test.ts src/vs/paradis/contrib/serviceStatus/test/electron-browser/paradisServiceStatusClient.test.ts src/vs/paradis/contrib/serviceStatus/electron-browser/paradisServiceStatusClient.ts src/vs/paradis/contrib/browserLiveWindow/common/paradisBrowserLiveWindow.ts src/vs/paradis/contrib/browserLiveWindow/test/common/paradisBrowserLiveWindow.test.ts src/vs/paradis/contrib/browserLiveWindow/electron-browser/paradisBrowserLiveThumbnail.ts src/vs/paradis/contrib/terminalWordSeparators/browser/paradisTerminalWordSeparators.contribution.ts src/vs/paradis/contrib/terminalWordSeparators/test/browser/paradisTerminalWordSeparators.contribution.test.ts src/vs/paradis/contrib/sentry/common/paradisSentryDiagnostics.ts src/vs/paradis/contrib/sentry/test/common/paradisSentryDiagnostics.test.ts src/vs/paradis/contrib/sentry/electron-browser/paradisSentryRenderer.ts src/vs/paradis/contrib/sentry/electron-main/paradisSentryMain.ts src/vs/paradis/contrib/sentry/electron-utility/paradisSentryUtility.ts src/vs/paradis/contrib/sentry/test/electron-utility/paradisSentryUtility.child.ts src/vs/paradis/contrib/sentry/test/electron-utility/paradisSentryUtility.test.ts
~~~

- [ ] Task 1〜5 の GREEN command をすべて新しい出力で再実行する。過去の実行結果を completion evidence に使わない。
- [ ] <code>rtk git diff origin/main...HEAD --check</code> と <code>rtk git status --short</code> を実行し、whitespace error と意図しない変更がないことを確認する。
- [ ] <code>superpowers:requesting-code-review</code> を使い、新しい subagent に #17/#19/#20/#21/#22、frameを含めて元Errorを参照しないprivacy boundary、episode reset、既存 reporter identity、変更ファイル全体をレビューさせる。
- [ ] review finding があれば、該当 Task と同じ RED→最小修正→GREEN で追加コミットする。finding が0件になるまで PR を作らない。
- [ ] <code>rtk git fetch origin main</code> 後に base 差分を確認する。更新があれば <code>rtk git rebase origin/main</code> を行い、conflict 時は停止してユーザーへ報告する。rebase 後は Completion Gate の test を再実行する。
- [ ] branch を push し、GitHub CLI で main 向け PR を作る。

~~~bash
rtk git push -u origin HEAD
rtk gh pr create --base main --title "fix: harden latest main diagnostics" --body "Addresses audit findings 17, 19, 20, 21, and 22. Adds provider failure episodes, a Browser Live capture gate, AfterRestored word-separator diagnostics, site-fixed bookmark/service-status errors, and process-boundary Sentry Error sanitization."
~~~
