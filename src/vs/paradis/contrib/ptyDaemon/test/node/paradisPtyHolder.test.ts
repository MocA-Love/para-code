/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「いつ止めて、いつ流すか」を固定する。**常駐にした目的そのもの**なので、ここが崩れると
// アプリを閉じた瞬間にビルドが止まる — しかも止まったことは誰にも見えない。
//
// 本物のシェルは起動しない。確かめたいのは判断であって node-pty の中身ではないので、pty は
// 差し替えている（`IParadisPtyProcess`）。

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { FlowControlConstants } from '../../../../../platform/terminal/common/terminal.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPtyProcess, ParadisPtyHolder } from '../../node/paradisPtyHolder.js';

class FakePty implements IParadisPtyProcess {
	readonly pid = 4321;
	readonly writes: string[] = [];
	readonly resizes: [number, number][] = [];
	killed = false;
	paused = false;
	/** 止められた回数。**一度も止まらなかったこと**を見るために数える。 */
	pauseCount = 0;

	private readonly data = new Emitter<string>();
	private readonly exit = new Emitter<{ exitCode: number; signal?: number }>();

	constructor(private readonly store: DisposableStore) {
		store.add(this.data);
		store.add(this.exit);
	}

	onData(listener: (data: string) => void): IDisposable { return this.store.add(this.data.event(listener)); }
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable { return this.store.add(this.exit.event(listener)); }
	write(data: string): void { this.writes.push(data); }
	resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
	kill(): void { this.killed = true; }
	pause(): void { this.paused = true; this.pauseCount++; }
	resume(): void { this.paused = false; }

	emit(data: string): void { this.data.fire(data); }
	quit(exitCode: number): void { this.exit.fire({ exitCode }); }
}

/** 高水位を確実に超える量。**止まるかどうか**はこちらで決まる。 */
const FLOOD = 'x'.repeat(FlowControlConstants.HighWatermarkChars + 1);

/**
 * 控えの上限を確実に超える量。**こぼれるかどうか**はこちらで決まる。
 *
 * 2つを取り違えると「あふれさせたつもりで、あふれていない」テストになる（一度やった）。
 */
const SCROLLBACK_LIMIT = 10 * 1024 * 1024;

suite('ParadisPtyHolder', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(): { pty: FakePty; holder: ParadisPtyHolder } {
		const disposables = store.add(new DisposableStore());
		const pty = new FakePty(disposables);
		const holder = disposables.add(new ParadisPtyHolder(1, pty, 80, 24, 'opaque'));
		return { pty, holder };
	}

	test('誰も見ていない間は止めない。走り切らせ、こぼれたことは繋ぎ直しで伝える', () => {
		const { pty, holder } = create();

		// アプリが閉じている状態。素の VS Code はここで高水位に達して pty を止め、
		// プログラムを待たせる。常駐にした意味が無くなるので、止めない。
		holder.attach();
		holder.detach();
		let emitted = 0;
		while (emitted <= SCROLLBACK_LIMIT) {
			pty.emit(FLOOD);
			emitted += FLOOD.length;
		}

		const attachment = holder.attach();

		assert.deepStrictEqual(
			{ pauseCount: pty.pauseCount, paused: pty.paused, dropped: attachment.dropped, hasFrames: attachment.frames.length > 0 },
			{
				// 一度も止めていない。
				pauseCount: 0,
				paused: false,
				// 上限を超えたぶんはこぼれた。**黙らない。**
				dropped: true,
				hasFrames: true,
			},
		);
	});

	test('見ている間は追いつくまで止め、受け取ったと言われたら再開する', () => {
		const { pty, holder } = create();
		holder.attach();

		pty.emit(FLOOD);
		const pausedWhileBehind = pty.paused;

		holder.acknowledge(FLOOD.length);

		assert.deepStrictEqual(
			{ pausedWhileBehind, pausedAfterAck: pty.paused, pauseCount: pty.pauseCount },
			{ pausedWhileBehind: true, pausedAfterAck: false, pauseCount: 1 },
		);
	});

	test('止まったまま離れない。繋ぎ直したときに前の相手の借金を持ち越さない', () => {
		const { pty, holder } = create();
		holder.attach();
		pty.emit(FLOOD);

		// 追いつかないまま閉じた。ここで止まったままにすると、閉じている間まったく進まない。
		holder.detach();
		const pausedAfterDetach = pty.paused;

		// 閉じている間の出力。止まっていないので届く。
		pty.emit('while away');
		holder.attach();

		// 繋ぎ直した直後に、身に覚えのない高水位で止まらないこと。
		pty.emit('a');

		assert.deepStrictEqual(
			{ pausedAfterDetach, pausedAfterReattach: pty.paused, pauseCount: pty.pauseCount },
			{ pausedAfterDetach: false, pausedAfterReattach: false, pauseCount: 1 },
		);
	});

	test('繋がっている間だけ流す。控えは繋ぎ直しのために残る', () => {
		const { pty, holder } = create();
		const streamed: string[] = [];
		store.add(holder.onDidChangeData(data => streamed.push(data)));

		pty.emit('before attach');
		holder.attach();
		pty.emit('after attach');
		holder.detach();
		pty.emit('after detach');

		const frames = holder.attach().frames.map(frame => frame.data).join('');

		assert.deepStrictEqual(
			{ streamed, frames },
			{
				// 誰も繋いでいないのに流すと、受け取り手のいないイベントが積み上がる。
				streamed: ['after attach'],
				// 控えには全部残っている。繋ぎ直せば画面は作り直せる。
				frames: 'before attachafter attachafter detach',
			},
		);
	});

	test('大きさは控えにも pty にも伝わり、同じ大きさでは何もしない', () => {
		const { pty, holder } = create();
		holder.resize(100, 30);
		holder.resize(100, 30);
		holder.attach();

		assert.deepStrictEqual(
			{ resizes: pty.resizes, summary: holder.summary().cols },
			{ resizes: [[100, 30]], summary: 100 },
		);
	});
});
