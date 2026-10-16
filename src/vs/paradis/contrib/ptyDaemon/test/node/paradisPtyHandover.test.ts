/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐の端末を pty ホストの間で引き継ぐ流れを、常駐の実体（`ParadisPtyDaemonHost`）に A 役と B 役の
// 端末を繋いで確かめる。SSH 先で更新したときに起きることの縮図:
//
//   A = 更新前の版のサーバーの pty ホスト。窓が閉じても端末を持ったまま残る
//   B = 更新後の版のサーバーの pty ホスト。起きたときに常駐の端末を引き取る
//
// 本物のソケットもシェルも挟まないが、通るコードは production と同じ。

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ITerminalProcessOptions } from '../../../../../platform/terminal/common/terminal.js';
import { ISetTerminalLayoutInfoArgs } from '../../../../../platform/terminal/common/terminalProcess.js';
import { IParadisPtyHost } from '../../common/paradisPtyProtocol.js';
import { PARADIS_PTY_HOST_STATE_DIR } from '../../common/paradisPtyHostPaths.js';
import { IParadisAdoptionTarget } from '../../node/paradisAdoptIntoPtyService.js';
import { paradisAdoptAtStartup, paradisReadoptFromDaemon } from '../../node/paradisPtyReadopt.js';
import { paradisEnableRemotePtyHostDaemon } from '../../node/paradisRemotePtyHost.js';
import { paradisRememberLayout } from '../../node/paradisTerminalLayoutStore.js';
import { IParadisAdoptTarget, paradisForgetHandle, paradisIdOfHandle, paradisKnownHandles, paradisUsePtyDaemon } from '../../node/paradisTerminalProcessFactory.js';
import { IParadisPtyScreenSink } from '../../common/paradisTerminalProcessLike.js';
import { PARADIS_TERMINAL_KEEP_BACKGROUND_ENV } from '../../../terminalCloseCleanup/common/paradisTerminalCloseCleanup.js';
import { ParadisDaemonTerminalProcess } from '../../node/paradisDaemonTerminalProcess.js';
import { ParadisPtyDaemonHost } from '../../node/paradisPtyDaemonHost.js';
import { paradisTakePtyHandoverReport } from '../../node/paradisPtyHandoverJournal.js';
import { IParadisPtyProcess } from '../../node/paradisPtyHolder.js';
import { paradisAdoptTerminals } from '../../node/paradisTerminalAdoption.js';

class FakePty implements IParadisPtyProcess {
	readonly pid = 7777;
	process = 'zsh';
	killed: string | undefined;
	paused = false;
	private readonly data: Emitter<string>;
	private readonly exit: Emitter<{ exitCode: number; signal?: number }>;

	constructor(store: DisposableStore) {
		this.data = store.add(new Emitter<string>());
		this.exit = store.add(new Emitter<{ exitCode: number; signal?: number }>());
	}

	onData(listener: (data: string) => void): IDisposable { return this.data.event(listener); }
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable { return this.exit.event(listener); }
	write(): void { }
	resize(): void { }
	kill(signal?: string): void { this.killed = signal ?? 'default'; }
	pause(): void { this.paused = true; }
	resume(): void { this.paused = false; }

	emit(data: string): void { this.data.fire(data); }
	quit(exitCode: number): void { this.exit.fire({ exitCode }); }
}

const OPTIONS: ITerminalProcessOptions = {
	shellIntegration: { enabled: false, suggestEnabled: false, nonce: '' },
	windowsUseConptyDll: false,
	environmentVariableCollections: undefined,
	workspaceFolder: undefined,
	isScreenReaderOptimized: false,
};

/** 作り直された画面への書き込みを控える。 */
class RecordingScreen implements IParadisPtyScreenSink {
	readonly writes: string[] = [];
	handleResize(cols: number, rows: number): void { this.writes.push(`resize:${cols}x${rows}`); }
	handleData(data: string): void { this.writes.push(data); }
	async whenWritten(): Promise<void> { }
}

