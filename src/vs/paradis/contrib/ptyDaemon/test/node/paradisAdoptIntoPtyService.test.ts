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
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisEncodeTerminalMetadata } from '../../common/paradisTerminalMetadata.js';
import { ISetTerminalLayoutInfoArgs } from '../../../../../platform/terminal/common/terminalProcess.js';
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
		async setTerminalLayoutInfo(args) { layouts.push(args); },
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
				appearance: undefined, launch: undefined,
			}),
		});
		await host.attach(summary.handle);
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
					// **この2つが要る。** `initialText` は `IProcessDetails` に含まれないので、
					// これだけではウィンドウへ渡る経路に乗らず、画面は空になる。器の中の
					// 直列化へ流し込むには upstream の復元と同じ形で渡す必要がある。
					// 復元ではない。走っているものに繋ぎ直すので、画面は繋いだときに流れてくる。
					isReviving: undefined,
					rawReviveBuffer: undefined,
					// **これが本題。** 引き取り先を名指ししているので、器は起こさずに繋ぐ。
					adopt: { handle: summary.handle, pid: 5000, title: 'zsh', exited: undefined },
				}],
			},
		);
	});

	test('器を作れなかった1本のために、走っている残りを落とさない', async () => {
		const { host } = daemon();
		await host.spawn({ file: '/bin/zsh', args: [], env: {}, cwd: '/', cols: 80, rows: 24, term: 'xterm-256color', metadata: '{}' });
		await host.spawn({ file: '/bin/zsh', args: [], env: {}, cwd: '/', cols: 80, rows: 24, term: 'xterm-256color', metadata: '{}' });

		let first = true;
		const service: IParadisAdoptionTarget = {
			async setTerminalLayoutInfo() { },
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
});
