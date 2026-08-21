/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// **この機能の目的そのもの**を確かめる。アプリが消えて、別のアプリが起きて、走っていたものを
// 引き取れること。
//
// 「前のアプリ」と「新しいアプリ」は、同じ常駐を相手にする別々の呼び出し手として演じる。
// 常駐側は production の実体をそのまま使い、pty だけ差し替えている。

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPtyHost } from '../../common/paradisPtyProtocol.js';
import { paradisEncodeTerminalMetadata } from '../../common/paradisTerminalMetadata.js';
import { ParadisPtyDaemonHost } from '../../node/paradisPtyDaemonHost.js';
import { IParadisPtyProcess } from '../../node/paradisPtyHolder.js';
import { paradisAdoptTerminals } from '../../node/paradisTerminalAdoption.js';

class FakePty implements IParadisPtyProcess {
	readonly pid: number;
	process = 'zsh';
	killed = false;
	private readonly data: Emitter<string>;
	private readonly exit: Emitter<{ exitCode: number; signal?: number }>;

	constructor(pid: number, store: DisposableStore) {
		this.pid = pid;
		this.data = store.add(new Emitter<string>());
		this.exit = store.add(new Emitter<{ exitCode: number; signal?: number }>());
	}

	onData(listener: (data: string) => void): IDisposable { return this.data.event(listener); }
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable { return this.exit.event(listener); }
	write(): void { }
	resize(): void { }
	kill(): void { this.killed = true; }
	pause(): void { }
	resume(): void { }
	emit(data: string): void { this.data.fire(data); }
}

const SCROLLBACK_LIMIT = 10 * 1024 * 1024;

