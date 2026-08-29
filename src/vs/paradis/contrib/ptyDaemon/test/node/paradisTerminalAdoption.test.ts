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
	quit(exitCode: number): void { this.exit.fire({ exitCode }); }
}

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
			attach: (handle, viewer) => host.attach(handle, viewer),
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
			launch: undefined,
		})))).handle;
		await host.attach(handle, 'viewer');
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
				launch: adopted.metadata.launch,
			},
			{
				count: 1,
				skipped: 0,
				alive: true,
				pid: 9000,
				workspace: ['ws-1', 'para'],
				name: 'build',
				launch: undefined,
			},
		);
	});

	test('数え上げるだけで繋ぎ直さない。繋ぐのは窓が開きに来たとき1回だけ', async () => {
		const { host, ptys } = daemon();
		const handle = (await host.spawn(spawnRequest('{}'))).handle;
		await host.attach(handle, 'viewer');
		await host.detach(handle);
		ptys[0].emit('while nobody was watching\r\n');

		await paradisAdoptTerminals(host);

		// ここで繋いでしまうと、(1) 器が繋ぐときに控えが二重に流れ、(2) 見る人が現れる前に
		// 「見られている」状態になって、誰も ack しないまま高水位で pty が止まる。
		const attachment = await host.attach(handle, 'viewer');

		assert.deepStrictEqual(
			{ frames: attachment.frames.map(frame => frame.data).join(''), dropped: attachment.dropped },
			{ frames: 'while nobody was watching\r\n', dropped: false },
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

	test('すでに誰かが見ているものは引き取らない。二重に持たない', async () => {
		const { host } = daemon();
		const watched = (await host.spawn(spawnRequest('{}'))).handle;
		await host.spawn(spawnRequest('{}'));

		// 更新のあと古いサーバーが居座ると、両方が同じ置き場所を見る。両方が引き取ると
		// 入力も出力も二重になり、こちらの終了操作が向こうの端末を殺す。
		await host.attach(watched, 'viewer');

		const result = await paradisAdoptTerminals(host);

		assert.deepStrictEqual(
			{ adopted: result.adopted.map(terminal => terminal.summary.handle), skipped: result.skipped },
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

	test('閉じている間に走り切ったものは、終わったことと終了コードごと引き取れる', async () => {
		const { host, ptys } = daemon();
		const handle = (await host.spawn(spawnRequest('{}'))).handle;
		await host.attach(handle, 'viewer');
		await host.detach(handle);

		ptys[0].emit('BUILD SUCCESS\r\n');
		ptys[0].quit(0);
		await timeout(600);

		const adopted = (await paradisAdoptTerminals(host)).adopted[0];

		assert.deepStrictEqual(
			{ alive: adopted.summary.alive, exitCode: adopted.summary.exitCode },
			{
				// **イベントを待っても来ない。** 戻ってきた側が結果を読むのがこの機能の主目的
				// なので、終わり方は要約に載っていなければならない。
				alive: false,
				exitCode: 0,
			},
		);
	});
	// 同じ nonce を持つ2本が並ぶことがある。繋ぎ直しに失敗すると upstream はそのタブでシェルを
	// 起こし直すが、nonce は端末に付いたまま引き継がれるため。どちらをタブに返すかは、この
	// 並び順と、先に見たほうを採る `ptyService` の登録が組で決めている。
	//
	// 常駐は終わった端末も控えごと残すので、**古い順だけで並べると、先に終わった1本が、いま
	// 走っている1本から nonce を奪う**。タブは死んだ端末に繋がり、走っているほうが見えなくなる。
	test('走っているものを先に返す。終わったものが、生きているものを押しのけない', async () => {
		const { host, ptys } = daemon();
		const first = await host.spawn(spawnRequest('{}'));
		await host.spawn(spawnRequest('{}'));
		// 先に起きたほうが先に終わる。
		ptys[0].quit(0);
		await timeout(0);

		const result = await paradisAdoptTerminals(host);

		assert.deepStrictEqual(
			result.adopted.map(terminal => ({ handle: terminal.summary.handle, alive: terminal.summary.alive })),
			[
				{ handle: first.handle + 1, alive: true },
				{ handle: first.handle, alive: false },
			],
		);
	});
});
