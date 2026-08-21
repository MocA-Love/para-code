/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐がターミナル1本を抱える。**アプリより長生きする側**の実体。
//
// ここが持つのは pty そのもの、控え、大きさ、そして中身を見ない預かりもの (metadata) の4つだけ。
// 題名も cwd もシェル統合もここには無い。理由は `paradisPtyProtocol.ts` の冒頭。
//
// **この型の存在意義は、繋がっていない間の振る舞いにある。**
//
// 素の VS Code では、pty は「アプリが受け取ったと言ってきた分」だけ先へ進む。アプリを閉じると
// 誰も言わなくなるので、高水位に達した時点で pty が止まり、プログラムは書き込みで待つ。何も
// 失われないが、走り続けてもいない。常駐にする目的が「閉じてもビルドを走らせておく」ことである
// 以上、この振る舞いのままでは意味が無い。
//
// なので **繋がっていない間は常駐が代わりに受け取ったことにする** (tmux と同じ)。プログラムは
// 走り切り、溢れた古い出力は控えからこぼれる。こぼれたことは隠さない
// (`ParadisPtyScrollback.dropped`)。
//
// 逆に **繋がっている間は代理しない**。見ている相手が追いつけていないのに流し続ける理由が無く、
// そこはアプリの ack をそのまま pty へ通す (今までどおり)。

import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { isWindows } from '../../../../base/common/platform.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { FlowControlConstants } from '../../../../platform/terminal/common/terminal.js';
import { IParadisPtyAttachment, IParadisPtySummary } from '../common/paradisPtyProtocol.js';
import { ParadisPtyScrollback } from './paradisPtyScrollback.js';

/**
 * 抱えている pty。
 *
 * node-pty の `IPty` をそのまま受けずに最小の形に切ってあるのは、**本物のシェルを起動せずに
 * 振る舞いを確かめられるようにする**ため。ここで確かめたいのは「いつ止めて、いつ流すか」で、
 * それは node-pty の中身とは関係が無い。
 */
export interface IParadisPtyProcess {
	readonly pid: number;
	/** 前面で動いているものの名前。**pty を持っている側にしか見えない。** */
	readonly process: string;
	onData(listener: (data: string) => void): IDisposable;
	onExit(listener: (event: { readonly exitCode: number; readonly signal?: number }) => void): IDisposable;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
	/** 読み出しを止める／再開する。フロー制御の実体。 */
	pause(): void;
	resume(): void;
}

/** 題名を見に行く間隔。upstream の `TerminalProcess` と同じ。 */
const TITLE_POLL_INTERVAL = 200;

/**
 * 終了を告げる前に、出力が途切れるのを待つ時間。upstream の `ShutdownConstants.DataFlushTimeout`
 * と同じ 250ms。
 *
 * node-pty は終了イベントの後にもデータを出しきれないことがある (node-pty#72)。**待たずに終了を
 * 告げると、最後の出力が切れる**。切れるのは決まって末尾＝結果が書かれている場所なので、
 * 走り切らせる方針を採った以上ここを削ってはいけない。
 */
const DATA_FLUSH_TIMEOUT = 250;

export class ParadisPtyHolder extends Disposable {

	private readonly scrollback: ParadisPtyScrollback;

	/** 受け取ったと言われていない量。**繋がっている間だけ増える**。 */
	private unacknowledged = 0;
	private paused = false;
	private attached = false;
	private alive = true;
	private exitCode: number | undefined;
	private exitSignal: string | undefined;

	/**
	 * 終了を告げるのを待っている間の予約。出力が来るたびに取り直す（{@link queueExit}）。
	 */
	private readonly pendingExit = this._register(new MutableDisposable());

	private cols: number;
	private rows: number;

	/** 常駐は中身を見ない。 */
	private metadata: string;

	/** 繋がっている間だけ流す。繋がっていない間は控えにだけ入る。 */
	private readonly _onDidChangeData = this._register(new Emitter<string>());
	readonly onDidChangeData = this._onDidChangeData.event;

	private readonly _onDidExit = this._register(new Emitter<{ readonly code: number | undefined; readonly signal: string | undefined }>());
	readonly onDidExit = this._onDidExit.event;

	private readonly _onDidChangeTitle = this._register(new Emitter<string>());
	readonly onDidChangeTitle = this._onDidChangeTitle.event;

	/**
	 * 題名の見張り。**繋がっている間だけ回す。**
	 *
	 * 見ている人が居ないときに 200ms ごとに起こす理由が無い。抱えている本数ぶんの周期が
	 * 常に回っているのは、常駐が長生きすることを思えば無駄が積み上がる側の設計。
	 * 繋がっていないときの題名は {@link summary} がその場で読む。
	 */
	private readonly titleWatch = this._register(new MutableDisposable());
	private lastTitle = '';

