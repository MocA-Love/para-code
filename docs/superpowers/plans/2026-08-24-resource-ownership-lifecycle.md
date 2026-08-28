# Resource Ownership and Lifecycle Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 監査設計 #9、#10、#13、#16、#18 で確定した process、tunnel、modal/fetch、IPC listener、power-save blocker の所有権不具合を、失敗経路と race を固定する回帰テストから修正する。

**Architecture:** 各外部資源の取得直後に所有者を一意にし、正常完了、所有権移譲、世代交代、dispose の各境界で同じ identity を使って解放する。Node child process は共通 tracker、release notes は modal と fetch CTS の世代 owner、Keep Awake は Electron 非依存 controller に状態遷移を集約し、UI contribution は観測された実状態だけを描画する。

**Tech Stack:** TypeScript、Mocha、Sinon、VS Code Electron unit-test runner、Node.js child_process、Electron ipcMain、VS Code lifecycle/cancellation primitives

**Spec:** docs/superpowers/specs/2026-08-24-regression-resource-mobile-audit-design.md

## Global Constraints

- 作業場所は /home/user/github/para-code-audit-fixes-20260824 とし、main 側の既存未追跡ファイルや他担当の変更へ触れない。
- 実装 baseline は監査済み origin/main 8c5bd783f57008a6347eaa18ca8d3730983ba6b8 とし、実装開始時に origin/main がさらに更新されていればその最新 commit まで取り込んだうえで、branch が監査基準を含むことを確認する。
- 各 Task は記載順に test-first で進める。RED を観測する前に、その Task の production code を変更しない。
- 各 Task の最小実装後に対象テストを GREEN にし、その Task の列挙ファイルだけを原因単位で commit する。push と PR 作成はこの計画の実装範囲外とする。
- ファイル編集には apply_patch を使う。生成物や formatter で担当外ファイルを書き換えない。
- VS Code unit test は transpile 済みの out を実行するため、各 RED/GREEN で rtk npm run transpile-client を先に実行する。TypeScript import 自体が RED の Task では transpile failure を最初の失敗証拠とする。
- callback、timer、Promise、dispose の競合では identity 比較を残し、古い世代が新しい世代の参照を clear しない。
- #9 は ccusage、rtk、limitsMonitor の timeout と service dispose を対象とし、ccusage の timeout 時 offline retry 抑制を維持する。
- #10 は取得済み RemoteTunnel の非 loopback 拒否と同一portの遅延close通知を対象とする。成功時はmounterへ所有権を一度だけ移譲し、generation付きclose通知は通知元generationと現行lease generationが一致する場合だけ現行entryを削除する。
- #10 の `onTunnelClosed` generationは後方互換のoptional fieldとし、generationを提供しないcustom実装は従来のport単位削除へフォールバックする。upstream所有のtunnel common差分には理由付き`PARA-PATCH`を付ける。
- #13 は modal 再オープン、ユーザーによる modal close、fetch の遅延完了を対象とする。
- #16 は daemon starter と fallback starter の両方を修正する。upstream 所有ファイル src/vs/platform/terminal/electron-main/electronPtyHostStarter.ts の差分には、理由を記した PARA-PATCH コメントを必ず付ける。
- #18 は requested mode と actual mode を分離する。start 成功済み ID だけを所有し、stop 失敗 ID は保持して次の reconcile で同じ ID を再試行する。
- Sentry operation は Keep Awake の start failure を blocker-start-failed、stop failure を blocker-stop-failed に分ける。
- 各 Task の commit 前に、その Task の Files 節に列挙した path を rtk git diff --check -- へ渡し、空白エラーがないことを確認する。

---

### Task 1: 設計 #9 — Windows child-process tree の期限と所有権を共通 tracker にする

**Files:**

- Modify: src/vs/paradis/node/paradisKillChildProcess.ts
- Create: src/vs/paradis/test/node/paradisKillChildProcess.test.ts

**Interfaces:**

- Add: IParadisTrackedChildProcess extends IDisposable with readonly timedOut
- Add: ParadisChildProcessTreeTracker.track(child, timeoutMs)
- Preserve: paradisKillChildProcessTree(child, onError)
- Contract: tracked execution の dispose は正常 callback 完了を表し、timer だけを解除する。tracker の dispose は全 active child の timer を解除して tree kill を開始する。

- [ ] **Step 1: 期限到達、正常完了、owner dispose、二重 kill 防止を表す failing test を追加する。**

  src/vs/paradis/test/node/paradisKillChildProcess.test.ts を次の内容で作成する。

~~~ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ParadisChildProcessTreeTracker } from '../../node/paradisKillChildProcess.js';

suite('ParadisChildProcessTreeTracker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let clock: sinon.SinonFakeTimers;

	setup(() => {
		clock = sinon.useFakeTimers();
	});

	teardown(() => {
		sinon.restore();
	});

	function child() {
		const kill = sinon.spy(() => true);
		return {
			process: {
				pid: undefined,
				exitCode: null,
				signalCode: null,
				kill,
			} as unknown as cp.ChildProcess,
			kill,
		};
	}

	test('starts tree termination at the deadline while reporting a timeout', () => {
		const fixture = child();
		const tracker = new ParadisChildProcessTreeTracker();
		const execution = tracker.track(fixture.process, 60_000);

		clock.tick(59_999);
		assert.strictEqual(execution.timedOut, false);
		assert.strictEqual(fixture.kill.callCount, 0);

		clock.tick(1);
		assert.strictEqual(execution.timedOut, true);
		assert.strictEqual(fixture.kill.callCount, 1);

		execution.dispose();
		tracker.dispose();
		assert.strictEqual(fixture.kill.callCount, 1);
	});

	test('normal completion clears the deadline without terminating the child', () => {
		const fixture = child();
		const tracker = new ParadisChildProcessTreeTracker();
		const execution = tracker.track(fixture.process, 60_000);

		execution.dispose();
		clock.tick(60_000);
		tracker.dispose();

		assert.strictEqual(execution.timedOut, false);
		assert.strictEqual(fixture.kill.callCount, 0);
		assert.strictEqual(clock.countTimers(), 0);
	});

	test('owner disposal clears the deadline and terminates each active child once', () => {
		const first = child();
		const second = child();
		const tracker = new ParadisChildProcessTreeTracker();
		tracker.track(first.process, 60_000);
		tracker.track(second.process, 60_000);

		tracker.dispose();
		clock.tick(60_000);
		tracker.dispose();

		assert.deepStrictEqual([first.kill.callCount, second.kill.callCount], [1, 1]);
		assert.strictEqual(clock.countTimers(), 0);
	});
});
~~~

- [ ] **Step 2: tracker が未実装であることを RED として確認する。**

  実行:

~~~sh
rtk npm run transpile-client
~~~

  期待: paradisKillChildProcess.js に ParadisChildProcessTreeTracker の export がないため、paradisKillChildProcess.test.ts の import/typecheck が失敗する。

- [ ] **Step 3: timeout と owner dispose を一つの active ledger で扱う最小 tracker を実装する。**

  src/vs/paradis/node/paradisKillChildProcess.ts に lifecycle import と次の型・実装を追加する。期限到達時は record を active ledger に残し、callback 側の execution.dispose または owner dispose が ledger から外す。

~~~ts
import { IDisposable } from '../../base/common/lifecycle.js';

export interface IParadisTrackedChildProcess extends IDisposable {
	readonly timedOut: boolean;
}

export class ParadisChildProcessTreeTracker implements IDisposable {

	private readonly active = new Set<ParadisTrackedChildProcess>();
	private disposed = false;

	constructor(private readonly onError?: (error: unknown) => void) { }

	track(child: cp.ChildProcess, timeoutMs: number): IParadisTrackedChildProcess {
		const execution = new ParadisTrackedChildProcess(
			child,
			timeoutMs,
			this.onError,
			() => this.active.delete(execution),
		);
		if (this.disposed) {
			execution.killForOwnerDispose();
		} else {
			this.active.add(execution);
		}
		return execution;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const execution of [...this.active]) {
			execution.killForOwnerDispose();
		}
		this.active.clear();
	}
}

class ParadisTrackedChildProcess implements IParadisTrackedChildProcess {

	private timer: ReturnType<typeof setTimeout> | undefined;
	private completed = false;
	private killStarted = false;
	private _timedOut = false;

	get timedOut(): boolean {
		return this._timedOut;
	}

	constructor(
		private readonly child: cp.ChildProcess,
		timeoutMs: number,
		private readonly onError: ((error: unknown) => void) | undefined,
		private readonly onComplete: () => void,
	) {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this._timedOut = true;
			this.startKill();
		}, timeoutMs);
	}

	dispose(): void {
		this.complete();
	}

	killForOwnerDispose(): void {
		if (this.completed) {
			return;
		}
		this.clearTimer();
		this.startKill();
		this.complete();
	}

	private startKill(): void {
		if (this.killStarted) {
			return;
		}
		this.killStarted = true;
		paradisKillChildProcessTree(this.child, this.onError);
	}

	private complete(): void {
		if (this.completed) {
			return;
		}
		this.completed = true;
		this.clearTimer();
		this.onComplete();
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
~~~

- [ ] **Step 4: helper test を GREEN にする。**

  実行:

~~~sh
rtk npm run transpile-client
rtk ./scripts/test.sh --run src/vs/paradis/test/node/paradisKillChildProcess.test.ts
~~~

  期待: 3 tests pass。期限前は kill されず、期限到達と owner dispose は各 child を一度だけ kill し、全 timer が解除される。

- [ ] **Step 5: helper と回帰テストだけを commit する。**

~~~sh
rtk git diff --check -- src/vs/paradis/node/paradisKillChildProcess.ts src/vs/paradis/test/node/paradisKillChildProcess.test.ts
rtk git add src/vs/paradis/node/paradisKillChildProcess.ts src/vs/paradis/test/node/paradisKillChildProcess.test.ts
rtk git commit -m "fix: own child process tree timeouts explicitly"
~~~

---

### Task 2: 設計 #9 — ccusage、rtk、limitsMonitor を明示 timeout tracker へ接続する

**Files:**

- Modify: src/vs/paradis/contrib/ccusage/node/paradisCcusageChannel.ts
- Modify: src/vs/paradis/contrib/ccusage/test/node/paradisCcusageChannel.test.ts
- Create: src/vs/paradis/contrib/ccusage/test/node/paradisCcusageProcessLifecycle.test.ts
- Modify: src/vs/paradis/contrib/rtk/node/paradisRtkChannel.ts
- Create: src/vs/paradis/contrib/rtk/test/node/paradisRtkProcessLifecycle.test.ts
- Modify: src/vs/paradis/contrib/limitsMonitor/node/paradisLimitsMonitorChannel.ts
- Create: src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorProcessLifecycle.test.ts

**Interfaces:**

- Consume: ParadisChildProcessTreeTracker and IParadisTrackedChildProcess
- Preserve: ParadisCcusageService, ParadisRtkService, ParadisLimitsMonitorService public methods and channel response shapes
- Extend for tests only through a production-shaped default: ParadisLimitsMonitorService constructor final argument execFile defaults to cp.execFile
- Contract: execFile options no longer use Node timeout; tracker starts tree kill at the same 60,000 ms deadline. callback disposes its tracked execution. service dispose disposes the tracker.
- Contract: ccusage marks IParadisExecError.timedOut from trackedExecution.timedOut, so a timeout never triggers the offline retry.

- [ ] **Step 1: ccusage の deadline、timeout classification、Node timeout option 除去を表す failing test を作る。**

  src/vs/paradis/contrib/ccusage/test/node/paradisCcusageProcessLifecycle.test.ts を作成する。

~~~ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import * as sinon from 'sinon';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisCcusageService } from '../../node/paradisCcusageChannel.js';