suite('ParadisTerminalAdoption', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function daemon(): { host: ParadisPtyDaemonHost; ptys: FakePty[] } {
		const disposables = store.add(new DisposableStore());
		const ptys: FakePty[] = [];
		const host = disposables.add(new ParadisPtyDaemonHost(() => {
			const pty = new FakePty(9000 + ptys.length, disposables);
			ptys.push(pty);
			return pty;
		}));
		return { host, ptys };
	}

	/**
	 * 常駐の一部だけを壊した相手を作る。
	 *
	 * クラスの実体をスプレッドしてもメソッドは写らない（prototype にあるため）ので、
	 * 一つずつ委譲する。
	 */
	function partlyBroken(host: ParadisPtyDaemonHost, overrides: Partial<IParadisPtyHost>): IParadisPtyHost {
		return {
			onDidChangeData: host.onDidChangeData,
			onDidChangeTitle: host.onDidChangeTitle,
			onDidExit: host.onDidExit,
			hello: () => host.hello(),
			list: () => host.list(),
			spawn: request => host.spawn(request),
			attach: handle => host.attach(handle),
			detach: handle => host.detach(handle),
			input: (handle, data) => host.input(handle, data),
			acknowledge: (handle, charCount) => host.acknowledge(handle, charCount),
			resize: (handle, cols, rows) => host.resize(handle, cols, rows),
			setMetadata: (handle, metadata) => host.setMetadata(handle, metadata),
			clearScrollback: handle => host.clearScrollback(handle),
			kill: (handle, signal) => host.kill(handle, signal),
			release: handle => host.release(handle),
			setLayout: (scopeId, layout) => host.setLayout(scopeId, layout),
			getLayout: scopeId => host.getLayout(scopeId),
			...overrides,
		};
	}

	function spawnRequest(metadata: string) {
		return { file: '/bin/zsh', args: [], env: {}, cwd: '/', cols: 80, rows: 24, term: 'xterm-256color', metadata };
	}

	test('前のアプリが残したものを、新しいアプリが預かりものごと引き取る', async () => {
		const { host, ptys } = daemon();

		// --- 前のアプリ ---
		const handle = (await host.spawn(spawnRequest(paradisEncodeTerminalMetadata({
			workspaceId: 'ws-1',
			workspaceName: 'para',
			shouldPersist: true,
			name: 'build',
			appearance: { icon: 'terminal-bash' }, launch: undefined,
		})))).handle;
		await host.attach(handle);
		ptys[0].emit('$ npm run build\r\n');
		// アプリが消える。**pty は生き残る。**
		await host.detach(handle);
		ptys[0].emit('done in 12s\r\n');

		// --- 新しいアプリ ---
		const result = await paradisAdoptTerminals(host);
		const adopted = result.adopted[0];

		assert.deepStrictEqual(
			{
				count: result.adopted.length,
				skipped: result.skipped,
				alive: adopted.summary.alive,
				pid: adopted.summary.pid,
				workspace: [adopted.metadata.workspaceId, adopted.metadata.workspaceName],
				name: adopted.metadata.name,
				appearance: adopted.metadata.appearance,
				launch: adopted.metadata.launch,
				// 閉じている間の出力も含めて、画面を作り直せる。
				replay: adopted.replay,
				dropped: adopted.dropped,
			},
			{
				count: 1,
				skipped: 0,
				alive: true,
				pid: 9000,
				workspace: ['ws-1', 'para'],
				name: 'build',
				appearance: { icon: 'terminal-bash' }, launch: undefined,
				replay: '$ npm run build\r\ndone in 12s\r\n',
				dropped: false,
			},
		);
	});

	test('こぼれていたら黙らない。歯抜けの画面を「出力が無かった」と読ませない', async () => {
		const { host, ptys } = daemon();
		const handle = (await host.spawn(spawnRequest('{}'))).handle;
		await host.attach(handle);
		await host.detach(handle);

		let emitted = 0;
		while (emitted <= SCROLLBACK_LIMIT) {
			const chunk = 'x'.repeat(1024 * 1024);
			ptys[0].emit(chunk);
			emitted += chunk.length;
		}

		const adopted = (await paradisAdoptTerminals(host)).adopted[0];

		assert.deepStrictEqual(
			{ dropped: adopted.dropped, mixedIntoReplay: adopted.replay.includes('discarded') },
			{
				// こぼれたことは伝える。
				dropped: true,
				// **断りは中身に混ぜない。** 混ぜると、実際に画面へ流す側が出す分と二重になる。
				mixedIntoReplay: false,
			},
		);
	});

	test('預かりものが読めなくても引き取る。失うのはアイコンであってプロセスではない', async () => {
		const { host } = daemon();
		await host.spawn(spawnRequest('this is not json at all'));
		await host.spawn(spawnRequest('{"workspaceId":42}'));

		const result = await paradisAdoptTerminals(host);

		assert.deepStrictEqual(
			{
				count: result.adopted.length,
				skipped: result.skipped,
				workspaces: result.adopted.map(a => a.metadata.workspaceId),
				// 分からないときは残す側へ倒す。読めなかっただけで走っているものを畳まない。
				persists: result.adopted.map(a => a.metadata.shouldPersist),
			},
			{ count: 2, skipped: 0, workspaces: ['', ''], persists: [true, true] },
		);
	});

	test('1本引き取れなくても、隣で走っているものを道連れにしない', async () => {
		const { host } = daemon();
		await host.spawn(spawnRequest('{}'));
		await host.spawn(spawnRequest('{}'));

		// 1本目だけ繋ぎ直せない常駐を演じる。
		const broken = partlyBroken(host, {
			attach: handle => handle === 1 ? Promise.reject(new Error('nope')) : host.attach(handle),
		});

		const result = await paradisAdoptTerminals(broken);

		assert.deepStrictEqual(
			{ adopted: result.adopted.map(a => a.summary.handle), skipped: result.skipped },
			{ adopted: [2], skipped: 1 },
		);
	});

	test('常駐と話せないことを「抱えているものが無い」と混同しない', async () => {
		const { host } = daemon();
		const unreachable = partlyBroken(host, { list: () => Promise.reject(new Error('socket is gone')) });

		const empty = await paradisAdoptTerminals(host);
		const result = await paradisAdoptTerminals(unreachable);

		assert.deepStrictEqual(
			{ unreachable: result.reachable, unreachableCount: result.adopted.length, reallyEmpty: empty.reachable, reallyEmptyCount: empty.adopted.length },
			{
				// 「聞けなかった」と「本当に無い」が、同じ空の結果で見分けられること。
				unreachable: false, unreachableCount: 0,
				reallyEmpty: true, reallyEmptyCount: 0,
			},
		);
	});

	test('閉じている間に走り切ったものも引き取れる。結果を読める', async () => {
		const { host, ptys } = daemon();
		const handle = (await host.spawn(spawnRequest('{}'))).handle;
		await host.attach(handle);
		await host.detach(handle);

		ptys[0].emit('BUILD SUCCESS\r\n');
		await timeout(600);

		const adopted = (await paradisAdoptTerminals(host)).adopted[0];

		assert.deepStrictEqual(
			{ count: 1, replay: adopted.replay },
			{ count: 1, replay: 'BUILD SUCCESS\r\n' },
		);
	});
});
