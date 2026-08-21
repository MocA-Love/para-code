/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 誰も繋いでいない間の出力を預かる。**繋ぎ直したときに画面を作り直すためのもの**。
//
// ここが要る理由は、常駐にした目的そのもの。アプリを閉じている間の出力は常駐しか受け取れない。
//
// **こぼれることを隠さない。** 閉じている間もプログラムを走らせ切る方針を採ったので、長く走れば
// 古い出力から捨てるしかない。捨てたこと自体は正しい動作だが、**捨てたのに何事も無かった顔で
// 画面を作り直すのは間違い**。歯抜けの画面を見た人は、出ていないものを「出なかった」と読む。
// だから {@link ParadisPtyScrollback.dropped} を返して、画面側で断りを出せるようにする。
//
// 溜め方そのものは `TerminalRecorder` に任せる。大きさの変わり目で区切って持ち、上限を超えたら
// 先頭から捨てる、という必要な性質を既に持っているため。**こぼれたかどうかだけ**をこちらで数える。
// あちらは保持量を外へ見せないが、方針が「最後の N バイトを残す」である以上、
// 「書いた総量が上限を超えたか」で厳密に判定できる。内部に手を入れずに済む。

import { TerminalRecorder } from '../../../../platform/terminal/common/terminalRecorder.js';
import { IParadisPtyFrame } from '../common/paradisPtyProtocol.js';

/**
 * 預かる上限。`TerminalRecorder` の上限と**必ず同じ値**にすること。
 *
 * ずれると {@link ParadisPtyScrollback.dropped} が嘘になる。多く見積もれば「こぼれたのに
 * こぼれていないと言う」ことになり、こぼれを隠さないという目的が丸ごと崩れる。
 */
const PARADIS_SCROLLBACK_LIMIT = 10 * 1024 * 1024;

/**
 * 1本ぶんの控え。
 *
 * 繋がっている間も溜め続けるのは、**繋ぎ直しが「閉じたとき」だけとは限らない**から
 * (ウィンドウの再読み込みでも起きる)。溜めること自体は上限付きなので青天井にはならない。
 */
export class ParadisPtyScrollback {

	private readonly recorder: TerminalRecorder;

	/** 書き込まれた総量。保持量ではない。 */
	private written = 0;

	constructor(cols: number, rows: number) {
		this.recorder = new TerminalRecorder(cols, rows);
	}

	/**
	 * 古い出力を捨てたか。
	 *
	 * 上限ちょうどでは捨てていない (`TerminalRecorder` は超えた分だけ削る) ので、判定は
	 * 「超えたか」であって「達したか」ではない。
	 */
	get dropped(): boolean {
		return this.written > PARADIS_SCROLLBACK_LIMIT;
	}

	handleData(data: string): void {
		this.written += data.length;
		this.recorder.handleData(data);
	}

	handleResize(cols: number, rows: number): void {
		this.recorder.handleResize(cols, rows);
	}

	/**
	 * いま持っているものをコマの並びにする。
	 *
	 * **返した後も控えは残す。** 繋ぎ直しは何度でも起こり得るので、渡した時点で捨てると
	 * 2つ目のウィンドウが空の画面を見ることになる。
	 */
	frames(): readonly IParadisPtyFrame[] {
		return this.recorder.generateReplayEventSync().events.map(event => ({
			cols: event.cols,
			rows: event.rows,
			data: event.data,
		}));
	}
}