suite('ParadisCcusage process lifecycle', () => {
	teardown(() => sinon.restore());

	test('tree-kills at 60 seconds and classifies the explicit deadline without an offline retry', async () => {
		const clock = sinon.useFakeTimers();
		const kill = sinon.spy(() => true);
		let callback: ((error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) | undefined;
		let timeoutOption: number | undefined;
		let invocations = 0;
		const execFile = ((_file: string, _args: readonly string[], options: cp.ExecFileOptionsWithStringEncoding, cb: typeof callback) => {
			invocations++;
			timeoutOption = options.timeout;
			callback = cb;
			return {
				pid: undefined,
				exitCode: null,
				signalCode: null,
				kill,
			} as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisCcusageService(new NullLogService(), undefined, undefined, execFile, () => clock.now);

		const pending = service.fetchDaily({ executablePath: '/test/ccusage' });
		while (!callback) {
			await Promise.resolve();
		}
		await clock.tickAsync(60_000);
		assert.strictEqual(kill.callCount, 1);
		assert.strictEqual(timeoutOption, undefined);

		callback!(Object.assign(new Error('terminated'), { killed: false }), '', 'terminated');
		await assert.rejects(pending, /terminated/);
		assert.strictEqual(invocations, 1, 'an explicitly timed out execution must not retry with --offline');
		service.dispose();
	});
});
~~~

  既存 src/vs/paradis/contrib/ccusage/test/node/paradisCcusageChannel.test.ts の bounds test は名前を owns each child deadline and preserves the output limit に変え、期待値だけを次へ変更する。

~~~ts
assert.deepStrictEqual(invocations[0], {
	file: '/test/ccusage',
	args: ['daily', '--json'],
	encoding: 'utf8',
	timeout: undefined,
	maxBuffer: 64 * 1024 * 1024,
	windowsHide: true,
});
~~~

- [ ] **Step 2: rtk の deadline と正常 callback 後の timer 解除を表す failing test を作る。**

  src/vs/paradis/contrib/rtk/test/node/paradisRtkProcessLifecycle.test.ts を作成する。

~~~ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import * as sinon from 'sinon';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisRtkService } from '../../node/paradisRtkChannel.js';

suite('ParadisRtk process lifecycle', () => {
	teardown(() => sinon.restore());

	test('owns the 60 second deadline and clears it after callback completion', async () => {
		const clock = sinon.useFakeTimers();
		const kills: sinon.SinonSpy[] = [];
		const callbacks: Array<(error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void> = [];
		const timeouts: Array<number | undefined> = [];
		const execFile = ((_file: string, _args: readonly string[], options: cp.ExecFileOptionsWithStringEncoding, callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			timeouts.push(options.timeout);
			callbacks.push(callback);
			const kill = sinon.spy(() => true);
			kills.push(kill);
			return { pid: undefined, exitCode: null, signalCode: null, kill } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisRtkService(new NullLogService(), undefined, undefined, execFile, () => clock.now, false);

		const timedOut = service.fetchSummary({ executablePath: '/test/rtk' });
		while (callbacks.length === 0) {
			await Promise.resolve();
		}
		await clock.tickAsync(60_000);
		assert.deepStrictEqual({ kills: kills[0].callCount, timeout: timeouts[0] }, { kills: 1, timeout: undefined });
		callbacks[0](Object.assign(new Error('terminated'), { killed: false }), '', 'terminated');
		await assert.rejects(timedOut, /terminated/);

		const completed = service.fetchSummary({ executablePath: '/test/rtk', bypassCache: true });
		while (callbacks.length < 2) {
			await Promise.resolve();
		}
		callbacks[1](null, JSON.stringify({ summary: { total: 1 } }), '');
		await completed;
		await clock.tickAsync(60_000);
		assert.strictEqual(kills[1].callCount, 0);
		service.dispose();
	});
});
~~~

- [ ] **Step 3: limitsMonitor の deadline と service dispose ownership を表す failing test を作る。**

  src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorProcessLifecycle.test.ts を作成する。

~~~ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import * as sinon from 'sinon';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisLimitsMonitorService } from '../../node/paradisLimitsMonitorChannel.js';

suite('ParadisLimitsMonitor process lifecycle', () => {
	teardown(() => sinon.restore());

	test('tree-kills cswap at its explicit deadline and does not leave a Node timeout', async () => {
		const clock = sinon.useFakeTimers();
		const kill = sinon.spy(() => true);
		let callback: ((error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) | undefined;
		let timeoutOption: number | undefined;
		const execFile = ((_file: string, _args: readonly string[], options: cp.ExecFileOptionsWithStringEncoding, cb: typeof callback) => {
			timeoutOption = options.timeout;
			callback = cb;
			return {
				pid: undefined,
				exitCode: null,
				signalCode: null,
				kill,
				stdin: { write() { }, end() { } },
			} as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisLimitsMonitorService(new NullLogService(), undefined, undefined, () => '/test/home', execFile);

		const pending = service.getSnapshot({ cswapPath: '/test/cswap', codexHomes: [] });
		while (!callback) {
			await Promise.resolve();
		}
		await clock.tickAsync(60_000);
		assert.deepStrictEqual({ kills: kill.callCount, timeout: timeoutOption }, { kills: 1, timeout: undefined });
		callback!(Object.assign(new Error('terminated'), { killed: false }), '', 'terminated');
		await pending;
		service.dispose();
	});

	test('service disposal cancels the deadline and terminates the active child once', async () => {
		const clock = sinon.useFakeTimers();
		const kill = sinon.spy(() => true);
		let started = false;
		const execFile = (() => {
			started = true;
			return { pid: undefined, exitCode: null, signalCode: null, kill } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisLimitsMonitorService(new NullLogService(), undefined, undefined, () => '/test/home', execFile);

		void service.getSnapshot({ cswapPath: '/test/cswap', codexHomes: [] });
		while (!started) {
			await Promise.resolve();
		}
		service.dispose();
		await clock.tickAsync(60_000);

		assert.strictEqual(kill.callCount, 1);
		assert.strictEqual(clock.countTimers(), 0);
	});
});
~~~

- [ ] **Step 4: 現行の Node timeout callback 依存が RED になることを確認する。**

  実行:

~~~sh
rtk npm run transpile-client
rtk ./scripts/test.sh \
  --run src/vs/paradis/contrib/ccusage/test/node/paradisCcusageProcessLifecycle.test.ts \
  --run src/vs/paradis/contrib/rtk/test/node/paradisRtkProcessLifecycle.test.ts \
  --run src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorProcessLifecycle.test.ts
~~~

  期待: limitsMonitor constructor の execFile 引数が未定義の段階では transpile が失敗する。constructor を test から呼べる最小署名だけ導入した後は、60,000 ms 時点の kill が 0、または options.timeout が 60,000 の assertion で失敗する。

- [ ] **Step 5: ccusage の実行と executable probe を tracker 所有へ移す。**

  src/vs/paradis/contrib/ccusage/node/paradisCcusageChannel.ts で Set<ChildProcess> を削除し、constructor で tracker を生成する。

~~~ts
import { IParadisTrackedChildProcess, ParadisChildProcessTreeTracker } from '../../../node/paradisKillChildProcess.js';

private readonly childProcesses: ParadisChildProcessTreeTracker;

this.childProcesses = new ParadisChildProcessTreeTracker(
	error => this.logService.trace('[ParadisCcusage] failed to stop child process: ' + error),
);
~~~

  exec の execution record、options、callback、登録を次の形にする。

~~~ts
const execution: { child?: cp.ChildProcess; tracked?: IParadisTrackedChildProcess; completed: boolean } = { completed: false };
execution.child = this.execFile(shimInvocation?.file ?? executable.command, shimInvocation?.args ?? fullArgs, {
	encoding: 'utf8',
	maxBuffer: EXEC_MAX_BUFFER,
	windowsHide: true,
	windowsVerbatimArguments: shimInvocation !== undefined,
	env: { ...env, NO_COLOR: '1', LOG_LEVEL: '0' }
}, (err, stdout, stderr) => {
	execution.completed = true;
	const timedOut = execution.tracked?.timedOut === true;
	execution.tracked?.dispose();
	if (err) {
		this.logService.warn('[ParadisCcusage] ' + executable.command + ' ' + fullArgs.join(' ') + ' failed: ' + (stderr || err.message));
		this.resolved = undefined;
		const execError: IParadisExecError = new Error(stderr?.trim() || err.message);
		execError.spawnFailed = (err as NodeJS.ErrnoException).code === 'ENOENT';
		execError.timedOut = timedOut;
		reject(execError);
	} else {
		resolve(stdout);
	}
});
if (!execution.completed && execution.child) {
	execution.tracked = this.childProcesses.track(execution.child, EXEC_TIMEOUT_MS);
}
~~~

  canExecute の 10 秒 probe も Node timeout option を外し、同じ tracker へ 10,000 ms で登録する。

~~~ts
const execution: { child?: cp.ChildProcess; tracked?: IParadisTrackedChildProcess; completed: boolean } = { completed: false };
execution.child = this.execFile(shimInvocation?.file ?? command, shimInvocation?.args ?? ['--version'], {
	windowsHide: true,
	windowsVerbatimArguments: shimInvocation !== undefined,
	env
}, err => {
	execution.completed = true;
	const timedOut = execution.tracked?.timedOut === true;
	execution.tracked?.dispose();
	resolve(!err && !timedOut);
});
if (!execution.completed && execution.child) {
	execution.tracked = this.childProcesses.track(execution.child, 10_000);
}
~~~

  service dispose の activeChildren loop を次の一行へ置換する。

~~~ts
this.childProcesses.dispose();
~~~

- [ ] **Step 6: rtk の実行を tracker 所有へ移す。**

  src/vs/paradis/contrib/rtk/node/paradisRtkChannel.ts に Task 1 の型を import し、constructor で次の tracker を生成する。

~~~ts
import { IParadisTrackedChildProcess, ParadisChildProcessTreeTracker } from '../../../node/paradisKillChildProcess.js';

private readonly childProcesses: ParadisChildProcessTreeTracker;

this.childProcesses = new ParadisChildProcessTreeTracker(
	error => this.logService.trace('[ParadisRtk] failed to stop child process: ' + error),
);
~~~

  execFile の options.timeout と callback 内の err.killed tree-kill を削除し、execution record を次へ置換する。

~~~ts
const execution: { child?: cp.ChildProcess; tracked?: IParadisTrackedChildProcess; completed: boolean } = { completed: false };
execution.child = this.execFile(shimInvocation?.file ?? command, shimInvocation?.args ?? args, {
	encoding: 'utf8',
	maxBuffer: EXEC_MAX_BUFFER,
	windowsHide: true,
	windowsVerbatimArguments: shimInvocation !== undefined,
	env: { ...env, NO_COLOR: '1' }
}, (err, stdout, stderr) => {
	execution.completed = true;
	execution.tracked?.dispose();
	if (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			this.logService.trace('[ParadisRtk] rtk executable not found (' + command + ')');
			reject(new Error(PARADIS_RTK_NOT_FOUND_MARKER + ': ' + command + ' was not found on PATH'));
			return;
		}
		this.logService.warn('[ParadisRtk] ' + command + ' ' + args.join(' ') + ' failed: ' + (stderr || err.message));
		reject(new Error(stderr?.trim() || err.message));
	} else {
		resolve(stdout);
	}
});
if (!execution.completed && execution.child) {
	execution.tracked = this.childProcesses.track(execution.child, EXEC_TIMEOUT_MS);
}
~~~

  dispose の activeChildren loop は this.childProcesses.dispose() へ置換する。

- [ ] **Step 7: limitsMonitor に production default を持つ execFile 注入点と tracker ownership を追加する。**

  src/vs/paradis/contrib/limitsMonitor/node/paradisLimitsMonitorChannel.ts の constructor 末尾へ execFile を追加し、tracker を初期化する。既存の login/app-server cleanup も paradisKillChildProcessTree を使うため、このファイルだけは3 symbolを一つの import にまとめる。

~~~ts
import { IParadisTrackedChildProcess, ParadisChildProcessTreeTracker, paradisKillChildProcessTree } from '../../../node/paradisKillChildProcess.js';

private readonly childProcesses: ParadisChildProcessTreeTracker;
private disposed = false;

constructor(
	private readonly logService: ILogService,
	configurationService?: IConfigurationService,
	args?: NativeParsedArgs,
	private readonly _homedir: () => string = os.homedir,
	private readonly _execFile: typeof cp.execFile = cp.execFile,
) {
	this.childProcesses = new ParadisChildProcessTreeTracker(
		error => this.logService.trace('[ParadisLimitsMonitor] failed to stop child process: ' + error),
	);
	this.cachedShellEnv = new ParadisCachedShellEnv(
		logService,
		'ParadisLimitsMonitor',
		createParadisShellEnvResolver(logService, configurationService, args),
		Date.now,
		reportParadisShellEnvDiagnosticError,
	);
}
~~~

  dispose 冒頭で disposed を立て、child tracker を破棄する。

~~~ts
dispose(): void {
	this.disposed = true;
	this.childProcesses.dispose();
	for (const session of this.setupSessions.values()) {
		session.dispose();
	}
	this.setupSessions.clear();
}
~~~

  private execFile は _execFile を使い、Node timeout option を除去して tracked execution を callback と結び付ける。

~~~ts
const execution: { tracked?: IParadisTrackedChildProcess; completed: boolean } = { completed: false };
const child = this._execFile(shimInvocation?.file ?? command, shimInvocation?.args ?? args, {
	encoding: 'utf8',
	maxBuffer: 16 * 1024 * 1024,
	windowsHide: true,
	windowsVerbatimArguments: shimInvocation !== undefined,
	env: { ...env, NO_COLOR: '1' },
}, (err, stdout, stderr) => {
	execution.completed = true;
	const timedOut = execution.tracked?.timedOut === true;
	execution.tracked?.dispose();
	if (err || timedOut) {
		const message = stderr?.trim() || (timedOut ? 'command timed out after ' + options.timeoutMs + 'ms' : err!.message);
		reject(new Error(message));
	} else {
		resolve(stdout);
	}
});
if (!execution.completed) {
	execution.tracked = this.childProcesses.track(child, options.timeoutMs);
}
if (options.stdin !== undefined) {
	child.stdin?.write(options.stdin);
	child.stdin?.end();
}
~~~

  canExecute も cp.execFile と options.timeout を使わず、this._execFile の child を 10,000 ms で tracker.track する。

~~~ts
private async canExecute(command: string): Promise<boolean> {
	const env = await this.getExecEnv();
	if (this.disposed) {
		return false;
	}
	const shimInvocation = process.platform === 'win32' ? paradisWrapWindowsScriptShim(command, ['--version']) : undefined;
	return new Promise<boolean>(resolve => {
		const execution: { child?: cp.ChildProcess; tracked?: IParadisTrackedChildProcess; completed: boolean } = { completed: false };
		execution.child = this._execFile(shimInvocation?.file ?? command, shimInvocation?.args ?? ['--version'], {
			windowsHide: true,
			windowsVerbatimArguments: shimInvocation !== undefined,
			env
		}, err => {
			execution.completed = true;
			const timedOut = execution.tracked?.timedOut === true;
			execution.tracked?.dispose();
			resolve(!err && !timedOut);
		});
		if (!execution.completed && execution.child) {
			execution.tracked = this.childProcesses.track(execution.child, 10_000);
		}
	});
}
~~~

  private execFile の getExecEnv fulfillment 直後にも disposed guard を置き、service dispose 後に遅れて環境解決した request が新しい child を起動しない。

~~~ts
if (this.disposed) {
	reject(new Error('ParadisLimitsMonitorService is disposed'));
	return;
}
~~~

- [ ] **Step 8: 三サービスの回帰テストと既存 ccusage suite を GREEN にする。**

  実行:

~~~sh
rtk npm run transpile-client
rtk ./scripts/test.sh \
  --run src/vs/paradis/test/node/paradisKillChildProcess.test.ts \
  --run src/vs/paradis/contrib/ccusage/test/node/paradisCcusageChannel.test.ts \
  --run src/vs/paradis/contrib/ccusage/test/node/paradisCcusageProcessLifecycle.test.ts \
  --run src/vs/paradis/contrib/rtk/test/node/paradisRtkProcessLifecycle.test.ts \
  --run src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorProcessLifecycle.test.ts \
  --run src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorCodexRemoval.test.ts
~~~

  期待: 全対象 test pass。3サービスとも execFile options.timeout は undefined、60,000 ms で tree kill が始まり、callback または service dispose 後の timer 数は 0。ccusage timeout は1回の invocation で reject し、--offline invocation を作らない。

- [ ] **Step 9: process ownership の呼出側変更を一つの commit にする。**

~~~sh
rtk git diff --check -- \
  src/vs/paradis/contrib/ccusage/node/paradisCcusageChannel.ts \
  src/vs/paradis/contrib/ccusage/test/node/paradisCcusageChannel.test.ts \
  src/vs/paradis/contrib/ccusage/test/node/paradisCcusageProcessLifecycle.test.ts \
  src/vs/paradis/contrib/rtk/node/paradisRtkChannel.ts \
  src/vs/paradis/contrib/rtk/test/node/paradisRtkProcessLifecycle.test.ts \
  src/vs/paradis/contrib/limitsMonitor/node/paradisLimitsMonitorChannel.ts \
  src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorProcessLifecycle.test.ts
rtk git add \
  src/vs/paradis/contrib/ccusage/node/paradisCcusageChannel.ts \
  src/vs/paradis/contrib/ccusage/test/node/paradisCcusageChannel.test.ts \
  src/vs/paradis/contrib/ccusage/test/node/paradisCcusageProcessLifecycle.test.ts \
  src/vs/paradis/contrib/rtk/node/paradisRtkChannel.ts \
  src/vs/paradis/contrib/rtk/test/node/paradisRtkProcessLifecycle.test.ts \
  src/vs/paradis/contrib/limitsMonitor/node/paradisLimitsMonitorChannel.ts \
  src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorProcessLifecycle.test.ts
rtk git commit -m "fix: terminate timed out CLI process trees before wrapper exit"
~~~

---

### Task 3: 設計 #10 — HTML preview tunnel を loopback 検証完了まで局所所有する

**Files:**

- Modify: src/vs/platform/tunnel/common/tunnel.ts
- Modify: src/vs/platform/tunnel/test/common/tunnel.test.ts
- Modify: src/vs/paradis/contrib/fileViewers/electron-browser/paradisHtmlPreviewClient.ts
- Create: src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlPreviewClient.test.ts

**Interfaces:**

- Exercise: ParadisRemotePreviewMounter.mount(directory)
- Add: getRemoteTunnelGeneration(tunnel): object
- Extend compatibly: ITunnelService.onTunnelClosed payload with readonly generation?: object
- Preserve: IParadisPreviewLocation and the existing service-worker fallback by rejection
- Contract: openTunnel が RemoteTunnel を返した時点から loopback 検証成功までは _openTunnel が所有する。検証失敗は一度だけ dispose し、検証成功は _tunnels ledger へ所有権を移す。
- Contract: AbstractTunnelServiceの一つのledger entryから返すleaseと、そのentryのclose eventは同じopaque generationを共有する。別generationの遅延closeは現行mounter entryを削除しない。

- [ ] **Step 1: 非 loopback 拒否時の一回 dispose と成功時の ownership transfer を表す failing test を追加する。**

  src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlPreviewClient.test.ts を作成する。

~~~ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IRemoteAuthorityResolverService } from '../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { ITunnelService, RemoteTunnel } from '../../../../../platform/tunnel/common/tunnel.js';
import { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { ParadisRemotePreviewMounter } from '../../electron-browser/paradisHtmlPreviewClient.js';

suite('ParadisRemotePreviewMounter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const resource = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/home/user/site' });

	function createMounter(localAddress: string): {
		readonly mounter: ParadisRemotePreviewMounter;
		readonly disposeCount: () => number;
		readonly openCount: () => number;
		readonly closeCurrent: () => void;
	} {
		const store = disposables.add(new DisposableStore());
		const tunnelClosed = store.add(new Emitter<{ host: string; port: number; generation?: object }>());
		let disposed = 0;
		let opened = 0;
		const tunnel = {
			tunnelRemotePort: 56789,
			tunnelRemoteHost: '127.0.0.1',
			tunnelLocalPort: 45678,
			localAddress,
			privacy: 'private',
			dispose: async () => { disposed++; },
		} as RemoteTunnel;
		const agent = {
			getConnection: () => ({
				remoteAuthority: 'ssh-remote+box',
				getChannel: () => ({
					call: async () => ({ port: 56789, token: '0123456789abcdef0123456789abcdef' }),
					listen: () => { throw new Error('not used'); },
				}),
			}),
		} as unknown as IRemoteAgentService;
		const resolver = {
			resolveAuthority: async () => ({
				authority: {
					authority: 'ssh-remote+box',
					connectTo: {},
					connectionToken: undefined,
				},
			}),
		} as unknown as IRemoteAuthorityResolverService;
		const tunnelService = {
			onTunnelClosed: tunnelClosed.event,
			openTunnel: async () => { opened++; return tunnel; },
		} as unknown as ITunnelService;
		return {
			mounter: store.add(new ParadisRemotePreviewMounter(agent, resolver, tunnelService)),
			disposeCount: () => disposed,
			openCount: () => opened,
			closeCurrent: () => tunnelClosed.fire({
				host: '127.0.0.1',
				port: 56789,
				generation: getRemoteTunnelGeneration(tunnel),
			}),
		};
	}

	test('disposes a non-loopback tunnel exactly once before rejecting it', async () => {
		const fixture = createMounter('0.0.0.0:45678');

		await assert.rejects(fixture.mounter.mount(resource), /not loopback/);
		assert.strictEqual(fixture.disposeCount(), 1);

		fixture.mounter.dispose();
		await Promise.resolve();
		assert.strictEqual(fixture.disposeCount(), 1);
	});

	test('transfers a loopback tunnel to the mounter until its disposal', async () => {
		const fixture = createMounter('127.0.0.1:45678');

		const location = await fixture.mounter.mount(resource);
		assert.strictEqual(location.port, 45678);
		assert.strictEqual(fixture.disposeCount(), 0);

		fixture.mounter.dispose();
		await Promise.resolve();
		assert.strictEqual(fixture.disposeCount(), 1);
	});
});
~~~

- [ ] **Step 2: 非 loopback tunnel が拒否されても disposeCount 0 の RED を確認する。**

  実行:

~~~sh
rtk npm run transpile-client
rtk ./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlPreviewClient.test.ts
~~~

  期待: disposes a non-loopback tunnel exactly once before rejecting it が actual 0 / expected 1 で失敗する。loopback success case は pass する。

- [ ] **Step 3: RemoteTunnel の検証区間を try/finally で局所所有する最小修正を入れる。**

  src/vs/paradis/contrib/fileViewers/electron-browser/paradisHtmlPreviewClient.ts の _openTunnel で string/undefined を拒否した直後から return までを次へ置換する。

~~~ts
const tunnel = tunnelOrError;
let transferred = false;
try {
	if (!isLoopbackAddress(tunnel.localAddress)) {
		throw new Error('The remote preview port was forwarded to ' + tunnel.localAddress + ', which is not loopback');
	}
	transferred = true;
	return tunnel;
} finally {
	if (!transferred) {
		await tunnel.dispose();
	}
}
~~~

  _tunnels の rejected Promise cleanup は残す。失敗時は Promise が map から外れるため mounter.dispose が同じ tunnel を二度 dispose せず、成功時だけ map が tunnel の owner になる。

- [ ] **Step 4: tunnel ownership test と既存 HTML editor test を GREEN にする。**

  実行:

~~~sh
rtk npm run transpile-client
rtk ./scripts/test.sh \
  --run src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlPreviewClient.test.ts \
  --run src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlFileEditor.test.ts
~~~

  期待: 全対象 test pass。非 loopback は rejection 前に disposeCount 1、loopback は mount 完了時 0 で mounter.dispose 後 1。

- [ ] **Step 5: HTML preview tunnel 修正を commit する。**

~~~sh
rtk git diff --check -- \
  src/vs/paradis/contrib/fileViewers/electron-browser/paradisHtmlPreviewClient.ts \
  src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlPreviewClient.test.ts
rtk git add \
  src/vs/paradis/contrib/fileViewers/electron-browser/paradisHtmlPreviewClient.ts \
  src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlPreviewClient.test.ts
rtk git commit -m "fix: dispose rejected HTML preview tunnels"
~~~

- [ ] **Step 6: 同一portの旧closeが新mounter generationを削除する failing test を追加する。**

  `paradisHtmlPreviewClient.test.ts` のtunnel importへ `getRemoteTunnelGeneration` を加え、二つのmounterが同じserviceを共有する次のtestを追加する。旧tunnelと新tunnelはport、local port、local addressを意図的に同じにし、公開field比較では区別できないfixtureにする。

~~~ts
test('keeps a new mounter tunnel when an older generation closes on the same port', async () => {
	const store = disposables.add(new DisposableStore());
	const tunnelClosed = store.add(new Emitter<{ host: string; port: number; generation?: object }>());
	let opened = 0;
	let oldDisposeStarted!: () => void;
	const oldDisposeStarting = new Promise<void>(resolve => oldDisposeStarted = resolve);
	let releaseOldDispose!: () => void;
	const oldDisposeFinished = new Promise<void>(resolve => releaseOldDispose = resolve);
	let newDisposed = 0;
	let duplicateDisposed = 0;
	const oldTunnel = {
		tunnelRemotePort: 56789,
		tunnelRemoteHost: '127.0.0.1',
		tunnelLocalPort: 45678,
		localAddress: '127.0.0.1:45678',
		privacy: 'private',
		dispose: async () => {
			oldDisposeStarted();
			await oldDisposeFinished;
			tunnelClosed.fire({ host: '127.0.0.1', port: 56789, generation: getRemoteTunnelGeneration(oldTunnel) });
		},
	} as RemoteTunnel;
	const newTunnel = {
		tunnelRemotePort: 56789,
		tunnelRemoteHost: '127.0.0.1',
		tunnelLocalPort: 45678,
		localAddress: '127.0.0.1:45678',
		privacy: 'private',
		dispose: async () => { newDisposed++; },
	} as RemoteTunnel;
	const duplicateTunnel = {
		...newTunnel,
		dispose: async () => { duplicateDisposed++; },
	} as RemoteTunnel;
	const agent = {
		getConnection: () => ({
			remoteAuthority: 'ssh-remote+box',
			getChannel: () => ({
				call: async () => ({ port: 56789, token: '0123456789abcdef0123456789abcdef' }),
				listen: () => { throw new Error('not used'); },
			}),
		}),
	} as unknown as IRemoteAgentService;
	const resolver = {
		resolveAuthority: async () => ({ authority: { authority: 'ssh-remote+box', connectTo: {}, connectionToken: undefined } }),
	} as unknown as IRemoteAuthorityResolverService;
	const tunnelService = {
		onTunnelClosed: tunnelClosed.event,
		openTunnel: async () => [oldTunnel, newTunnel, duplicateTunnel][opened++],
	} as unknown as ITunnelService;
	const oldMounter = store.add(new ParadisRemotePreviewMounter(agent, resolver, tunnelService));
	const newMounter = store.add(new ParadisRemotePreviewMounter(agent, resolver, tunnelService));

	await oldMounter.mount(resource);
	oldMounter.dispose();
	await oldDisposeStarting;
	await newMounter.mount(resource);
	releaseOldDispose();
	await Promise.resolve();
	await Promise.resolve();

	await newMounter.mount(resource);
	assert.strictEqual(opened, 2);
	newMounter.dispose();
	await Promise.resolve();
	assert.strictEqual(newDisposed, 1);
	assert.strictEqual(duplicateDisposed, 0);
});

test('drops the current generation so the next mount reopens it', async () => {
	const fixture = createMounter('127.0.0.1:45678');
	await fixture.mounter.mount(resource);
	fixture.closeCurrent();
	await Promise.resolve();
	await Promise.resolve();
	await fixture.mounter.mount(resource);
	assert.strictEqual(fixture.openCount(), 2);
});
~~~

  `tunnel.test.ts` へ `IAddressProvider`、`NullLogService`、`TestConfigurationService`、`AbstractTunnelService`、`getRemoteTunnelGeneration`、`ITunnelProvider`、`RemoteTunnel`、`TunnelCloseEvent`をimportし、次のtest subclassとtestを追加する。provider fixtureは一回目と二回目で別の`RemoteTunnel`を返す。

~~~ts
class TestTunnelService extends AbstractTunnelService {
	override isPortPrivileged(): boolean { return false; }

	protected override retainOrCreateTunnel(
		addressProvider: IAddressProvider | ITunnelProvider,
		remoteHost: string,
		remotePort: number,
		_localHost: string,
		localPort: number | undefined,
		elevateIfNeeded: boolean,
		privacy?: string,
		protocol?: string,
	): Promise<RemoteTunnel | string | undefined> | undefined {
		const existing = this.getTunnelFromMap(remoteHost, remotePort);
		if (existing) {
			existing.refcount++;
			return existing.value;
		}
		return this.createWithProvider(addressProvider as ITunnelProvider, remoteHost, remotePort, localPort, elevateIfNeeded, privacy, protocol);
	}
}

test('keeps the disposed ledger generation on a delayed close event', async () => {
	let oldDisposeStarted!: () => void;
	const oldDisposeStarting = new Promise<void>(resolve => oldDisposeStarted = resolve);
	let releaseOldDispose!: () => void;
	const oldDisposeFinished = new Promise<void>(resolve => releaseOldDispose = resolve);
	const firstTunnel: RemoteTunnel = {
		tunnelRemoteHost: '127.0.0.1', tunnelRemotePort: 56789,
		localAddress: '127.0.0.1:45678', privacy: 'private',
		dispose: async () => { oldDisposeStarted(); await oldDisposeFinished; },
	};
	const secondTunnel: RemoteTunnel = {
		tunnelRemoteHost: '127.0.0.1', tunnelRemotePort: 56789,
		localAddress: '127.0.0.1:45678', privacy: 'private',
		dispose: async () => { },
	};
	let opened = 0;
	const service = new TestTunnelService(new NullLogService(), new TestConfigurationService());
	const provider = service.setTunnelProvider({
		forwardPort: () => Promise.resolve([firstTunnel, secondTunnel][opened++]),
	});
	const closedEvents: TunnelCloseEvent[] = [];
	const closeListener = service.onTunnelClosed(event => closedEvents.push(event));
	try {
		const firstLease = await service.openTunnel(undefined, '127.0.0.1', 56789);
		assert.ok(firstLease && typeof firstLease !== 'string');
		const closing = firstLease.dispose();
		await oldDisposeStarting;
		const secondLease = await service.openTunnel(undefined, '127.0.0.1', 56789);
		assert.ok(secondLease && typeof secondLease !== 'string');
		releaseOldDispose();
		await closing;

		assert.notStrictEqual(getRemoteTunnelGeneration(firstLease), getRemoteTunnelGeneration(secondLease));
		assert.strictEqual(closedEvents[0].generation, getRemoteTunnelGeneration(firstLease));
		assert.notStrictEqual(closedEvents[0].generation, getRemoteTunnelGeneration(secondLease));
		await secondLease.dispose();
	} finally {
		closeListener.dispose();
		provider.dispose();
		await service.dispose();
	}
});
~~~

- [ ] **Step 7: generation未実装のREDを確認する。**

~~~sh
rtk npm run transpile-client
rtk xvfb-run -a ./scripts/test.sh --no-sandbox \
  --run src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlPreviewClient.test.ts \
  --run src/vs/platform/tunnel/test/common/tunnel.test.ts
~~~

  期待: mounter競合testは `opened` がactual 3 / expected 2で失敗する。基盤testはgeneration APIが未定義のため、最初はtranspile failureをREDとしてよい。

- [ ] **Step 8: shared tunnel ledgerとmounterへopaque generationを実装する。**

  `tunnel.ts` に後方互換のoptional payloadとlease accessorを追加する。追加blockには理由を記した`PARA-PATCH`を付ける。

~~~ts
// PARA-PATCH: A delayed close event for an old tunnel must not clear a newer
// Para preview lease that reused the same remote port.
const remoteTunnelGenerations = new WeakMap<RemoteTunnel, object>();

export function getRemoteTunnelGeneration(tunnel: RemoteTunnel): object {
	return remoteTunnelGenerations.get(tunnel) ?? tunnel;
}

export interface TunnelCloseEvent {
	readonly host: string;
	readonly port: number;
	readonly generation?: object;
}

interface TunnelEntry {
	refcount: number;
	readonly value: Promise<RemoteTunnel | string | undefined>;
	readonly generation: object;
}
~~~

  `ITunnelService.onTunnelClosed`、`AbstractTunnelService._onTunnelClosed`を`Event<TunnelCloseEvent>`へ変更する。`_tunnels`は`TunnelEntry`を保持する。`addTunnelToMap`はentryごとに一つgenerationを作り、provider tunnelにも同じgenerationを関連付ける。

~~~ts
const generation = {};
void tunnel.then(value => {
	if (value && typeof value !== 'string') {
		remoteTunnelGenerations.set(value, generation);
	}
}, () => { });
this._tunnels.get(remoteHost)!.set(remotePort, { refcount: 1, value: tunnel, generation });
~~~

  `openTunnel`は`retainOrCreateTunnel`直後のentry generationを取得して`makeTunnel`へ渡す。`makeTunnel`は返却leaseをWeakMapへ関連付け、`tryDisposeTunnel`はdispose開始時に受け取ったentryのgenerationをclose eventへ載せる。

~~~ts
const generation = this.getTunnelFromMap(remoteHost, remotePort)?.generation ?? {};
// resolvedTunnel.then内
const newTunnel = this.makeTunnel(tunnel, generation);

private makeTunnel(tunnel: RemoteTunnel, generation: object): RemoteTunnel {
	const lease: RemoteTunnel = {
		tunnelRemotePort: tunnel.tunnelRemotePort,
		tunnelRemoteHost: tunnel.tunnelRemoteHost,
		tunnelLocalPort: tunnel.tunnelLocalPort,
		localAddress: tunnel.localAddress,
		privacy: tunnel.privacy,
		protocol: tunnel.protocol,
		dispose: async () => {
			const existing = this._tunnels.get(tunnel.tunnelRemoteHost)?.get(tunnel.tunnelRemotePort);
			if (existing) {
				existing.refcount--;
				await this.tryDisposeTunnel(tunnel.tunnelRemoteHost, tunnel.tunnelRemotePort, existing);
			}
		}
	};
	remoteTunnelGenerations.set(lease, generation);
	return lease;
}

private async tryDisposeTunnel(remoteHost: string, remotePort: number, entry: TunnelEntry): Promise<void> {
	if (entry.refcount <= 0) {
		const disposePromise = entry.value.then(async tunnel => {
			if (tunnel && typeof tunnel !== 'string') {
				await tunnel.dispose(true);
				this._onTunnelClosed.fire({
					host: tunnel.tunnelRemoteHost,
					port: tunnel.tunnelRemotePort,
					generation: entry.generation,
				});
			}
		});
		this._tunnels.get(remoteHost)?.delete(remotePort);
		return disposePromise;
	}
}
~~~

  `paradisHtmlPreviewClient.ts`はevent受信時のcurrent Promiseを捕捉する。generation付き通知はPromiseとgenerationの両方が現行の場合だけ削除し、generationなし通知は従来どおりportで削除する。

~~~ts
this._register(this._tunnelService.onTunnelClosed(({ port, generation }) => {
	const current = this._tunnels.get(port);
	if (!current) {
		return;
	}
	if (generation === undefined) {
		this._tunnels.delete(port);
		return;
	}
	current.then(tunnel => {
		if (this._tunnels.get(port) === current && getRemoteTunnelGeneration(tunnel) === generation) {
			this._tunnels.delete(port);
		}
	}, () => { });
}));
~~~

- [ ] **Step 9: shared generation、stale close、通常closeをGREENにする。**

~~~sh
rtk npm run transpile-client
rtk xvfb-run -a ./scripts/test.sh --no-sandbox \
  --run src/vs/platform/tunnel/test/common/tunnel.test.ts \
  --run src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlPreviewClient.test.ts \
  --run src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlFileEditor.test.ts
~~~

  期待: 同じledger entryのleaseは同じgeneration、再作成entryは別generation、旧close eventは旧generationを保持する。mounterは旧close後も新entryを再利用し、現行generationのcloseではentryを除去して次のmountで再openする。

- [ ] **Step 10: upstream markerと拡張Filesを検証してcommitする。**

~~~sh
rtk npm run typecheck-client
rtk npm run eslint -- \
  src/vs/platform/tunnel/common/tunnel.ts \
  src/vs/platform/tunnel/test/common/tunnel.test.ts \
  src/vs/paradis/contrib/fileViewers/electron-browser/paradisHtmlPreviewClient.ts \
  src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlPreviewClient.test.ts
rtk npm run valid-layers-check
rtk git diff --check -- \
  src/vs/platform/tunnel/common/tunnel.ts \
  src/vs/platform/tunnel/test/common/tunnel.test.ts \
  src/vs/paradis/contrib/fileViewers/electron-browser/paradisHtmlPreviewClient.ts \
  src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlPreviewClient.test.ts
rtk git add \
  src/vs/platform/tunnel/common/tunnel.ts \
  src/vs/platform/tunnel/test/common/tunnel.test.ts \
  src/vs/paradis/contrib/fileViewers/electron-browser/paradisHtmlPreviewClient.ts \
  src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlPreviewClient.test.ts
rtk git commit -m "fix: preserve current preview tunnel generation"
~~~

---

### Task 4: 設計 #13 — Release notes modal と fetch CTS を identity 付き世代として所有する

**Files:**

- Create: src/vs/paradis/contrib/releaseNotes/electron-browser/paradisChangelogLifecycle.ts
- Create: src/vs/paradis/contrib/releaseNotes/test/electron-browser/paradisChangelogLifecycle.test.ts
- Modify: src/vs/paradis/contrib/releaseNotes/electron-browser/paradisChangelogModal.ts
- Modify: src/vs/paradis/contrib/releaseNotes/electron-browser/paradisReleaseNotes.contribution.ts

**Interfaces:**

- Add: IParadisChangelogLifecycleModal with onDidDispose and dispose
- Add: IParadisChangelogGeneration with modal, token, isCurrent(), finishFetch()
- Add: ParadisChangelogLifecycle.open(factory)
- Add: ParadisChangelogModal.onDidDispose
- Preserve: openParadisChangelogModal command behavior, cache keys, request timeout, storage writes and modal rendering
- Contract: reopen cancels and disposes the previous fetch CTS before disposing the old modal. user close cancels the current CTS and clears current identity. old Promise completion can update neither cache nor DOM.

- [ ] **Step 1: 世代交代、modal close、古い finally、遅延結果拒否を表す failing test を作る。**

  src/vs/paradis/contrib/releaseNotes/test/electron-browser/paradisChangelogLifecycle.test.ts を作成する。

~~~ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisChangelogLifecycle } from '../../electron-browser/paradisChangelogLifecycle.js';

class TestModal {
	private readonly _onDidDispose = new Emitter<void>();
	readonly onDidDispose = this._onDidDispose.event;
	disposeCount = 0;
	beforeDispose: (() => void) | undefined;

	dispose(): void {
		if (this.disposeCount !== 0) {
			return;
		}
		this.disposeCount++;
		this.beforeDispose?.();
		this._onDidDispose.fire();
		this._onDidDispose.dispose();
	}
}

suite('ParadisChangelogLifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reopen cancels the old fetch, disposes the old modal and keeps the new generation current', () => {
		const lifecycle = new ParadisChangelogLifecycle<TestModal>();
		const firstModal = new TestModal();
		const first = lifecycle.open(() => firstModal);
		firstModal.beforeDispose = () => assert.strictEqual(
			first.token.isCancellationRequested,
			true,
			'reopen must cancel the fetch before disposing its modal',
		);
		const secondModal = new TestModal();
		const second = lifecycle.open(() => secondModal);

		assert.strictEqual(first.token.isCancellationRequested, true);
		assert.strictEqual(firstModal.disposeCount, 1);
		assert.strictEqual(first.isCurrent(), false);
		assert.strictEqual(second.isCurrent(), true);

		first.finishFetch();
		assert.strictEqual(second.isCurrent(), true, 'an old finally must not clear the current generation');
		lifecycle.dispose();
		assert.strictEqual(second.token.isCancellationRequested, true);
		assert.strictEqual(secondModal.disposeCount, 1);
	});

	test('closing the modal cancels its current fetch and clears the generation', () => {
		const lifecycle = new ParadisChangelogLifecycle<TestModal>();
		const modal = new TestModal();
		const generation = lifecycle.open(() => modal);

		modal.dispose();

		assert.strictEqual(generation.token.isCancellationRequested, true);
		assert.strictEqual(generation.isCurrent(), false);
		lifecycle.dispose();
		assert.strictEqual(modal.disposeCount, 1);
	});

	test('a late result from the replaced generation cannot publish', async () => {
		const lifecycle = new ParadisChangelogLifecycle<TestModal>();
		let resolveFirst!: (value: string) => void;
		const firstResult = new Promise<string>(resolve => resolveFirst = resolve);
		const first = lifecycle.open(() => new TestModal());
		const published: string[] = [];
		const firstWork = firstResult
			.then(value => {
				if (first.isCurrent()) {
					published.push(value);
				}
			})
			.finally(() => first.finishFetch());

		const second = lifecycle.open(() => new TestModal());
		resolveFirst('stale');
		await firstWork;

		assert.deepStrictEqual(published, []);
		assert.strictEqual(second.isCurrent(), true);
		lifecycle.dispose();
	});
});
~~~

- [ ] **Step 2: lifecycle module が存在しない RED を確認する。**

  実行:

~~~sh
rtk npm run transpile-client
~~~

  期待: paradisChangelogLifecycle.js を解決できず、新規 test の import で transpile が失敗する。

- [ ] **Step 3: modal と CTS を一つの identity で扱う lifecycle owner を実装する。**

  src/vs/paradis/contrib/releaseNotes/electron-browser/paradisChangelogLifecycle.ts を作成する。

~~~ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';

export interface IParadisChangelogLifecycleModal extends IDisposable {
	readonly onDidDispose: Event<void>;
}

export interface IParadisChangelogGeneration<TModal extends IParadisChangelogLifecycleModal> {
	readonly modal: TModal;
	readonly token: CancellationToken;
	isCurrent(): boolean;
	finishFetch(): void;
}

interface IParadisChangelogEntry<TModal extends IParadisChangelogLifecycleModal> {
	readonly modal: TModal;
	readonly cts: CancellationTokenSource;
	closeListener: IDisposable;
	retired: boolean;
	fetchFinished: boolean;
}

export class ParadisChangelogLifecycle<TModal extends IParadisChangelogLifecycleModal> extends Disposable {

	private active: IParadisChangelogEntry<TModal> | undefined;

	open(factory: () => TModal): IParadisChangelogGeneration<TModal> {
		if (this.active) {
			this.retire(this.active, true);
		}

		const modal = factory();
		const entry: IParadisChangelogEntry<TModal> = {
			modal,
			cts: new CancellationTokenSource(),
			closeListener: Disposable.None,
			retired: false,
			fetchFinished: false,
		};
		entry.closeListener = modal.onDidDispose(() => this.retire(entry, false));
		this.active = entry;

		return {
			modal,
			token: entry.cts.token,
			isCurrent: () => this.active === entry && !entry.retired,
			finishFetch: () => this.finishFetch(entry),
		};
	}

	private finishFetch(entry: IParadisChangelogEntry<TModal>): void {
		if (this.active !== entry || entry.retired || entry.fetchFinished) {
			return;
		}
		entry.fetchFinished = true;
		entry.cts.dispose();
	}

	private retire(entry: IParadisChangelogEntry<TModal>, disposeModal: boolean): void {
		if (entry.retired) {
			return;
		}
		entry.retired = true;
		if (this.active === entry) {
			this.active = undefined;
		}
		if (!entry.fetchFinished) {
			entry.cts.cancel();
			entry.cts.dispose();
			entry.fetchFinished = true;
		}
		entry.closeListener.dispose();
		if (disposeModal) {
			entry.modal.dispose();
		}
	}

	override dispose(): void {
		if (this.active) {
			this.retire(this.active, true);
		}
		super.dispose();
	}
}
~~~

- [ ] **Step 4: ParadisChangelogModal から close/dispose を lifecycle owner へ通知する。**

  src/vs/paradis/contrib/releaseNotes/electron-browser/paradisChangelogModal.ts の Emitter import、class field、dispose を次の形にする。

~~~ts
import { Emitter } from '../../../../base/common/event.js';

private readonly _onDidDispose = this._register(new Emitter<void>());
readonly onDidDispose = this._onDidDispose.event;

override dispose(): void {
	if (this.closed) {
		return;
	}
	this.closed = true;
	this.overlay.remove();
	this._onDidDispose.fire();
	super.dispose();
}
~~~

- [ ] **Step 5: contribution の module-level refs を lifecycle generation に置換する。**

  src/vs/paradis/contrib/releaseNotes/electron-browser/paradisReleaseNotes.contribution.ts で activeFetchCts と activeModal を削除し、owner を一つ作る。

~~~ts
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ParadisChangelogLifecycle } from './paradisChangelogLifecycle.js';

const changelogLifecycle = new ParadisChangelogLifecycle<ParadisChangelogModal>();
~~~

  openParadisChangelogModal 内の既存 modal dispose/create、CTS create を次の generation 作成へ置換する。

~~~ts
const generation = changelogLifecycle.open(() => new ParadisChangelogModal(
	layoutService.activeContainer,
	{
		releases: toViewReleases(mergeChangelogs(cachedRemoteReleases, bundledReleases), installedVersion),
		installedVersion
	},
	{
		initialLastReadVersion,
		onSelectRelease: version => storageService.store(PARADIS_CHANGELOG_LAST_READ_KEY, version, StorageScope.APPLICATION, StorageTarget.MACHINE),
		onCheckForUpdate: () => commandService.executeCommand('update.checkForUpdate')
	}
));
const modal = generation.modal;
const token = generation.token;
~~~

  updateUrl がない分岐は generation.finishFetch() を呼んでから return する。fetch continuation は cache/store/DOM を触る前に generation identity を検査し、finally で自分の fetch CTS だけを終える。

~~~ts
if (!changelogFeedUrl(productService)) {
	generation.finishFetch();
	return;
}

modal.setRemoteState({ kind: 'fetching' });
fetchRemoteChangelogMd(requestService, productService, token).then(remoteMd => {
	if (!generation.isCurrent() || token.isCancellationRequested) {
		return;
	}
	if (!remoteMd) {
		modal.setRemoteState({ kind: 'error' });
		return;
	}
	storageService.store(PARADIS_CHANGELOG_REMOTE_CACHE_KEY, remoteMd, StorageScope.APPLICATION, StorageTarget.MACHINE);
	const fetchedAt = Date.now();
	storageService.store(PARADIS_CHANGELOG_FETCHED_AT_KEY, fetchedAt, StorageScope.APPLICATION, StorageTarget.MACHINE);
	modal.setRemoteState({ kind: 'ok', fetchedAt });
	const remoteReleases = parseParadisChangelog(remoteMd);
	if (remoteReleases.length > 0) {
		modal.applyReleases({
			releases: toViewReleases(mergeChangelogs(remoteReleases, bundledReleases), installedVersion),
			installedVersion
		});
	}
}).catch(() => {
	if (generation.isCurrent() && !token.isCancellationRequested) {
		modal.setRemoteState({ kind: 'error' });
	}
}).finally(() => generation.finishFetch());
~~~

- [ ] **Step 6: lifecycle unit test を GREEN にし、既存 changelog model test も維持する。**

  実行:

~~~sh
rtk npm run transpile-client
rtk ./scripts/test.sh \
  --run src/vs/paradis/contrib/releaseNotes/test/electron-browser/paradisChangelogLifecycle.test.ts \
  --run src/vs/paradis/contrib/releaseNotes/test/common/paradisChangelogModel.test.ts
~~~

  期待: 全対象 test pass。reopen と modal close は対象 token を cancel し、古い finishFetch は新 generation の isCurrent を変えず、stale result は publish されない。

- [ ] **Step 7: Release notes 世代 ownership を commit する。**

~~~sh
rtk git diff --check -- \
  src/vs/paradis/contrib/releaseNotes/electron-browser/paradisChangelogLifecycle.ts \
  src/vs/paradis/contrib/releaseNotes/test/electron-browser/paradisChangelogLifecycle.test.ts \
  src/vs/paradis/contrib/releaseNotes/electron-browser/paradisChangelogModal.ts \
  src/vs/paradis/contrib/releaseNotes/electron-browser/paradisReleaseNotes.contribution.ts
rtk git add \
  src/vs/paradis/contrib/releaseNotes/electron-browser/paradisChangelogLifecycle.ts \
  src/vs/paradis/contrib/releaseNotes/test/electron-browser/paradisChangelogLifecycle.test.ts \
  src/vs/paradis/contrib/releaseNotes/electron-browser/paradisChangelogModal.ts \
  src/vs/paradis/contrib/releaseNotes/electron-browser/paradisReleaseNotes.contribution.ts
rtk git commit -m "fix: bind release notes fetches to modal generations"
~~~

---

### Task 5: 追加確定 #16 — 両 PTY starter の EventEmitter listener identity を保持して解除する

**Files:**

- Create: src/vs/paradis/contrib/ptyDaemon/test/electron-main/paradisPtyHostStarterLifecycle.test.ts
- Modify: src/vs/paradis/contrib/ptyDaemon/electron-main/paradisDaemonPtyHostStarter.ts
- Modify with PARA-PATCH: src/vs/platform/terminal/electron-main/electronPtyHostStarter.ts

**Interfaces:**

- Preserve: IPtyHostStarter, onRequestConnection, onWillShutdown and vscode:createPtyHostMessageChannel
- Add private named listener field to ParadisDaemonPtyHostStarter
- Add private named listener field to ElectronPtyHostStarter
- Contract: each constructor adds exactly one listener to its injected EventEmitter-compatible IPC source and each starter.dispose returns listenerCount(channel) to its pre-construction baseline. Production defaults remain validatedIpcMain.

- [ ] **Step 1: identity-sensitive fake EventEmitter で daemon/fallback 双方の listener count を固定する failing test を作る。**

  src/vs/paradis/contrib/ptyDaemon/test/electron-main/paradisPtyHostStarterLifecycle.test.ts を作成する。

~~~ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { EventEmitter } from 'events';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ElectronPtyHostStarter } from '../../../../../platform/terminal/electron-main/electronPtyHostStarter.js';
import { ParadisDaemonPtyHostStarter } from '../../electron-main/paradisDaemonPtyHostStarter.js';

