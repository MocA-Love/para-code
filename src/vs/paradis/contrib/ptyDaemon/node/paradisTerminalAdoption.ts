/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐が抱えているものを、新しく起きたアプリが引き取る。**ここまでの全部が、これのためにある。**
//
// 似たものが upstream にあるが別物。`reviveTerminalProcesses` は保存しておいた画面の文字を
// 復元して**シェルを起こし直す**もので、走っていたプロセスは死ぬ。こちらは走っているものに
// 繋ぎ直す。
//
// 引き取りで守ること:
//
//  1. **1本の失敗で全部を落とさない。** 預かりものが読めない、控えが壊れている、といった理由で
//     例外を投げると、隣で元気に走っている9本まで道連れになる。1本ずつ独立に扱う
//  2. **こぼれていたら伝える。** 走らせ切る方針を採った以上、長く走った出力は控えからこぼれる。
//     黙って歯抜けの画面を出すと、見た人は「出力が無かった」と読む
//  3. **勝手に殺さない。** 引き取れなかったものは常駐に残す。こちらが分からないというだけで
//     走っているプロセスを畳む理由が無い

import { IParadisPtyHost, IParadisPtySummary } from '../common/paradisPtyProtocol.js';
import { IParadisTerminalMetadata, paradisDecodeTerminalMetadata } from '../common/paradisTerminalMetadata.js';

/** 引き取れた1本。 */
export interface IParadisAdoptedTerminal {
	readonly summary: IParadisPtySummary;
	readonly metadata: IParadisTerminalMetadata;
}

export interface IParadisAdoptionResult {
	/**
	 * 常駐に**聞けたか**。
	 *
	 * 聞けなかったことを空の結果で表すと、呼び出し側は「抱えているものが無い」と区別できない。
	 * 前者は「分からない」で、後者は「無い」。取り違えると、走っているものがあるのに
	 * 「何も残っていません」と案内することになる。**空と不明を混ぜない。**
	 */
	readonly reachable: boolean;
	readonly adopted: readonly IParadisAdoptedTerminal[];
	/**
	 * 引き取れなかったもの。**常駐にはそのまま残っている。**
	 *
	 * 数を返すのは、黙って減っているのが一番困るため。呼び出し側がログにも画面にも出せる。
	 */
	readonly skipped: number;
}

/**
 * 常駐が抱えているものを一通り数え上げる。
 *
 * **ここでは繋ぎ直さない（`attach` しない）。** 一度ここで繋ぐと、次の2つが同時に起きる:
 *
 *  1. 器の `start()` がもう一度繋ぐので、控えが**二重に**流れる（画面に履歴が2回出る）。
 *     こぼれの判断は前回繋いだ時点からの区間で見るので、**2回目は必ず「こぼれていない」に
 *     なり、いちばん断りが要る場面で黙る**
 *  2. 見る人が現れる前に「見られている」状態になる。すると未確認の文字が数え上がり、誰も
 *     ack しないので高水位で pty が止まる。**閉じている間も走り切らせるという判断が、
 *     引き取った直後に無言で覆る**
 *
 * 繋ぐのは、窓が実際に開きに来たとき（器の `start()`）に1回だけ。
 */
export async function paradisAdoptTerminals(host: IParadisPtyHost): Promise<IParadisAdoptionResult> {
	let summaries: readonly IParadisPtySummary[];
	try {
		summaries = await host.list();
	} catch {
		// 常駐と話せない。**これは「抱えているものが無い」ではない。** 区別が付く形で返す。
		return { reachable: false, adopted: [], skipped: 0 };
	}

	const adopted: IParadisAdoptedTerminal[] = [];
	let skipped = 0;
	for (const summary of summaries) {
		try {
			adopted.push({ summary, metadata: paradisDecodeTerminalMetadata(summary.metadata) });
		} catch {
			// 1本ずつ独立に。隣で元気に走っているものを道連れにしない。
			skipped++;
		}
	}
	return { reachable: true, adopted, skipped };
}