	constructor(
		readonly handle: number,
		private readonly pty: IParadisPtyProcess,
		cols: number,
		rows: number,
		metadata: string,
	) {
		super();
		this.cols = cols;
		this.rows = rows;
		this.metadata = metadata;
		this.scrollback = new ParadisPtyScrollback(cols, rows);

		this._register(this.pty.onData(data => this.handleData(data)));
		this._register(this.pty.onExit(event => {
			this.alive = false;
			this.titleWatch.clear();
			this.exitCode = event.exitCode;
			this.exitSignal = event.signal === undefined ? undefined : String(event.signal);
			this.queueExit();
		}));
		this._register(toDisposable(() => {
			if (this.alive) {
				this.pty.kill();
			}
		}));
	}

	summary(): IParadisPtySummary {
		return {
			handle: this.handle,
			pid: this.pty.pid,
			cols: this.cols,
			rows: this.rows,
			alive: this.alive,
			// 繋がっていない間は見張っていないので、聞かれた時点で読む。
			title: this.alive ? this.pty.process : this.lastTitle,
			metadata: this.metadata,
		};
	}

	/**
	 * 題名が変わったら知らせる。
	 *
	 * Windows では前面プロセスが変わらないので回さない（upstream の `TerminalProcess` と同じ
	 * 判断）。いまの常駐は Windows では動かないが、判断の理由ごと残しておく。
	 */
	private watchTitle(): void {
		this.reportTitle();
		if (isWindows || !this.alive) {
			return;
		}
		this.titleWatch.value = disposableTimeout(() => {
			if (this.attached) {
				this.watchTitle();
			}
		}, TITLE_POLL_INTERVAL);
	}

	private reportTitle(): void {
		if (!this.alive) {
			return;
		}
		const title = this.pty.process;
		if (title !== this.lastTitle) {
			this.lastTitle = title;
			this._onDidChangeTitle.fire(title);
		}
	}

	/**
	 * 出力が途切れてから終了を告げる。**途切れないうちは何度でも先延ばしにする。**
	 */
	private queueExit(): void {
		this.pendingExit.value = disposableTimeout(() => {
			this.pendingExit.clear();
			this._onDidExit.fire({ code: this.exitCode, signal: this.exitSignal });
		}, DATA_FLUSH_TIMEOUT);
	}

	private handleData(data: string): void {
		this.scrollback.handleData(data);
		if (this.pendingExit.value) {
			// 終了した後にも出てくる。出し切るまで告げるのを待つ。
			this.queueExit();
		}
		if (!this.attached) {
			// 誰も見ていない。**待たせずに走らせる。** 未確認として数えないので高水位に達さず、
			// pty は止まらない。溢れたぶんは控えからこぼれ、こぼれたことは繋ぎ直しで伝える。
			return;
		}
		this.unacknowledged += data.length;
		this._onDidChangeData.fire(data);
		if (!this.paused && this.unacknowledged > FlowControlConstants.HighWatermarkChars) {
			this.paused = true;
			this.pty.pause();
		}
	}

	/**
	 * 繋ぎ直す。控えを渡し、以後の出力を流し始める。
	 *
	 * **控えを渡すことと流し始めることが同じ tick で起きる**ので、間に出た分が落ちることはない。
	 * 呼び出し側へは「この戻り値 → その後のイベント」の順で届く（同じ接続の上を順に流れる）。
	 */
	attach(): IParadisPtyAttachment {
		const attachment: IParadisPtyAttachment = { frames: this.scrollback.frames(), dropped: this.scrollback.dropped };
		this.attached = true;
		// 見る側が代わったので、前の相手あての未確認は数え直す。持ち越すと、繋ぎ直した直後に
		// 身に覚えのない高水位で止まる。
		this.unacknowledged = 0;
		this.resumeIfPaused();
		this.watchTitle();
		return attachment;
	}

	/**
	 * 見るのをやめる。**pty は止めない。**
	 */
	detach(): void {
		this.attached = false;
		this.titleWatch.clear();
		this.unacknowledged = 0;
		// 止まったまま離れると、閉じている間まったく進まなくなる。
		this.resumeIfPaused();
	}

	acknowledge(charCount: number): void {
		if (!this.attached) {
			return;
		}
		this.unacknowledged = Math.max(this.unacknowledged - charCount, 0);
		if (this.paused && this.unacknowledged < FlowControlConstants.LowWatermarkChars) {
			this.resumeIfPaused();
		}
	}

	private resumeIfPaused(): void {
		if (this.paused) {
			this.paused = false;
			this.pty.resume();
		}
	}

	input(data: string): void {
		if (this.alive) {
			this.pty.write(data);
		}
	}

	resize(cols: number, rows: number): void {
		if (cols === this.cols && rows === this.rows) {
			return;
		}
		this.cols = cols;
		this.rows = rows;
		this.scrollback.handleResize(cols, rows);
		if (this.alive) {
			this.pty.resize(cols, rows);
		}
	}

	setMetadata(metadata: string): void {
		this.metadata = metadata;
	}

	kill(signal?: string): void {
		if (this.alive) {
			this.pty.kill(signal);
		}
	}

	/** 終了したか、まだか。台帳や一覧の判断に使う。 */
	get exited(): { readonly code: number | undefined } | undefined {
		return this.alive ? undefined : { code: this.exitCode };
	}
}