const CHANNEL = 'vscode:createPtyHostMessageChannel';
const reconnectConstants = { graceTime: 60_000, shortGraceTime: 6_000, scrollback: 100 };
const daemonPaths = {
	socketPath: '/tmp/paradis-pty-test.sock',
	buildKey: 'test-key',
	ledgerDir: '/tmp/paradis-pty-test',
	ledgerFile: '/tmp/paradis-pty-test/test-key.json',
	socketPathTooLong: false,
};

suite('PTY host starter lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function lifecycleService(): ILifecycleMainService {
		return { onWillShutdown: Event.None } as unknown as ILifecycleMainService;
	}

	function assertReturnsToBaseline(create: (ipc: EventEmitter) => { dispose(): void }): void {
		const ipc = new EventEmitter();
		const baseline = ipc.listenerCount(CHANNEL);
		const starter = create(ipc);
		assert.strictEqual(ipc.listenerCount(CHANNEL), baseline + 1);
		starter.dispose();
		assert.strictEqual(ipc.listenerCount(CHANNEL), baseline);
	}

	test('daemon starter removes its message-channel listener on dispose', () => {
		assertReturnsToBaseline(ipc => new ParadisDaemonPtyHostStarter(
			reconnectConstants,
			daemonPaths,
			'test-build',
			Object.create(null) as IEnvironmentMainService,
			lifecycleService(),
			new NullLogService(),
			ipc as never,
		));
	});

	test('fallback starter removes its message-channel listener on dispose', () => {
		assertReturnsToBaseline(ipc => new ElectronPtyHostStarter(
			reconnectConstants,
			{ getValue: () => undefined } as unknown as IConfigurationService,
			Object.create(null) as IEnvironmentMainService,
			lifecycleService(),
			new NullLogService(),
			ipc as never,
		));
	});
});
~~~

