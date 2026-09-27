/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタのターミナルタブに出す「呼んでいる」印（Q43 案A）と、タブ左のアイコン（Q52 案B）の
// 判定。DOM にもサービスにも触れない純粋な関数だけを置く。

import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';

/**
 * ターミナルがユーザーを呼んでいる理由。
 * - `waiting`: 許可待ち・質問（赤）
 * - `done`: エージェントの作業が終わった（緑）
 * - `bell`: ターミナルのベルが鳴った（黄）
 */
export type ParadisTerminalAttention = 'waiting' | 'done' | 'bell';

/** 同じターミナルで理由が重なったときの強さ。強い方を残す。 */
const ATTENTION_PRIORITY: Record<ParadisTerminalAttention, number> = { waiting: 3, done: 2, bell: 1 };

function stronger(left: ParadisTerminalAttention | undefined, right: ParadisTerminalAttention | undefined): ParadisTerminalAttention | undefined {
	if (left === undefined) {
		return right;
	}
	if (right === undefined) {
		return left;
	}
	return ATTENTION_PRIORITY[left] >= ATTENTION_PRIORITY[right] ? left : right;
}

function isWaiting(status: ParadisAgentStatus | undefined): boolean {
	return status === 'permission' || status === 'question';
}

/**
 * エージェントの状態が変わったときの、呼んでいる印の次の値。
 *
 * - 許可待ち・質問に入ったら `waiting`。答えて抜けたら（ユーザーがタブを触っていなくても）外す。
 *   モバイルから答えた場合などに、もう呼んでいないタブへ印が残り続けないようにするため
 * - 作業中から完了（`review`、または状態なし）へ移ったら `done`。状態が消えるのは、見ているスペース
 *   の完了をアプリがすぐ既読にする場合で、ユーザーがそのタブを見たとは限らない
 * - ユーザーがそのターミナルを見ている（フォーカスがある）ときは印を付けない
 *
 * 付けた `done` と `bell` は、ユーザーがそのターミナルを操作するまで残す（`paradisClearAttention`）。
 */
export function paradisNextAttentionOnStatus(
	previous: ParadisAgentStatus | undefined,
	current: ParadisAgentStatus | undefined,
	latched: ParadisTerminalAttention | undefined,
	isWatching: boolean,
): ParadisTerminalAttention | undefined {
	let next = latched;
	if (next === 'waiting' && !isWaiting(current)) {
		next = undefined;
	}
	if (isWatching) {
		return next === 'waiting' ? undefined : next;
	}
	if (isWaiting(current) && current !== previous) {
		return stronger(next, 'waiting');
	}
	const finished = (current === 'review' && previous !== 'review')
		|| (current === undefined && previous === 'working');
	if (finished) {
		return stronger(next, 'done');
	}
	return next;
}

/** ベルが鳴ったときの次の値。見ているターミナル（入力中の補完失敗など）では付けない。 */
export function paradisNextAttentionOnBell(latched: ParadisTerminalAttention | undefined, isWatching: boolean): ParadisTerminalAttention | undefined {
	return isWatching ? latched : stronger(latched, 'bell');
}

/** タブの見出しに付ける色（テーマ色 ID）。スペース一覧のドットと同じ語彙に揃える。 */
export function paradisAttentionColor(attention: ParadisTerminalAttention): string {
	switch (attention) {
		case 'waiting': return 'charts.red';
		case 'done': return 'charts.green';
		case 'bell': return 'charts.yellow';
	}
}
