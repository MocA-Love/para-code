/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 引き取ったものが**器まで届くこと**を確かめる。ここが繋がって初めて画面に出る。
//
// 見張りたいのは、引き取りが「起こし直し」にすり替わっていないこと。すり替わると、走っていた
// プロセスは行方不明のまま常駐に残り、画面には別の新しいシェルが出る。**動いているように
// 見えてしまう**ので、テストで固定しないと気づけない。

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisEncodeTerminalMetadata } from '../../common/paradisTerminalMetadata.js';
import { paradisUsePtyDaemon } from '../../node/paradisTerminalProcessFactory.js';
import { paradisRememberLayout } from '../../node/paradisTerminalLayoutStore.js';
import { timeout } from '../../../../../base/common/async.js';
import { ISetTerminalLayoutInfoArgs } from '../../../../../platform/terminal/common/terminalProcess.js';
import { ITerminalProcessOptions } from '../../../../../platform/terminal/common/terminal.js';
import { IParadisAdoptionTarget, paradisAdoptIntoPtyService } from '../../node/paradisAdoptIntoPtyService.js';
import { ParadisPtyDaemonHost } from '../../node/paradisPtyDaemonHost.js';
import { IParadisPtyProcess } from '../../node/paradisPtyHolder.js';

class FakePty implements IParadisPtyProcess {
	readonly pid: number;
	process = 'zsh';
	constructor(pid: number, private readonly store: DisposableStore) {
		this.pid = pid;
		this.data = store.add(new Emitter<string>());
		this.exit = store.add(new Emitter<{ exitCode: number; signal?: number }>());
	}
	private readonly data: Emitter<string>;
	private readonly exit: Emitter<{ exitCode: number; signal?: number }>;
	onData(listener: (data: string) => void): IDisposable { return this.store.add(this.data.event(listener)); }
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable { return this.store.add(this.exit.event(listener)); }
	write(): void { }
	resize(): void { }
	kill(): void { }
	pause(): void { }
	resume(): void { }
	emit(data: string): void { this.data.fire(data); }
}

/** 器の代わり。**何を渡されたか**だけを覚える。 */
function recordingPtyService(): { service: IParadisAdoptionTarget; calls: Record<string, unknown>[]; layouts: ISetTerminalLayoutInfoArgs[] } {
	const calls: Record<string, unknown>[] = [];
	const layouts: ISetTerminalLayoutInfoArgs[] = [];
	const service: IParadisAdoptionTarget = {
		paradisSetTerminalLayoutInfo(args) { layouts.push(args); },
		async createProcess(shellLaunchConfig, cwd, cols, rows, unicodeVersion, env, executableEnv, options, shouldPersist, workspaceId, workspaceName, isReviving, rawReviveBuffer, paradisAdoptTarget) {
			calls.push({ initialText: shellLaunchConfig.initialText, name: shellLaunchConfig.name, cols, rows, shouldPersist, workspaceId, workspaceName, isReviving, rawReviveBuffer, adopt: paradisAdoptTarget });
			return calls.length;
		},
	};
	return { service, calls, layouts };
}