- [ ] **Step 2: removeHandler が EventEmitter listener を減らさない RED を確認する。**

  実行:

~~~sh
rtk npm run transpile-client
rtk ./scripts/test.sh --run src/vs/paradis/contrib/ptyDaemon/test/electron-main/paradisPtyHostStarterLifecycle.test.ts
~~~

  期待: まず両 constructor に IPC source 引数がないため extra argument の transpile error で失敗する。注入引数だけを追加した状態では、removeHandler または anonymous listener により dispose 後 listenerCount が baseline + 1 のまま残り、baseline 期待で失敗する。

- [ ] **Step 3: daemon starter を named listener と removeListener へ変更する。**

  src/vs/paradis/contrib/ptyDaemon/electron-main/paradisDaemonPtyHostStarter.ts の class field と constructor 登録を次にする。

~~~ts
private readonly onCreatePtyHostMessageChannel = (event: IpcMainEvent, nonce: string): void => {
	this.onWindowConnection(event, nonce);
};

constructor(
	private readonly reconnectConstants: IReconnectConstants,
	private readonly paths: IParadisPtyDaemonPaths,
	private readonly buildId: string,
	@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
	@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
	@ILogService private readonly logService: ILogService,
	private readonly ipcMain: Pick<typeof validatedIpcMain, 'on' | 'removeListener'> = validatedIpcMain,
) {
	super();

	this._register(this.lifecycleMainService.onWillShutdown(() => this._onWillShutdown.fire()));
	this.ipcMain.on('vscode:createPtyHostMessageChannel', this.onCreatePtyHostMessageChannel);
	this._register(toDisposable(() => {
		this.ipcMain.removeListener('vscode:createPtyHostMessageChannel', this.onCreatePtyHostMessageChannel);
	}));
}
~~~

  ipcMain parameter は constructor の logService parameter の後ろに置く。factory の既存6引数呼出しは default validatedIpcMain を使い、test の7引数呼出しだけが EventEmitter を使う。

  removeHandler 呼出しと anonymous arrow 登録を削除する。validatedIpcMain が listener から wrapper を引く WeakMap を持つため、登録と解除に同じ field identity を渡す。