suite('Para pty daemon handover between pty hosts', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => {
		// 前のテストの記録を捨てる（記録はプロセスに1つ）。
		paradisTakePtyHandoverReport({ daemon: true, foreignHeld: 0 });
		// 番号と handle の表もプロセスに1つ。ほかのスイートが引き取りで覚えた分を捨てる
		// （残っていると「もう引き取ってある」として引き取り直しの見回りが飛ばす）。
		for (const handle of paradisKnownHandles()) {
			for (let id = paradisIdOfHandle(handle); id !== undefined; id = paradisIdOfHandle(handle)) {
				paradisForgetHandle(id);
			}
		}
	});

	function createHost(): { host: ParadisPtyDaemonHost; ptys: FakePty[]; disposables: DisposableStore } {
		const disposables = store.add(new DisposableStore());
		const ptys: FakePty[] = [];
		const host = disposables.add(new ParadisPtyDaemonHost(() => {
			const pty = new FakePty(disposables);
			ptys.push(pty);
			return pty;
		}));
		return { host, ptys, disposables };
	}

	function createProcess(host: IParadisPtyHost, disposables: DisposableStore, viewer: string, options?: { readonly adoptTarget?: IParadisAdoptTarget; readonly withoutOrigin?: boolean }): ParadisDaemonTerminalProcess {
		return disposables.add(new ParadisDaemonTerminalProcess(
			host, { executable: '/bin/sh', args: [], env: {} }, '/', 80, 24,
			// 閉じたときの後始末（W2-32）は切る。偽の pid の子孫を ps で探しに行かせない。
			{ PATH: '/usr/bin', [PARADIS_TERMINAL_KEEP_BACKGROUND_ENV]: '1' }, {}, OPTIONS,
			new NullLogService(), { quality: 'stable' } as IProductService, viewer,
			options?.withoutOrigin ? undefined : { id: 1, workspaceId: 'ws-1', workspaceName: 'para', shouldPersist: true },
			undefined, undefined, options?.adoptTarget,
		));
	}

	/** 常駐の口を1つずつ差し替えられる形で包む。 */
	function wrap(host: ParadisPtyDaemonHost, overrides: Partial<IParadisPtyHost>): IParadisPtyHost {
		return {
			onDidChangeData: host.onDidChangeData,
			onDidChangeTitle: host.onDidChangeTitle,
			onDidExit: host.onDidExit,
			hello: () => host.hello(),
			list: () => host.list(),
			spawn: request => host.spawn(request),
			attach: (handle, viewer) => host.attach(handle, viewer),
			detach: (handle, viewer) => host.detach(handle, viewer),
			input: (handle, data, binary) => host.input(handle, data, binary),
			acknowledge: (handle, charCount) => host.acknowledge(handle, charCount),
			resize: (handle, cols, rows) => host.resize(handle, cols, rows),
			setMetadata: (handle, metadata) => host.setMetadata(handle, metadata),
			clearScrollback: handle => host.clearScrollback(handle),
			kill: (handle, signal, stopDescendants, caller) => host.kill(handle, signal, stopDescendants, caller),
			release: (handle, caller) => host.release(handle, caller),
			setLayout: (scopeId, layout) => host.setLayout(scopeId, layout),
			getLayout: scopeId => host.getLayout(scopeId),
			...overrides,
		};
	}

	test('窓が離れても手を離さないと、別の pty ホストは引き取れない（直す前の穴）。手を離せば引き取れる', async () => {
		const { host, disposables } = createHost();
		const a = createProcess(host, disposables, 'paradis-pty-host:1:a');
		await a.start();

		const before = await paradisAdoptTerminals(host);
		await a.paradisLetGo();
		const after = await paradisAdoptTerminals(host);

		assert.deepStrictEqual(
			{ before: { adopted: before.adopted.length, skipped: before.skipped, foreign: before.foreign.length }, after: { adopted: after.adopted.length, skipped: after.skipped } },
			{ before: { adopted: 0, skipped: 1, foreign: 1 }, after: { adopted: 1, skipped: 0 } },
		);
	});

	test('手を離している間は常駐が代わりに受け取り、10 万文字を超えても pty を止めない', async () => {
		const { host, ptys, disposables } = createHost();
		const a = createProcess(host, disposables, 'paradis-pty-host:1:a');
		await a.start();
		await a.paradisLetGo();

		ptys[0].emit('x'.repeat(150_000));

		assert.strictEqual(ptys[0].paused, false);
	});

	test('戻ってきたとき、何も出ていなければ画面に触らない', async () => {
		const { host, ptys, disposables } = createHost();
		const a = createProcess(host, disposables, 'paradis-pty-host:1:a');
		const data: string[] = [];
		store.add(a.onProcessData(value => data.push(value)));
		await a.start();
		ptys[0].emit('before');
		await a.paradisLetGo();

		const screen = new RecordingScreen();
		const cameBack = await a.paradisComeBack(() => screen);

		assert.deepStrictEqual({ cameBack, data, writes: screen.writes, report: paradisTakePtyHandoverReport({ daemon: true, foreignHeld: 0 }).reattach.unchanged }, { cameBack: true, data: ['before'], writes: [], report: 1 });
	});

	test('戻ってきたとき、離れている間に出た分だけを流す', async () => {
		const { host, ptys, disposables } = createHost();
		const a = createProcess(host, disposables, 'paradis-pty-host:1:a');
		const data: string[] = [];
		store.add(a.onProcessData(value => data.push(value)));
		await a.start();
		ptys[0].emit('before;');
		await a.paradisLetGo();
		ptys[0].emit('while-away-1;');
		ptys[0].emit('while-away-2;');

		const screen = new RecordingScreen();
		await a.paradisComeBack(() => screen);
		ptys[0].emit('after;');

		assert.deepStrictEqual({ data, writes: screen.writes }, { data: ['before;', 'while-away-1;while-away-2;', 'after;'], writes: [] });
	});

	test('離れている間に画面を消されていたら、控え全体で画面を作り直す', async () => {
		const { host, ptys, disposables } = createHost();
		const a = createProcess(host, disposables, 'paradis-pty-host:1:a');
		const data: string[] = [];
		store.add(a.onProcessData(value => data.push(value)));
		await a.start();
		ptys[0].emit('before;');
		await a.paradisLetGo();
		await host.clearScrollback(1);
		ptys[0].emit('fresh;');

		const screen = new RecordingScreen();
		await a.paradisComeBack(() => screen);

		assert.deepStrictEqual(
			{ data, writes: screen.writes, reasons: paradisTakePtyHandoverReport({ daemon: true, foreignHeld: 0 }).reattach.rebuildReasons },
			{ data: ['before;'], writes: ['resize:80x24', 'fresh;'], reasons: { cleared: 1 } },
		);
	});

	test('戻ってきたら別の pty ホストが引き取っていた: 常駐には触れずに畳み、繋ぎ直しは失敗にする', async () => {
		const { host, ptys, disposables } = createHost();
		const a = createProcess(host, disposables, 'paradis-pty-host:1:a');
		const exits: (number | undefined)[] = [];
		store.add(a.onProcessExit(code => exits.push(code)));
		await a.start();
		await a.paradisLetGo();
		// B（更新後の版）が引き取って見ている。
		await host.attach(1, 'paradis-pty-host:2:b');

		await assert.rejects(a.paradisComeBack(() => new RecordingScreen()));
		await timeout(0);

		assert.deepStrictEqual(
			{ exits, killed: ptys[0].killed, held: (await host.list()).map(summary => ({ alive: summary.alive, attached: summary.attached })) },
			{ exits: [undefined], killed: undefined, held: [{ alive: true, attached: true }] },
		);
	});

	test('手を離した端末の猶予切れの終了は、別の pty ホストが見ていれば手を引く', async () => {
		const { host, ptys, disposables } = createHost();
		const a = createProcess(host, disposables, 'paradis-pty-host:1:a');
		await a.start();
		await a.paradisLetGo();
		await host.attach(1, 'paradis-pty-host:2:b');

		a.shutdown(true);
		await timeout(10);

		assert.deepStrictEqual(
			{ killed: ptys[0].killed, held: (await host.list()).length, spared: paradisTakePtyHandoverReport({ daemon: true, foreignHeld: 0 }).spared },
			{ killed: undefined, held: 1, spared: 1 },
		);
	});

	test('手を離した端末の猶予切れの終了は、誰も見ていなければ今までどおり終わらせる', async () => {
		const { host, ptys, disposables } = createHost();
		const a = createProcess(host, disposables, 'paradis-pty-host:1:a');
		await a.start();
		await a.paradisLetGo();

		a.shutdown(true);
		await timeout(10);

		assert.strictEqual(ptys[0].killed, 'SIGKILL');
	});

	test('別の相手が見ている端末は、名札付きの kill と release では終わらない', async () => {
		const { host, ptys, disposables } = createHost();
		const a = createProcess(host, disposables, 'paradis-pty-host:1:a');
		await a.start();
		await a.paradisLetGo();
		await host.attach(1, 'paradis-pty-host:2:b');

		await host.kill(1, 'SIGKILL', false, 'paradis-pty-host:1:a');
		await host.release(1, 'paradis-pty-host:1:a');

		assert.deepStrictEqual({ killed: ptys[0].killed, held: (await host.list()).length }, { killed: undefined, held: 1 });
	});

	test('手を離している間に終わったら、戻ってきて画面を渡すまで終了を伝えない', async () => {
		const { host, ptys, disposables } = createHost();
		const a = createProcess(host, disposables, 'paradis-pty-host:1:a');
		const exits: (number | undefined)[] = [];
		store.add(a.onProcessExit(code => exits.push(code)));
		await a.start();
		await a.paradisLetGo();
		ptys[0].emit('done');
		ptys[0].quit(3);
		await timeout(300);
		const whileAway = [...exits];

		await a.paradisComeBack(() => new RecordingScreen());
		await timeout(1_700);

		assert.deepStrictEqual({ whileAway, exits }, { whileAway: [], exits: [3] });
	});
	test('手を離す返事より前に届いた出力は、戻ったときに二重に流さない', async () => {
		const { host, ptys, disposables } = createHost();
		// 常駐が detach を受け取る前に出力が出る（窓の再読み込みの瞬間に TUI が描いている）。
		// 片付けの detach では出さない（1回目だけ）。
		let inFlight = true;
		const busy = wrap(host, {
			detach: async (handle, viewer) => {
				if (inFlight) {
					inFlight = false;
					ptys[0].emit('in-flight;');
					await timeout(0);
				}
				return host.detach(handle, viewer);
			},
		});
		const a = createProcess(busy, disposables, 'paradis-pty-host:1:a');
		const data: string[] = [];
		store.add(a.onProcessData(value => data.push(value)));
		await a.start();
		ptys[0].emit('before;');
		await a.paradisLetGo();
		ptys[0].emit('away;');

		await a.paradisComeBack(() => new RecordingScreen());

		assert.deepStrictEqual(data, ['before;', 'in-flight;', 'away;']);
	});

	test('手を離す返事が来なければ、どこまで受け取ったか言い切れないので戻ったときは控え全体で作り直す', async () => {
		const { host, ptys, disposables } = createHost();
		const broken = wrap(host, { detach: async () => { throw new Error('daemon unreachable'); } });
		const a = createProcess(broken, disposables, 'paradis-pty-host:1:a');
		const data: string[] = [];
		store.add(a.onProcessData(value => data.push(value)));
		await a.start();
		ptys[0].emit('before;');
		await a.paradisLetGo();

		const screen = new RecordingScreen();
		await a.paradisComeBack(() => screen);

		assert.deepStrictEqual(
			{ data, writes: screen.writes, reasons: paradisTakePtyHandoverReport({ daemon: true, foreignHeld: 0 }).reattach.rebuildReasons },
			{ data: ['before;'], writes: ['resize:80x24', 'before;'], reasons: { 'no-mark': 1 } },
		);
	});

	test('控えの量を返さない古い常駐では手を離さない（戻るたびに控え全体で作り直さない）', async () => {
		const { host, disposables } = createHost();
		const old = wrap(host, {
			attach: async (handle, viewer) => {
				const attachment = await host.attach(handle, viewer);
				return { frames: attachment.frames, dropped: attachment.dropped };
			},
		});
		const a = createProcess(old, disposables, 'paradis-pty-host:1:a');
		await a.start();

		await a.paradisLetGo();
		const cameBack = await a.paradisComeBack(() => new RecordingScreen());

		assert.deepStrictEqual({ cameBack, attached: (await host.list())[0].attached }, { cameBack: false, attached: true });
	});

	test('2つの pty ホストが同じ端末を引き取ったら、後から開いた方は常駐に触れずに負ける', async () => {
		const { host, ptys, disposables } = createHost();
		const summary = await host.spawn({ file: '/bin/sh', args: [], env: {}, cwd: '/', cols: 80, rows: 24, term: 'xterm-256color', metadata: '{}' });
		const target: IParadisAdoptTarget = { handle: summary.handle, pid: summary.pid, title: summary.title, exited: undefined };
		const b = createProcess(host, disposables, 'paradis-pty-host:2:b', { adoptTarget: target, withoutOrigin: true });
		const c = createProcess(host, disposables, 'paradis-pty-host:3:c', { adoptTarget: target, withoutOrigin: true });

		const won = await b.start();
		const lost = await c.start();
		c.dispose();
		await timeout(10);

		assert.deepStrictEqual(
			{ won, lostHasMessage: typeof (lost as { message?: unknown } | undefined)?.message === 'string', killed: ptys[0].killed, held: (await host.list()).map(s => s.attached) },
			{ won: undefined, lostHasMessage: true, killed: undefined, held: [true] },
		);
	});

	test('別の pty ホストが見ていた端末を覚え、空いたら引き取り直す。それまで常駐の配置からそのタブを消さない', async () => {
		const { host, disposables } = createHost();
		// A: 更新前の版のサーバーの pty ホスト。番号の表を汚さないよう持ち主は渡さない（本番では別のプロセス）。
		const a = createProcess(host, disposables, 'paradis-pty-host:1:a', { withoutOrigin: true });
		await a.start();
		await host.setMetadata(1, JSON.stringify({ workspaceId: 'ws-1', workspaceName: 'para', shouldPersist: true }));
		await host.setLayout('ws-1', JSON.stringify({ workspaceId: 'ws-1', tabs: [{ isActive: true, activePersistentProcessId: 1, terminals: [{ relativeSize: 1, terminal: 1 }] }], background: [] } satisfies ISetTerminalLayoutInfoArgs));

		// B: 更新後の版のサーバーの pty ホスト。
		paradisUsePtyDaemon({ host, client: { onDidDispose: () => ({ dispose() { } }) } as never, viewer: 'paradis-pty-host:2:b' });
		store.add(toDisposable(() => paradisUsePtyDaemon(undefined)));
		// 引き取りで覚えた番号（101）を次のテストへ持ち越さない。
		store.add(toDisposable(() => paradisForgetHandle(101)));
		const created: number[] = [];
		const layouts: ISetTerminalLayoutInfoArgs[] = [];
		const service: IParadisAdoptionTarget = {
			paradisSetTerminalLayoutInfo: args => { layouts.push(args); },
			createProcess: async (...args) => { created.push(args[13]?.handle ?? -1); return 100 + created.length; },
		};
		await paradisAdoptAtStartup(service, host, new NullLogService());
		const atStartup = [...created];

		// B の窓は自分の分だけ（ここでは空）の配置を書く。A のタブは残る。
		paradisRememberLayout({ workspaceId: 'ws-1', tabs: [], background: [] });
		await timeout(10);
		const kept = JSON.parse((await host.getLayout('ws-1'))!) as ISetTerminalLayoutInfoArgs;

		// A が手を離す（窓が閉じた、A が終わった）。見回りが引き取る。
		await a.paradisLetGo();
		const run = await paradisReadoptFromDaemon('poll');

		assert.deepStrictEqual(
			{
				atStartup,
				kept: kept.tabs.map(tab => tab.terminals.map(terminal => terminal.terminal)),
				run: { adopted: run?.adopted, foreign: run?.foreign },
				created,
				restoredLayout: layouts.at(-1)?.tabs.map(tab => tab.terminals.map(terminal => terminal.terminal)),
			},
			{ atStartup: [], kept: [[1]], run: { adopted: 1, foreign: 0 }, created: [1], restoredLayout: [[101]] },
		);
	});

	test('Windows の接続先では常駐を使わない。それ以外では設定を後から入れても次の pty ホストから使う', () => {
		const configuration = new TestConfigurationService({});
		const windowsEnv: { [key: string]: string | undefined } = {};
		const linuxEnv: { [key: string]: string | undefined } = {};
		const windows = paradisEnableRemotePtyHostDaemon(configuration, '/state', new NullLogService(), 'win32', windowsEnv);
		const linux = paradisEnableRemotePtyHostDaemon(configuration, '/state', new NullLogService(), 'linux', linuxEnv);
		const beforeOn = linuxEnv[PARADIS_PTY_HOST_STATE_DIR];

		configuration.setUserConfiguration('paradis.terminal.daemon.reattachAcrossUpdates', true);
		configuration.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: (key: string) => key === 'paradis.terminal.daemon.reattachAcrossUpdates' } as never);
		windows.dispose();
		linux.dispose();

		assert.deepStrictEqual(
			{ beforeOn, linux: linuxEnv[PARADIS_PTY_HOST_STATE_DIR], windows: windowsEnv[PARADIS_PTY_HOST_STATE_DIR] },
			{ beforeOn: undefined, linux: '/state', windows: undefined },
		);
	});
});
