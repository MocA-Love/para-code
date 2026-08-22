/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐が抱えているもの全体の振る舞い。
//
// いちばん見張りたいのは **終わったターミナルを勝手に捨てないこと**。閉じている間に走り切らせる
// 方針を選んだ以上、走り切った結果を戻ってきた人が読めなければ意味が無い。ここが崩れると
// 「閉じている間にビルドが終わっていて、何も残っていない」という、直前まで正しく動いていたのに
// 手ぶらで終わる形になる。

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPtySpawnRequest, PARADIS_PTY_PROTOCOL_VERSION } from '../../common/paradisPtyProtocol.js';
import { IParadisPtyProcess } from '../../node/paradisPtyHolder.js';
import { ParadisPtyDaemonHost } from '../../node/paradisPtyDaemonHost.js';

class FakePty implements IParadisPtyProcess {
	killed = false;
	process = 'zsh';
	private readonly data: Emitter<string>;
	private readonly exit: Emitter<{ exitCode: number; signal?: number }>;

	constructor(readonly pid: number, store: DisposableStore) {
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

/** 終了を告げる前に出力の途切れを待つ時間。実装と同じ値。 */
const DATA_FLUSH_TIMEOUT = 250;

function request(metadata: string): IParadisPtySpawnRequest {
	return { file: '/bin/zsh', args: [], env: {}, cwd: '/', cols: 80, rows: 24, term: 'xterm-256color', metadata };
}

suite('ParadisPtyDaemonHost', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(): { host: ParadisPtyDaemonHost; ptys: FakePty[] } {
		const disposables = store.add(new DisposableStore());
		const ptys: FakePty[] = [];
		const host = disposables.add(new ParadisPtyDaemonHost(() => {
			const pty = new FakePty(1000 + ptys.length, disposables);
			ptys.push(pty);
			return pty;
		}));
		return { host, ptys };
	}

	test('抱えたものを一覧で返し、預かりものは中身を見ずにそのまま返す', async () => {
		const { host } = create();
		const first = (await host.spawn(request('{"space":"para"}'))).handle;
		await host.spawn(request('second'));
		await host.setMetadata(first, 'changed');

		const greeting = await host.hello();
		const summaries = await host.list();

		assert.deepStrictEqual(
			{
				version: greeting.protocolVersion,
				summaries: summaries.map(s => [s.handle, s.pid, s.alive, s.metadata]),
			},
			{
				version: PARADIS_PTY_PROTOCOL_VERSION,
				summaries: [[1, 1000, true, 'changed'], [2, 1001, true, 'second']],
			},
		);
	});

	test('終わったターミナルを勝手に捨てない。閉じている間に走り切った結果は戻ってから読める', async () => {
		const { host, ptys } = create();
		const handle = (await host.spawn(request('build'))).handle;
		await host.attach(handle, 'viewer');
		await host.detach(handle);

		// 閉じている間に走り切った。
		ptys[0].emit('build finished\n');
		ptys[0].quit(0);
		await timeout(DATA_FLUSH_TIMEOUT * 2);

		const afterExit = await host.list();
		const attachment = await host.attach(handle, 'viewer');

		// アプリが読み終えて手放したら、そこで初めて消える。
		await host.release(handle);
		const afterRelease = await host.list();

		assert.deepStrictEqual(
			{
				stillListed: afterExit.map(s => [s.handle, s.alive]),
				output: attachment.frames.map(f => f.data).join(''),
				afterRelease: afterRelease.length,
			},
			{
				stillListed: [[1, false]],
				output: 'build finished\n',
				afterRelease: 0,
			},
		);
	});

	test('まだ生きているものを手放すときは殺してから外す', async () => {
		const { host, ptys } = create();
		const handle = (await host.spawn(request('running'))).handle;

		await host.release(handle);

		assert.deepStrictEqual(
			{ killed: ptys[0].killed, listed: (await host.list()).length },
			// 走らせたまま行方不明にする方が悪い。
			{ killed: true, listed: 0 },
		);
	});

	test('知らない handle は黙って捨てるが、繋ぎ直しだけは投げる', async () => {
		const { host } = create();

		// できることが無い呼び出しは投げない（アプリ側の見え方が一瞬古いだけのことがある）。
		await host.input(99, 'x');
		await host.resize(99, 1, 1);
		await host.acknowledge(99, 1);
		await host.detach(99);
		await host.release(99);

		// 繋げなかったことを知らずに進むと、空の画面を「出力が無かった」と読む。
		let attachThrew = false;
		try {
			await host.attach(99, 'viewer');
		} catch {
			attachThrew = true;
		}

		assert.deepStrictEqual({ attachThrew }, { attachThrew: true });
	});

	test('見に来た相手ごとに離す。片方が消えても、もう片方の端末は止めない', async () => {
		const { host } = create();
		const mine = (await host.spawn(request('a'))).handle;
		const theirs = (await host.spawn(request('b'))).handle;
		await host.attach(mine, 'server-old');
		await host.attach(theirs, 'server-new');

		// 更新のあと古いサーバーが居座り、やがて消える状況。
		host.releaseViewers('server-old');

		const summaries = await host.list();

		assert.deepStrictEqual(
			summaries.map(summary => [summary.handle, summary.attached]),
			[
				// 消えた相手の分は離す。離さないと誰も ack せず高水位で止まり、
				// 引き取りからも飛ばされて永久に戻らない。
				[mine, false],
				// **もう片方は止めない。** 全部離すと、動いている窓が無音になる。
				[theirs, true],
			],
		);
	});

	test('同じ端末を2者が見ていたら、片方が消えても止めない', async () => {
		const { host, ptys } = create();
		const shared = (await host.spawn(request('shared'))).handle;
		await host.attach(shared, 'server-old');
		await host.attach(shared, 'server-new');

		const seen: string[] = [];
		store.add(host.onDidChangeData(event => seen.push(event.data)));

		host.releaseViewers('server-old');
		ptys[0].emit('still watched');

		// 「見られている」は真偽値なので、最後の1人か確かめずに倒すと、残っている側への出力が
		// 止まって窓が無音になる。見えないうえ直せない形。
		assert.deepStrictEqual(
			{ seen, attached: (await host.list())[0].attached },
			{ seen: ['still watched'], attached: true },
		);
	});

	test('配置は預かってそのまま返す。空を渡されたら忘れる', async () => {
		const { host } = create();
		await host.setLayout('workspace-a', '{"tabs":[1,2]}');
		const kept = await host.getLayout('workspace-a');

		// 消す道が他に無い。スペースを消しても常駐はそれを知らないので、ここが唯一の掃除口。
		await host.setLayout('workspace-a', '');

		assert.deepStrictEqual(
			{ kept, cleared: await host.getLayout('workspace-a'), missing: await host.getLayout('workspace-b') },
			{ kept: '{"tabs":[1,2]}', cleared: undefined, missing: undefined },
		);
	});

	test('畳むときは抱えている pty も畳む。孤児を残さない', async () => {
		const disposables = store.add(new DisposableStore());
		const ptys: FakePty[] = [];
		const host = new ParadisPtyDaemonHost(() => {
			const pty = new FakePty(1000 + ptys.length, disposables);
			ptys.push(pty);
			return pty;
		});
		await host.spawn(request('a'));
		await host.spawn(request('b'));

		host.dispose();

		// 畳まないと、SIGHUP を握り潰すプロセスは常駐が消えた後も走り続け、
		// 誰からも見えない孤児になる。
		assert.deepStrictEqual(ptys.map(pty => pty.killed), [true, true]);
	});

	test('出力と終了は handle を添えて流れる', async () => {
		const { host, ptys } = create();
		const data: string[] = [];
		const exits: number[] = [];
		store.add(host.onDidChangeData(event => data.push(`${event.handle}:${event.data}`)));
		store.add(host.onDidExit(event => exits.push(event.handle)));

		const first = (await host.spawn(request('a'))).handle;
		const second = (await host.spawn(request('b'))).handle;
		await host.attach(first, 'viewer');
		await host.attach(second, 'viewer');
		ptys[0].emit('from first');
		ptys[1].emit('from second');
		ptys[1].quit(3);
		// 終了は出力が途切れてから告げられる（末尾を切り落とさないため）。
		await timeout(DATA_FLUSH_TIMEOUT * 2);

		assert.deepStrictEqual({ data, exits }, { data: ['1:from first', '2:from second'], exits: [second] });
	});
});