- [ ] **Step 4: upstream fallback starter に理由付き PARA-PATCH と同じ identity 修正を入れる。**

  src/vs/platform/terminal/electron-main/electronPtyHostStarter.ts の class field と constructor を次にする。PARA-PATCH は upstream 所有ファイル内で差分理由を保持するため削除しない。

~~~ts
// PARA-PATCH: retain the listener identity so disposing the PTY starter removes the Electron IPC subscription.
private readonly _onCreatePtyHostMessageChannel = (event: IpcMainEvent, nonce: string): void => {
	this._onWindowConnection(event, nonce);
};

constructor(
	private readonly _reconnectConstants: IReconnectConstants,
	@IConfigurationService private readonly _configurationService: IConfigurationService,
	@IEnvironmentMainService private readonly _environmentMainService: IEnvironmentMainService,
	@ILifecycleMainService private readonly _lifecycleMainService: ILifecycleMainService,
	@ILogService private readonly _logService: ILogService,
	// PARA-PATCH: inject the validated IPC source only so listener ownership can be tested without a main-process global.
	private readonly _ipcMain: Pick<typeof validatedIpcMain, 'on' | 'removeListener'> = validatedIpcMain,
) {
	super();

	this._register(this._lifecycleMainService.onWillShutdown(() => this._onWillShutdown.fire()));
	// Listen for new windows to establish connection directly to pty host
	// PARA-PATCH: unregister the exact EventEmitter listener instead of removing an unrelated invoke handler.
	this._ipcMain.on('vscode:createPtyHostMessageChannel', this._onCreatePtyHostMessageChannel);
	this._register(toDisposable(() => {
		this._ipcMain.removeListener('vscode:createPtyHostMessageChannel', this._onCreatePtyHostMessageChannel);
	}));
}
~~~

  _ipcMain parameter は constructor の _logService parameter の後ろに置く。既存 factory の5引数呼出しは production default を維持し、test の6引数呼出しだけが fake EventEmitter を使う。

