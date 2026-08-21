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
	/**
	 * 画面を作り直すための中身。
	 *
	 * **断りはここに混ぜない。** 混ぜると、繋ぎ直したときに出す分と二重になる。断りを出すのは
	 * 実際に画面へ流す側（`ParadisDaemonTerminalProcess`）の仕事で、こちらは {@link dropped} を
	 * 伝えるだけにする。
	 */
	readonly replay: string;
	/** 古い出力が捨てられていたか。呼び出し側が更に断りを出したいときのために残す。 */
	readonly dropped: boolean;
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
 * 常駐が抱えているものを一通り引き取る。
 *
 * 繋ぎ直し (`attach`) までここで済ませる。控えを受け取ることと流し始めることが同じ往復で
 * 起きるので、間の出力が落ちない。
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
			const attachment = await host.attach(summary.handle);
			const replay = attachment.frames.map(frame => frame.data).join('');
			adopted.push({
				summary,
				metadata: paradisDecodeTerminalMetadata(summary.metadata),
				replay,
				dropped: attachment.dropped,
			});
		} catch {
			// 1本ずつ独立に。隣で元気に走っているものを道連れにしない。
			skipped++;
		}
	}
	return { reachable: true, adopted, skipped };
}
