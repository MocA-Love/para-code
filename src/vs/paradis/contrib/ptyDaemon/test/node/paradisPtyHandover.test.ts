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
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { ITerminalProcessOptions } from '../../../../../platform/terminal/common/terminal.js';
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

	function createProcess(host: ParadisPtyDaemonHost, disposables: DisposableStore, viewer: string): ParadisDaemonTerminalProcess {
		return disposables.add(new ParadisDaemonTerminalProcess(
			host, { executable: '/bin/sh', args: [], env: {} }, '/', 80, 24,
			// 閉じたときの後始末（W2-32）は切る。偽の pid の子孫を ps で探しに行かせない。
			{ PATH: '/usr/bin', [PARADIS_TERMINAL_KEEP_BACKGROUND_ENV]: '1' }, {}, OPTIONS,
			new NullLogService(), { quality: 'stable' } as IProductService, viewer,
			{ id: 1, workspaceId: 'ws-1', workspaceName: 'para', shouldPersist: true },
		));
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
});