- [ ] **Step 5: 両 starter が baseline へ戻る GREEN を確認する。**

  実行:

~~~sh
rtk npm run transpile-client
rtk ./scripts/test.sh --run src/vs/paradis/contrib/ptyDaemon/test/electron-main/paradisPtyHostStarterLifecycle.test.ts
~~~

  期待: 2 tests pass。各 constructor 直後は fake EventEmitter の baseline + 1、dispose 直後は baseline。同一 listener identity を要求する removeListener でのみ観測値が戻り、Electron invoke handler 用 removeHandler はこの channel で呼ばれない。

- [ ] **Step 6: PTY listener lifecycle 修正を commit する。**

~~~sh
rtk git diff --check -- \
  src/vs/paradis/contrib/ptyDaemon/test/electron-main/paradisPtyHostStarterLifecycle.test.ts \
  src/vs/paradis/contrib/ptyDaemon/electron-main/paradisDaemonPtyHostStarter.ts \
  src/vs/platform/terminal/electron-main/electronPtyHostStarter.ts
rtk git add \
  src/vs/paradis/contrib/ptyDaemon/test/electron-main/paradisPtyHostStarterLifecycle.test.ts \
  src/vs/paradis/contrib/ptyDaemon/electron-main/paradisDaemonPtyHostStarter.ts \
  src/vs/platform/terminal/electron-main/electronPtyHostStarter.ts