suite('ParadisAdoptIntoPtyService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function daemon(): { host: ParadisPtyDaemonHost; ptys: FakePty[] } {
		const disposables = store.add(new DisposableStore());
		const ptys: FakePty[] = [];
		const host = disposables.add(new ParadisPtyDaemonHost(() => {
			const pty = new FakePty(5000 + ptys.length, disposables);
			ptys.push(pty);
			return pty;
		}));
		return { host, ptys };
	}

	test('走っているものに繋ぎ直す。起こし直しにすり替わっていない', async () => {
		const { host, ptys } = daemon();
		const summary = await host.spawn({
			file: '/bin/zsh', args: [], env: {}, cwd: '/', cols: 100, rows: 30, term: 'xterm-256color',
			metadata: paradisEncodeTerminalMetadata({
				workspaceId: 'ws-1', workspaceName: 'para', shouldPersist: true, name: 'build',
				launch: undefined,
			}),
		});
		await host.attach(summary.handle, 'viewer');
		await host.detach(summary.handle);
		ptys[0].emit('done in 12s\r\n');

		const { service, calls } = recordingPtyService();
		const outcome = await paradisAdoptIntoPtyService(service, host, new NullLogService());

		assert.deepStrictEqual(
			{ outcome, calls },
			{
				outcome: { reachable: true, adopted: 1, skipped: 0 },
				calls: [{
					initialText: undefined,
					name: 'build',
					cols: 100,
					rows: 30,
					shouldPersist: true,
					workspaceId: 'ws-1',
					workspaceName: 'para',
					// **復元ではない。** 走っているものに繋ぎ直すだけなので、画面は繋いだときに
					// 流れてくる。upstream の復元用の材料（`isReviving` / `rawReviveBuffer`）は
					// 要らず、渡さない。
					isReviving: undefined,
					rawReviveBuffer: undefined,
					// **これが本題。** 引き取り先を名指ししているので、器は起こさずに繋ぐ。
					adopt: { handle: summary.handle, pid: 5000, title: 'zsh', exited: undefined },
				}],
			},
		);
	});

	test('配置を戻したときに、読んだばかりの配置を空で潰さない', async () => {
		const { host, ptys } = daemon();
		const summary = await host.spawn({
			file: '/bin/zsh', args: [], env: {}, cwd: '/', cols: 80, rows: 24, term: 'xterm-256color',
			metadata: paradisEncodeTerminalMetadata({
				workspaceId: 'ws-A', workspaceName: 'para', shouldPersist: true, name: undefined, launch: undefined,
			}),
		});
		await host.attach(summary.handle, 'viewer');
		await host.detach(summary.handle);
		void ptys;

		// 前の世代が預けた配置。handle で書かれている。
		await host.setLayout('ws-A', JSON.stringify({
			workspaceId: 'ws-A',
			tabs: [{ isActive: true, activePersistentProcessId: summary.handle, terminals: [{ relativeSize: 1, terminal: summary.handle }] }],
			background: [],
		}));

		const before = await host.getLayout('ws-A');
		const restored: ISetTerminalLayoutInfoArgs[] = [];
		const service: IParadisAdoptionTarget = {
			async createProcess() { return 7; },
			paradisSetTerminalLayoutInfo(args) { restored.push(args); },
		};

		await paradisAdoptIntoPtyService(service, host, new NullLogService());

		assert.deepStrictEqual(
			{ restored: restored.length, keptTabs: restored[0]?.tabs.length, daemonStillHas: await host.getLayout('ws-A') },
			{
				restored: 1,
				// 戻す配置は新しい番号で書かれている。空で戻すと、いま開いていないスペースは
				// 誰も開き直さないので永久に画面へ出てこなくなる。
				keptTabs: 1,
				// **書き戻さない。** 戻す配置は「引き取れなかったぶんを落とした後」の姿なので、
				// これを元の上に書くと、届かなかった端末が次の起動からも消える。
				daemonStillHas: before,
			},
		);
	});

	test('常駐の端末が無くなったスペースの配置は、忘れさせる', async () => {
		const { host } = daemon();
		await host.setLayout('ws-gone', '{"workspaceId":"ws-gone","tabs":[{"isActive":true,"terminals":[{"relativeSize":1,"terminal":9}]}],"background":[]}');

		// 常駐に1本も無いスペースの配置を書く（窓が端末を全部閉じた後など）。
		paradisUsePtyDaemon({ host, client: { onDidDispose: () => ({ dispose() { } }) } as never, viewer: 'viewer' });
		store.add(toDisposable(() => paradisUsePtyDaemon(undefined)));
		paradisRememberLayout({ workspaceId: 'ws-gone', tabs: [], background: [] });
		await timeout(10);

		// 忘れさせないと、常駐が持つ配置は増える一方になる（スペースを消しても常駐は知らない）。
		assert.deepStrictEqual({ left: await host.getLayout('ws-gone') }, { left: undefined });
	});

	test('器を作れなかった1本のために、走っている残りを落とさない', async () => {
		const { host } = daemon();
		await host.spawn({ file: '/bin/zsh', args: [], env: {}, cwd: '/', cols: 80, rows: 24, term: 'xterm-256color', metadata: '{}' });
		await host.spawn({ file: '/bin/zsh', args: [], env: {}, cwd: '/', cols: 80, rows: 24, term: 'xterm-256color', metadata: '{}' });

		let first = true;
		const service: IParadisAdoptionTarget = {
			paradisSetTerminalLayoutInfo() { },
			async createProcess() {
				if (first) {
					first = false;
					throw new Error('no room');
				}
				return 2;
			},
		};

		const outcome = await paradisAdoptIntoPtyService(service, host, new NullLogService());

		assert.deepStrictEqual(
			{ outcome, stillHeld: (await host.list()).length },
			{
				outcome: { reachable: true, adopted: 1, skipped: 1 },
				// **常駐からは外さない。** 器を作れないだけで走っているプロセスを畳む理由が無い。
				stillHeld: 2,
			},
		);
	});
	// 預かりものは**別のビルドが書いて JSON を往復してきた値**。`launch.options` が在るのに
	// `shellIntegration` を欠く形（古い版・将来の版・壊れた預かりもの）はあり得るが、器はその中の
	// nonce を無条件に読む。素通しすると器の生成で例外になり、その1本は毎起動落ち続けて永久に
	// 画面へ出てこない。読めない形は既定へ倒して、走っているプロセスのほうを助ける。
	test('預かりものの形が違っても、器が読める材料に均してから渡す', async () => {
		const { host } = daemon();
		await host.spawn({
			file: '/bin/zsh', args: [], env: {}, cwd: '/', cols: 80, rows: 24, term: 'xterm-256color',
			metadata: paradisEncodeTerminalMetadata({
				workspaceId: 'ws-1', workspaceName: 'para', shouldPersist: true, name: undefined,
				launch: { shellLaunchConfig: {}, env: {}, executableEnv: {}, options: { windowsUseConptyDll: false } },
			}),
		});

		const seen: ITerminalProcessOptions[] = [];
		const service: IParadisAdoptionTarget = {
			paradisSetTerminalLayoutInfo() { },
			async createProcess(_shellLaunchConfig, _cwd, _cols, _rows, _unicodeVersion, _env, _executableEnv, options) {
				seen.push(options);
				return 1;
			},
		};

		const outcome = await paradisAdoptIntoPtyService(service, host, new NullLogService());

		assert.deepStrictEqual(
			{ outcome, nonce: seen[0]?.shellIntegration?.nonce },
			{ outcome: { reachable: true, adopted: 1, skipped: 0 }, nonce: '' },
		);
	});
});
