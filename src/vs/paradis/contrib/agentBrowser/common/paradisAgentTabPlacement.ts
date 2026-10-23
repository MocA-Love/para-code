/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントが open_browser_tab で開くタブを、エディタ領域のどのグループに置くかの決め方（純関数）。
//  (a) そのペインが前に開いたタブのあるグループがまだあれば、そこへタブとして足す
//  (b) 無ければ、ペインのターミナルがあるグループの右に分割する。分割後のブラウザが最小幅以上を取れるときだけ
//  (c) 取れないときは分割せず、ターミナルの無いグループのうち一番広いものへ足す。ターミナルしか無ければ
//      ペインのターミナルのグループ（無ければ一番広いグループ）へ裏のタブとして足す（ターミナルを隠さない）

/** 分割してよい、分割後のブラウザの最小幅（px）の設定。 */
export const PARADIS_AGENT_TAB_MIN_SPLIT_WIDTH_SETTING = 'paradis.agentBrowser.agentTabMinSplitWidth';

/** {@link PARADIS_AGENT_TAB_MIN_SPLIT_WIDTH_SETTING} の既定値。 */
export const PARADIS_AGENT_TAB_MIN_SPLIT_WIDTH_DEFAULT = 600;

/** 置き場所を決めるのに使う、グループ 1 つ分の様子。 */
export interface IParadisAgentTabGroupInfo {
	readonly id: number;
	/** グループの幅（px）。 */
	readonly width: number;
	/** 呼び出し元ペインのターミナルがこのグループにあるか。 */
	readonly hasPaneTerminal: boolean;
	/** ターミナル（どのペインのものでも）がこのグループにあるか。 */
	readonly hasTerminal: boolean;
	/** 呼び出し元ペインが前に開いたタブがこのグループにあるか。 */
	readonly hasOwnAgentTab: boolean;
}

/** 決めた置き場所。`inactive` は、グループの今のエディタを隠さないよう裏のタブとして足すか。 */
export type ParadisAgentTabPlacement =
	| { readonly kind: 'group'; readonly groupId: number; readonly inactive: boolean; readonly rule: 'ownTab' | 'widestFree' | 'terminalOnly' }
	| { readonly kind: 'split'; readonly besideGroupId: number };

/**
 * グループの一覧（新しく使った順）から置き場所を決める。グループが 1 つも無ければ undefined。
 * 分割は右へ半分に割るので、分割後の幅は元のグループの幅の半分として見る。
 */
export function paradisChooseAgentTabPlacement(groups: readonly IParadisAgentTabGroupInfo[], minSplitWidth: number): ParadisAgentTabPlacement | undefined {
	if (groups.length === 0) {
		return undefined;
	}
	const own = groups.find(group => group.hasOwnAgentTab);
	if (own) {
		// そのグループにターミナルがあるなら、ターミナルを隠さないよう裏に足す
		return { kind: 'group', groupId: own.id, inactive: own.hasTerminal, rule: 'ownTab' };
	}
	const paneTerminal = groups.find(group => group.hasPaneTerminal);
	if (paneTerminal && Math.floor(paneTerminal.width / 2) >= paradisNormalizeMinSplitWidth(minSplitWidth)) {
		return { kind: 'split', besideGroupId: paneTerminal.id };
	}
	const widestFree = widest(groups.filter(group => !group.hasTerminal));
	if (widestFree) {
		return { kind: 'group', groupId: widestFree.id, inactive: false, rule: 'widestFree' };
	}
	const fallback = paneTerminal ?? widest(groups)!;
	return { kind: 'group', groupId: fallback.id, inactive: true, rule: 'terminalOnly' };
}

/**
 * 画面に出ていないスペースへ開くタブを、窓へ隠したまま付けておくときの大きさ。そのスペースのグループの
 * 並びは戻るまで分からないので、エディタ領域の大きさから「ターミナルの横に分割したら」の幅を見積もる
 * （分割できない幅ならエディタ領域の幅）。戻って実際に置いたときに本当の大きさへ直る。
 */
export function paradisEstimateHiddenAgentTabSize(editorWidth: number, editorHeight: number, minSplitWidth: number): { readonly width: number; readonly height: number } {
	const half = Math.floor(editorWidth / 2);
	const width = half >= paradisNormalizeMinSplitWidth(minSplitWidth) ? half : Math.floor(editorWidth);
	// 0 の大きさではページが描かれないので、最低でも 1px は取る
	return { width: Math.max(1, width), height: Math.max(1, Math.floor(editorHeight)) };
}

/** 設定の値を使える最小幅へ直す。数でない・負の値は既定値。 */
export function paradisNormalizeMinSplitWidth(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : PARADIS_AGENT_TAB_MIN_SPLIT_WIDTH_DEFAULT;
}

/** 同じ幅なら先に並んでいる（新しく使った）方。 */
function widest(groups: readonly IParadisAgentTabGroupInfo[]): IParadisAgentTabGroupInfo | undefined {
	let best: IParadisAgentTabGroupInfo | undefined;
	for (const group of groups) {
		if (!best || group.width > best.width) {
			best = group;
		}
	}
	return best;
}