rtk git commit -m "fix: release PTY host IPC listeners on dispose"
~~~

---

### Task 6: 追加確定 #18 — Keep Awake の requested state と所有済み blocker state を分離する

**Files:**

- Create: src/vs/paradis/contrib/keepAwake/common/paradisKeepAwakeController.ts
- Create: src/vs/paradis/contrib/keepAwake/test/common/paradisKeepAwakeController.test.ts
- Modify: src/vs/paradis/contrib/keepAwake/electron-browser/paradisKeepAwake.contribution.ts
- Test unchanged: src/vs/paradis/contrib/keepAwake/test/common/paradisKeepAwake.test.ts

**Interfaces:**

- Add: ParadisKeepAwakeFailureOperation = blocker-start-failed | blocker-stop-failed
- Add: IParadisKeepAwakeControllerOptions with start, stop, onDidChangeMode, report
- Add: ParadisKeepAwakeController.actualMode, setMode(mode), reconcile(), whenSettled(), dispose()
- Preserve: PARADIS_KEEP_AWAKE_SETTING, statusbar labels/tooltips, Quick Pick commands and PowerSaveBlockerType mapping
- Contract: start が resolve した ID だけを Map<number, system|display> に加える。stop が resolve した ID だけを Map から消す。
- Contract: actualMode は owned Map の最大強度 display > system > off。statusbar は actualMode だけを描画する。
- Contract: setMode calls are serialized。pending start 中に requested mode が off へ変わっても、resolve した ID を ledger に入れてから stop する。
- Contract: dispose 中は1件の stop failure で打ち切らず、その時点で所有する他の blocker ID も各1回 stop する。失敗した ID は ledger に残し、成功した ID だけを削除する。
- Adapter contract: IPowerService.stopPowerSaveBlocker が false を返した場合も stop failure として throw し、controller が旧 ID を保持して blocker-stop-failed を報告する。

- [ ] **Step 1: start failure、stop retry、mode downgrade、pending start race、operation 分類を表す failing test を作る。**

  src/vs/paradis/contrib/keepAwake/test/common/paradisKeepAwakeController.test.ts を作成する。

~~~ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisKeepAwakeMode } from '../../common/paradisKeepAwake.js';
import { ParadisKeepAwakeController, ParadisKeepAwakeFailureOperation } from '../../common/paradisKeepAwakeController.js';

suite('ParadisKeepAwakeController', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createController(options: {
		start(mode: Exclude<ParadisKeepAwakeMode, 'off'>): Promise<number>;
		stop(id: number): Promise<void>;
	}) {
		const modes: ParadisKeepAwakeMode[] = [];
		const reports: Array<{ operation: ParadisKeepAwakeFailureOperation; error: unknown }> = [];
		const controller = new ParadisKeepAwakeController({
			start: options.start,
			stop: options.stop,
			onDidChangeMode: mode => modes.push(mode),
			report: (operation, error) => reports.push({ operation, error }),
		});
		return { controller, modes, reports };
	}

	test('start rejection leaves actual mode off and reports a start failure', async () => {
		const failure = new Error('start failed');
		const fixture = createController({
			start: async () => { throw failure; },
			stop: async () => { },
		});

		await fixture.controller.setMode('system');

		assert.strictEqual(fixture.controller.actualMode, 'off');
		assert.deepStrictEqual(fixture.modes, []);
		assert.deepStrictEqual(fixture.reports, [{ operation: 'blocker-start-failed', error: failure }]);
		fixture.controller.dispose();
	});

	test('a successful start publishes the requested system mode', async () => {
		const fixture = createController({
			start: async () => 17,
			stop: async () => { },
		});

		await fixture.controller.setMode('system');

		assert.strictEqual(fixture.controller.actualMode, 'system');
		assert.deepStrictEqual(fixture.modes, ['system']);
		assert.deepStrictEqual(fixture.reports, []);
		fixture.controller.dispose();
		await fixture.controller.whenSettled();
	});

	test('stop rejection retains the id and retries the same id on the next reconcile', async () => {
		const stopped: number[] = [];
		let stopAttempts = 0;
		const failure = new Error('stop failed');
		const fixture = createController({
			start: async () => 41,
			stop: async id => {
				stopped.push(id);
				if (stopAttempts++ === 0) {
					throw failure;
				}
			},
		});

		await fixture.controller.setMode('system');
		await fixture.controller.setMode('off');
		assert.strictEqual(fixture.controller.actualMode, 'system');
		assert.deepStrictEqual(fixture.reports, [{ operation: 'blocker-stop-failed', error: failure }]);

		await fixture.controller.reconcile();
		assert.strictEqual(fixture.controller.actualMode, 'off');
		assert.deepStrictEqual(stopped, [41, 41]);
		fixture.controller.dispose();
	});

	test('display to system keeps reporting display while the old display blocker cannot stop', async () => {
		const starts: Array<Exclude<ParadisKeepAwakeMode, 'off'>> = [];
		let nextId = 1;
		let failDisplayStop = true;
		const fixture = createController({
			start: async mode => {
				starts.push(mode);
				return nextId++;
			},
			stop: async id => {
				if (id === 1 && failDisplayStop) {
					failDisplayStop = false;
					throw new Error('display stop failed');
				}
			},
		});

		await fixture.controller.setMode('display');
		await fixture.controller.setMode('system');
		assert.strictEqual(fixture.controller.actualMode, 'display');

		await fixture.controller.reconcile();
		assert.strictEqual(fixture.controller.actualMode, 'system');
		assert.deepStrictEqual(starts, ['display', 'system']);
		fixture.controller.dispose();
		await fixture.controller.whenSettled();
	});

	test('a start that resolves after off is requested is still stopped and not leaked', async () => {
		const start = new DeferredPromise<number>();
		const stopped: number[] = [];
		let startCalled = false;
		const fixture = createController({
			start: async () => {
				startCalled = true;
				return start.p;
			},
			stop: async id => { stopped.push(id); },
		});

		const display = fixture.controller.setMode('display');
		while (!startCalled) {
			await Promise.resolve();
		}
		const off = fixture.controller.setMode('off');
		start.complete(73);
		await Promise.all([display, off]);

		assert.strictEqual(fixture.controller.actualMode, 'off');
		assert.deepStrictEqual(stopped, [73]);
		fixture.controller.dispose();
	});

	test('dispose stops every successfully owned blocker', async () => {
		const stopped: number[] = [];
		const fixture = createController({
			start: async () => 91,
			stop: async id => { stopped.push(id); },
		});

		await fixture.controller.setMode('system');
		fixture.controller.dispose();
		await fixture.controller.whenSettled();

		assert.deepStrictEqual(stopped, [91]);
		assert.strictEqual(fixture.controller.actualMode, 'off');
	});

	test('dispose attempts every owned blocker even when one stop keeps failing', async () => {
		let nextId = 1;
		const stopped: number[] = [];
		const fixture = createController({
			start: async () => nextId++,
			stop: async id => {
				stopped.push(id);
				if (id === 1) {
					throw new Error('display stop failed');
				}
			},
		});

		await fixture.controller.setMode('display');
		await fixture.controller.setMode('system');
		fixture.controller.dispose();
		await fixture.controller.whenSettled();

		assert.deepStrictEqual(stopped, [1, 1, 2]);
		assert.strictEqual(fixture.controller.actualMode, 'display');
	});
});
~~~

