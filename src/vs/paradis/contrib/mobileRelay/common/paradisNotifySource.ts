/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** 通知の送り主を選ぶための、ターミナル1つぶんの材料。 */
export interface IParadisNotifyCandidate {
	readonly instanceId: number;
	/** 所属するスペース（スコープ）の状態キー。 */
	readonly stateKey: string | undefined;
	/** そのペイン自身のエージェントの状態。 */
	readonly status: string | undefined;
	/** 前回見たときのそのペインの状態（初めて見るペインは undefined）。 */
	readonly previousStatus: string | undefined;
}

/**
 * スペース（スコープ）の状態が変わって通知を出すとき、実際にその状態になったターミナルを選ぶ。
 *
 * スコープの状態は配下のペインをまとめた値なので、「スコープで最初に見つかったターミナル」を
 * 送り主にすると、同じスペースに2つのエージェントがいるとき別のエージェントのトークンで通知して
 * しまう（モバイルはトークンで既読化・置き換え・遷移をするので、違うエージェントの通知が消えたり
 * 違う画面が開いたりする）。同じ状態のペインが2つあれば、今回その状態へ変わった方を選ぶ。
 * 見つからなければ undefined（呼び出し側が従来どおりに落とす）。
 */
export function paradisPickNotifyInstance(candidates: readonly IParadisNotifyCandidate[], stateKey: string, status: string): number | undefined {
	const inScope = candidates.filter(candidate => candidate.stateKey === stateKey && candidate.status === status);
	// 今回その状態へ変わったペインを優先する（前からその状態だったペインは、別のエージェントの話）。
	return (inScope.find(candidate => candidate.previousStatus !== status) ?? inScope[0])?.instanceId;
}
