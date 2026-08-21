/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// アプリ側と常駐側を**実際に繋いで**確かめる。間に本物のソケットもシェルも挟まないが、
// 通るコードは production と同じ (`ParadisPtyDaemonHost` の実体をそのまま相手にする)。
//
// ここで見張りたいのは1つ。**常駐に VS Code の型が渡っていないこと。** それが崩れると、
// 更新をまたいで繋ぎ直せるという前提ごと失われる。しかも崩れ方は「動いてはいる」なので、
// 動作確認では気づけない。

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IShellLaunchConfig, ITerminalLaunchError, ITerminalProcessOptions, ProcessPropertyType } from '../../../../../platform/terminal/common/terminal.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPtySpawnRequest } from '../../common/paradisPtyProtocol.js';
import { ParadisDaemonTerminalProcess } from '../../node/paradisDaemonTerminalProcess.js';
import { ParadisPtyDaemonHost } from '../../node/paradisPtyDaemonHost.js';
import { IParadisPtyProcess } from '../../node/paradisPtyHolder.js';

class FakePty implements IParadisPtyProcess {
	readonly pid = 7777;
	process = 'zsh';
	killed: string | undefined;
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
	pause(): void { }
	resume(): void { }

	emit(data: string): void { this.data.fire(data); }
}

const OPTIONS: ITerminalProcessOptions = {
	shellIntegration: { enabled: false, suggestEnabled: false, nonce: '' },
	windowsUseConptyDll: false,
	environmentVariableCollections: undefined,
	workspaceFolder: undefined,
	isScreenReaderOptimized: false,
};

suite('ParadisDaemonTerminalProcess', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(): { host: ParadisPtyDaemonHost; ptys: FakePty[]; requests: IParadisPtySpawnRequest[]; process: ParadisDaemonTerminalProcess } {
		const disposables = store.add(new DisposableStore());
		const ptys: FakePty[] = [];
		const requests: IParadisPtySpawnRequest[] = [];
		const host = disposables.add(new ParadisPtyDaemonHost(request => {
			requests.push(request);
			const pty = new FakePty(disposables);
			ptys.push(pty);
			return pty;
		}));
		const shellLaunchConfig: IShellLaunchConfig = { executable: '/bin/sh', args: ['-l'], env: {} };
		const process = disposables.add(new ParadisDaemonTerminalProcess(
			host,
			shellLaunchConfig,
			'/',
			80, 24,
			{ PATH: '/usr/bin', EMPTY: undefined } as unknown as Record<string, string>,
			{},
			OPTIONS,
			new NullLogService(),
			{ quality: 'stable' } as IProductService,
		));
		return { host, ptys, requests, process };
	}

	test('常駐へ渡すのは解決し切った起動要求だけで、VS Code の型は1つも渡らない', async () => {
		const { requests, process } = create();
		await process.start();

		const request = requests[0];
		const values = Object.values(request.env);

		assert.deepStrictEqual(
			{
				shape: Object.keys(request).sort(),
				argsIsArray: Array.isArray(request.args),
				// undefined を含む形のまま渡すと、受け取る側が「文字列だけ」と思えなくなる。
				envHasOnlyStrings: values.every(value => typeof value === 'string'),
				metadata: request.metadata,
			},
			{
				shape: ['args', 'cols', 'cwd', 'env', 'file', 'metadata', 'rows'],
				argsIsArray: true,
				envHasOnlyStrings: true,
				metadata: '',
			},
		);
	});

	test('出力・題名・終了が常駐から届き、入力と大きさは常駐へ通る', async () => {
		const { ptys, host, process } = create();
		const data: string[] = [];
		const titles: string[] = [];
		const exits: (number | undefined)[] = [];
		let ready = -1;
		store.add(process.onProcessData(value => data.push(value)));
		store.add(process.onDidChangeProperty(property => {
			if (property.type === ProcessPropertyType.Title) {
				titles.push(property.value as string);
			}
		}));
		store.add(process.onProcessExit(code => exits.push(code)));
		store.add(process.onProcessReady(event => { ready = event.pid; }));

		await process.start();
		ptys[0].emit('hello from the shell');
		ptys[0].process = 'npm';
		await timeout(500);

		process.resize(120, 40);
		process.shutdown(true);
		await timeout(50);

		assert.deepStrictEqual(
			{ ready, data, titles, killed: ptys[0].killed, cols: (await host.list())[0].cols, exits },
			{
				ready: 7777,
				data: ['hello from the shell'],
				// 繋いだ時点の題名も1件出る。アプリ側は起動直後に何が動いているかを知る必要がある。
				titles: ['zsh', 'npm'],
				killed: 'SIGKILL',
				cols: 120,
				exits: [],
			},
		);
	});

	test('閉じても pty を道連れにしない。それを避けるために常駐がある', async () => {
		const { ptys, host, process } = create();
		await process.start();

		// ウィンドウが閉じるとこちら側は畳まれる。
		process.dispose();

		assert.deepStrictEqual(
			{ killed: ptys[0].killed, stillHeld: (await host.list()).map(summary => summary.alive) },
			{ killed: undefined, stillHeld: [true] },
		);
	});

	test('起動先が無ければ、起こす前に断る', async () => {
		const { requests, process } = create();
		(process as unknown as { initialCwd: string }).initialCwd = '/definitely/not/here';

		const result = await process.start() as ITerminalLaunchError | undefined;

		assert.deepStrictEqual(
			{ failed: typeof result?.message === 'string', spawned: requests.length },
			{ failed: true, spawned: 0 },
		);
	});
});