- [ ] **Step 2: controller module が存在しない RED を確認する。**

  実行:

~~~sh
rtk npm run transpile-client
~~~

  期待: paradisKeepAwakeController.js の import を解決できず、新規 test の transpile が失敗する。

- [ ] **Step 3: Electron API 非依存の serialized controller を最小実装する。**

  src/vs/paradis/contrib/keepAwake/common/paradisKeepAwakeController.ts を作成する。

~~~ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ParadisKeepAwakeMode } from './paradisKeepAwake.js';

type ActiveParadisKeepAwakeMode = Exclude<ParadisKeepAwakeMode, 'off'>;

export type ParadisKeepAwakeFailureOperation = 'blocker-start-failed' | 'blocker-stop-failed';

export interface IParadisKeepAwakeControllerOptions {
	start(mode: ActiveParadisKeepAwakeMode): Promise<number>;
	stop(id: number): Promise<void>;
	onDidChangeMode(mode: ParadisKeepAwakeMode): void;
	report(operation: ParadisKeepAwakeFailureOperation, error: unknown): void;
}

export class ParadisKeepAwakeController extends Disposable {

	private readonly blockers = new Map<number, ActiveParadisKeepAwakeMode>();
	private requestedMode: ParadisKeepAwakeMode = 'off';
	private _actualMode: ParadisKeepAwakeMode = 'off';
	private queue: Promise<void> = Promise.resolve();
	private disposing = false;

	get actualMode(): ParadisKeepAwakeMode {
		return this._actualMode;
	}

	constructor(private readonly options: IParadisKeepAwakeControllerOptions) {
		super();
	}

	setMode(mode: ParadisKeepAwakeMode): Promise<void> {
		if (!this.disposing) {
			this.requestedMode = mode;
		}
		return this.enqueue();
	}

	reconcile(): Promise<void> {
		return this.enqueue();
	}

	whenSettled(): Promise<void> {
		return this.queue;
	}

	private enqueue(): Promise<void> {
		const next = this.queue.then(() => this.reconcileNow());
		this.queue = next.catch(() => { });
		return next;
	}

	private async reconcileNow(): Promise<void> {
		for (;;) {
			const requested = this.disposing ? 'off' : this.requestedMode;
			const hasRequested = requested !== 'off' &&
				[...this.blockers.values()].some(mode => mode === requested);

			if (requested !== 'off' && !hasRequested) {
				try {
					const id = await this.options.start(requested);
					this.blockers.set(id, requested);
					this.publishActualMode();
				} catch (error) {
					this.options.report('blocker-start-failed', error);
					return;
				}
				continue;
			}

			const stale = [...this.blockers].filter(([, mode]) => requested === 'off' || mode !== requested);
			if (stale.length === 0) {
				this.publishActualMode();
				return;
			}

			let stopFailed = false;
			for (const [id] of stale) {
				try {
					await this.options.stop(id);
					this.blockers.delete(id);
					this.publishActualMode();
				} catch (error) {
					this.options.report('blocker-stop-failed', error);
					this.publishActualMode();
					stopFailed = true;
					if (!this.disposing) {
						return;
					}
				}
			}
			if (stopFailed) {
				return;
			}
		}
	}

	private publishActualMode(): void {
		let actual: ParadisKeepAwakeMode = 'off';
		for (const mode of this.blockers.values()) {
			if (mode === 'display') {
				actual = 'display';
				break;
			}
			actual = 'system';
		}
		if (actual !== this._actualMode) {
			this._actualMode = actual;
			this.options.onDidChangeMode(actual);
		}
	}

	override dispose(): void {
		if (this.disposing) {
			return;
		}
		this.disposing = true;
		this.requestedMode = 'off';
		void this.enqueue();
		super.dispose();
	}
}
~~~

- [ ] **Step 4: contribution を controller の actual-mode renderer に縮小し、Sentry operation を分離する。**

  src/vs/paradis/contrib/keepAwake/electron-browser/paradisKeepAwake.contribution.ts へ controller import/member を追加し、constructor で依存を結ぶ。

~~~ts
import { ParadisKeepAwakeController } from '../common/paradisKeepAwakeController.js';

private readonly controller: ParadisKeepAwakeController;

this.controller = this._register(new ParadisKeepAwakeController({
	start: mode => this.powerService.startPowerSaveBlocker(
		mode === 'display' ? 'prevent-display-sleep' : 'prevent-app-suspension'
	),
	stop: async id => {
		const stopped = await this.powerService.stopPowerSaveBlocker(id);
		if (!stopped) {
			throw new Error('Power save blocker could not be stopped');
		}
	},
	onDidChangeMode: mode => this.updateStatusbar(mode),
	report: (operation, error) => {
		reportParadisDiagnosticError('owned', 'keep-awake', operation, error, undefined, 'warning');
		this.logService.error('[paradisKeepAwake] ' + operation, error);
	},
}));
void this.controller.setMode(this.getMode());
~~~

  configuration listener は requested setting を controller へ渡すだけにする。

~~~ts
this._register(this.configurationService.onDidChangeConfiguration(event => {
	if (event.affectsConfiguration(PARADIS_KEEP_AWAKE_SETTING)) {
		void this.controller.setMode(this.getMode());
	}
}));
~~~

  blockerId、generation、旧 update()、旧 dispose() を削除する。updateStatusbar は controller callback から渡された actualMode だけを受け取り、既存 label、tooltip、command を変更しない。PowerSaveBlockerType import は direct string mapping へ置換したため削除する。

- [ ] **Step 5: controller の全 failure/race test と既存 mode normalization test を GREEN にする。**

  実行:

~~~sh
rtk npm run transpile-client
rtk ./scripts/test.sh \
  --run src/vs/paradis/contrib/keepAwake/test/common/paradisKeepAwakeController.test.ts \
  --run src/vs/paradis/contrib/keepAwake/test/common/paradisKeepAwake.test.ts
~~~

  期待: 全対象 test pass。start reject は status callback を発火せず actual off、stop reject は同じ ID を次 reconcile で再試行、display blocker が残る downgrade は actual display、遅延 start ID は off 要求後に stop、report operation は start/stop で分離される。

- [ ] **Step 6: Keep Awake controller と contribution wiring を commit する。**

~~~sh
rtk git diff --check -- \
  src/vs/paradis/contrib/keepAwake/common/paradisKeepAwakeController.ts \
  src/vs/paradis/contrib/keepAwake/test/common/paradisKeepAwakeController.test.ts \
  src/vs/paradis/contrib/keepAwake/electron-browser/paradisKeepAwake.contribution.ts
rtk git add \
  src/vs/paradis/contrib/keepAwake/common/paradisKeepAwakeController.ts \
  src/vs/paradis/contrib/keepAwake/test/common/paradisKeepAwakeController.test.ts \
  src/vs/paradis/contrib/keepAwake/electron-browser/paradisKeepAwake.contribution.ts
rtk git commit -m "fix: retain failed keep-awake blockers for retry"
~~~

---

## Final Verification

- [ ] **Step 1: 全変更の TypeScript と対象 unit suite を fresh に検証する。**

~~~sh
rtk npm run transpile-client
rtk ./scripts/test.sh \
  --run src/vs/paradis/test/node/paradisKillChildProcess.test.ts \
  --run src/vs/paradis/contrib/ccusage/test/node/paradisCcusageChannel.test.ts \
  --run src/vs/paradis/contrib/ccusage/test/node/paradisCcusageProcessLifecycle.test.ts \
  --run src/vs/paradis/contrib/rtk/test/node/paradisRtkProcessLifecycle.test.ts \
  --run src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorProcessLifecycle.test.ts \
  --run src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorCodexRemoval.test.ts \
  --run src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlPreviewClient.test.ts \
  --run src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlFileEditor.test.ts \
  --run src/vs/paradis/contrib/releaseNotes/test/electron-browser/paradisChangelogLifecycle.test.ts \
  --run src/vs/paradis/contrib/releaseNotes/test/common/paradisChangelogModel.test.ts \
  --run src/vs/paradis/contrib/ptyDaemon/test/electron-main/paradisPtyHostStarterLifecycle.test.ts \
  --run src/vs/paradis/contrib/keepAwake/test/common/paradisKeepAwakeController.test.ts \
  --run src/vs/paradis/contrib/keepAwake/test/common/paradisKeepAwake.test.ts
~~~

  期待: transpile と全対象 suite が exit 0。

- [ ] **Step 2: upstream layer と import graph を含む静的検証を行う。**

~~~sh
rtk npm run typecheck-client
rtk npm run valid-layers-check
rtk git diff --check
~~~

  期待: 3 commands が exit 0。特に platform/terminal から paradis layer への新規 import はなく、upstream fallback の変更は同一 class 内の named listener と PARA-PATCH comment に限定される。

- [ ] **Step 3: commit 境界と差分 scope を確認する。**

~~~sh
rtk git status --short
rtk git log --oneline origin/main..HEAD \
  --grep="fix: own child process tree timeouts explicitly" \
  --grep="fix: terminate timed out CLI process trees before wrapper exit" \
  --grep="fix: dispose rejected HTML preview tunnels" \
  --grep="fix: bind release notes fetches to modal generations" \
  --grep="fix: release PTY host IPC listeners on dispose" \
  --grep="fix: retain failed keep-awake blockers for retry"
rtk git diff origin/main...HEAD -- \
  src/vs/paradis/node/paradisKillChildProcess.ts \
  src/vs/paradis/contrib/ccusage \
  src/vs/paradis/contrib/rtk \
  src/vs/paradis/contrib/limitsMonitor \
  src/vs/paradis/contrib/fileViewers/electron-browser/paradisHtmlPreviewClient.ts \
  src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisHtmlPreviewClient.test.ts \
  src/vs/paradis/contrib/releaseNotes \
  src/vs/paradis/contrib/ptyDaemon/electron-main/paradisDaemonPtyHostStarter.ts \
  src/vs/paradis/contrib/ptyDaemon/test/electron-main/paradisPtyHostStarterLifecycle.test.ts \
  src/vs/platform/terminal/electron-main/electronPtyHostStarter.ts \
  src/vs/paradis/contrib/keepAwake
~~~

  期待: 他計画の commit が間に入っても、この計画の6 commit message が個別に存在する。列挙 path の差分は各 Files 節の ownership 修正と test に対応し、Task 5 の upstream file に PARA-PATCH が残る。git status に表示される他担当の plan/spec は変更も stage もしない。
