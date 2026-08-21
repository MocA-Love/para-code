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
import { paradisDecodeTerminalMetadata } from '../../common/paradisTerminalMetadata.js';
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

	function create(cwd: string = '/'): { host: ParadisPtyDaemonHost; ptys: FakePty[]; requests: IParadisPtySpawnRequest[]; process: ParadisDaemonTerminalProcess } {
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
			cwd,
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
				// 常駐はこれを読まない。読まないものは形が変わっても壊れない。
				metadataIsOpaqueString: typeof request.metadata === 'string',
				// TERM を渡さないと node-pty の既定 `xterm` に落ち、色付きプロンプトが黙って死ぬ。
				term: request.term,
			},
			{
				shape: ['args', 'cols', 'cwd', 'env', 'file', 'metadata', 'rows', 'term'],
				argsIsArray: true,
				envHasOnlyStrings: true,
				metadataIsOpaqueString: true,
				term: 'xterm-256color',
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
			{ ready, data, titles, killed: ptys[0].killed, cols: (await host.list())[0].cols },
			{
				ready: 7777,
				data: ['hello from the shell'],
				// 繋いだ時点の題名も1件出る。アプリ側は起動直後に何が動いているかを知る必要がある。
				titles: ['zsh', 'npm'],
				killed: 'SIGKILL',
				cols: 120,
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

	test('誰のターミナルかを常駐へ預ける。預けないと引き取っても画面に出てこない', async () => {
		const disposables = store.add(new DisposableStore());
		const ptys: FakePty[] = [];
		const requests: IParadisPtySpawnRequest[] = [];
		const host = disposables.add(new ParadisPtyDaemonHost(request => {
			requests.push(request);
			const pty = new FakePty(disposables);
			ptys.push(pty);
			return pty;
		}));
		const process = disposables.add(new ParadisDaemonTerminalProcess(
			host, { executable: '/bin/sh', args: [], env: {}, name: 'build' }, '/', 80, 24, {}, {}, OPTIONS,
			new NullLogService(), { quality: 'stable' } as IProductService,
			{ workspaceId: 'ws-1', workspaceName: 'para', shouldPersist: true },
		));

		await process.start();
		const metadata = paradisDecodeTerminalMetadata(requests[0].metadata);

		assert.deepStrictEqual(
			{ workspaceId: metadata.workspaceId, workspaceName: metadata.workspaceName, shouldPersist: metadata.shouldPersist, name: metadata.name, hasLaunch: metadata.launch !== undefined },
			{
				// 所属が空だと、配置は workspaceId で引くのでどのウィンドウにも載らない。
				// プロセスは生きているのに、画面に出てくる経路そのものが無くなる。
				workspaceId: 'ws-1',
				workspaceName: 'para',
				shouldPersist: true,
				name: 'build',
				// 後で「保存して復元」するときの材料。
				hasLaunch: true,
			},
		);
	});

	test('起こしてから繋ぐまでの間に出た分も届く。プロンプトを落とさない', async () => {
		const { ptys, host, process } = create();
		const data: string[] = [];
		store.add(process.onProcessData(value => data.push(value)));

		// 常駐が別プロセスに居る本番では、起こした応答が返ってから繋ぎが届くまでに実時間がある。
		// その間に pty はもう出力していて、**その分は控えにしか無い**。
		const original = host.attach.bind(host);
		(host as unknown as { attach(handle: number): Promise<unknown> }).attach = async handle => {
			ptys[0]?.emit('PROMPT$ ');
			return original(handle);
		};

		await process.start();

		// 捨てると、消えるのは決まってシェルの起動直後＝プロンプトと初期エスケープ列になる。
		assert.deepStrictEqual({ data }, { data: ['PROMPT$ '] });
	});

	test('閉じたら常駐へ「見るのをやめた」と伝える', async () => {
		const { host, process } = create();
		await process.start();
		const detached: number[] = [];
		const original = host.detach.bind(host);
		(host as unknown as { detach(handle: number): Promise<void> }).detach = async handle => {
			detached.push(handle);
			return original(handle);
		};

		process.dispose();
		await timeout(10);

		// 伝えないと常駐は「まだ誰かが見ている」と思い、未確認の文字が高水位に達して pty が止まる。
		assert.deepStrictEqual({ detached }, { detached: [1] });
	});

	test('終了が来なくても、終わったことは必ず伝える', async () => {
		const { process } = create();
		await process.start();
		const exits: (number | undefined)[] = [];
		store.add(process.onProcessExit(code => exits.push(code)));

		// SIGHUP を握り潰すプロセスだと exit が来ない。来ないままだと器が畳まれず、
		// タブが閉じないまま台帳に残り続ける。
		process.shutdown(true);
		const immediately = exits.length;
		await timeout(1200);

		assert.deepStrictEqual({ immediately, exits }, { immediately: 0, exits: [undefined] });
	});

	test('起動先が無ければ、起こす前に断る', async () => {
		const { requests, process } = create('/definitely/not/here');

		const result = await process.start() as ITerminalLaunchError | undefined;

		assert.deepStrictEqual(
			{ failed: typeof result?.message === 'string', spawned: requests.length },
			{ failed: true, spawned: 0 },
		);
	});
});
