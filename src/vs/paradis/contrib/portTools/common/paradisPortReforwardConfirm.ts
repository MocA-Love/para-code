/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ポートの転送の張り直し（reforward_port と clean_up_port_forwards の mismatched）の確認に出す中身（q.html の Q614、案 C）。
// 見出し・依頼元と理由・「この窓」「ほかの窓」で起きることを先に出し、ポートは番号の粒で並べ、全部の一覧は畳む。
// 番号が変わる行だけは畳まずに出す。拒否した後に起きること（3 分間の自動の断り）も書く。
// ここは文と並びを決めるだけで、描くのは electron-browser/paradisPortReforwardConfirmDialog.ts。

import { localize } from '../../../../nls.js';

/** 番号の粒を並べる数。超えた分は「ほか N 件と一覧を見る」にまとめる。 */
export const PARADIS_REFORWARD_CONFIRM_MAX_CHIPS = 12;

/** 張り直す転送 1 件。 */
export interface IParadisReforwardConfirmRow {
	readonly remotePort: number;
	/** 今の手元の番号。 */
	readonly localPort: number | undefined;
	/** 手元の番号を {@link remotePort} に変えるか。 */
	readonly changesLocal: boolean;
	/** ポートパネルの名前（表示用に整えたもの）。 */
	readonly label?: string;
}

/** 同じ SSH 先のほかの窓が、張り直す転送を使っているか。 */
export type ParadisReforwardOtherWindows =
	| { readonly kind: 'unknown' }
	| { readonly kind: 'none' }
	| { readonly kind: 'some'; readonly count: number };

export interface IParadisReforwardConfirmInput {
	readonly rows: readonly IParadisReforwardConfirmRow[];
	/** 手元の番号が使用中のため、番号を揃えずに外したもの。 */
	readonly inUse: readonly { readonly remotePort: number; readonly localPort: number | undefined }[];
	/** エージェントが書いた理由（表示用に整えたもの）。 */
	readonly reason: string | undefined;
	/** 理由を書ける道具か（clean_up_port_forwards には理由の引数が無いので、理由の行を出さない）。 */
	readonly asksReason: boolean;
	readonly otherWindows: ParadisReforwardOtherWindows;
}

/** 確認の中身（翻訳済みの文）。 */
export interface IParadisReforwardConfirm {
	readonly title: string;
	/** 「エージェントが書いた理由: …」か「エージェントは理由を書いていません」。理由を書けない道具なら undefined。 */
	readonly reason: string | undefined;
	readonly summary: string;
	/** 番号の粒（先頭の {@link PARADIS_REFORWARD_CONFIRM_MAX_CHIPS} 件）。 */
	readonly chips: readonly { readonly port: number; readonly changes: boolean }[];
	/** 一覧を開くボタンの文。 */
	readonly openListLabel: string;
	readonly closeListLabel: string;
	/** 番号が変わる行（畳まずに出す）。 */
	readonly changed: readonly string[];
	/** 全部の行（畳んでおく）。 */
	readonly all: readonly { readonly port: number; readonly text: string; readonly changes: boolean }[];
	/** 手元の番号が使用中のため変えないもの。無ければ空。 */
	readonly inUse: readonly string[];
	readonly thisWindowHeading: string;
	readonly thisWindow: string;
	readonly otherWindowsHeading: string;
	readonly otherWindows: { readonly tone: 'warning' | 'success' | 'info'; readonly text: string };
	readonly denyNote: string;
	readonly approveLabel: string;
}

/**
 * 転送ごとの、それを使っている窓の数（この窓を含む。分からなければ undefined）から、ほかの窓への影響を決める。
 * 確かに 0 のときだけ「影響なし」にし、1 件でも分からなければ「分からない」にする（影響ありの件があればそれを出す）。
 */
export function paradisReforwardOtherWindows(referenceCounts: readonly (number | undefined)[]): ParadisReforwardOtherWindows {
	let most = 0;
	let unknown = referenceCounts.length === 0;
	for (const count of referenceCounts) {
		// この窓の分が数に入っていなければ、数え方が想定と違う。分からないことにする
		if (count === undefined || count < 1) {
			unknown = true;
			continue;
		}
		most = Math.max(most, count - 1);
	}
	if (most > 0) {
		return { kind: 'some', count: most };
	}
	return unknown ? { kind: 'unknown' } : { kind: 'none' };
}

function localText(port: number | undefined): string {
	return `localhost:${port ?? '?'}`;
}

/** 張り直しの確認の中身を決める。 */
export function paradisReforwardConfirm(input: IParadisReforwardConfirmInput): IParadisReforwardConfirm {
	const { rows } = input;
	const changedRows = rows.filter(row => row.changesLocal);
	const withLabel = (text: string, label: string | undefined) => label ? localize('paradis.portTools.confirm.withLabel', "{0}（{1}）", text, label) : text;
	const otherWindows = (() => {
		switch (input.otherWindows.kind) {
			case 'none': return { tone: 'success' as const, text: localize('paradis.portTools.confirm.others.none', "ほかの窓では、このポートを使っていません。影響はありません。") };
			case 'some': return { tone: 'warning' as const, text: localize('paradis.portTools.confirm.others.some', "同じ SSH 先のほかの窓（{0} つ）でも、同じポートの通信が一度切れます。転送そのものは残ります。", input.otherWindows.count) };
			default: return { tone: 'info' as const, text: localize('paradis.portTools.confirm.others.unknown', "同じ SSH 先のほかの窓で同じポートを使っていれば、そちらの通信も一度切れます。") };
		}
	})();
	return {
		title: localize('paradis.portTools.confirm.title', "エージェントが転送 {0} 件のつなぎ直しを求めています", rows.length),
		reason: !input.asksReason ? undefined : input.reason
			? localize('paradis.portTools.confirm.reason', "エージェントが書いた理由: {0}", input.reason)
			: localize('paradis.portTools.confirm.noReason', "エージェントは理由を書いていません"),
		summary: changedRows.length > 0
			? localize('paradis.portTools.confirm.summaryChanges', "SSH 先のポート {0} 件の転送を一度閉じて開き直します。{1} 件はこの PC で開くアドレスが変わります。", rows.length, changedRows.length)
			: localize('paradis.portTools.confirm.summary', "SSH 先のポート {0} 件の転送を一度閉じて、同じアドレスで開き直します。", rows.length),
		chips: rows.slice(0, PARADIS_REFORWARD_CONFIRM_MAX_CHIPS).map(row => ({ port: row.remotePort, changes: row.changesLocal })),
		openListLabel: rows.length > PARADIS_REFORWARD_CONFIRM_MAX_CHIPS
			? localize('paradis.portTools.confirm.openMore', "ほか {0} 件と一覧を見る", rows.length - PARADIS_REFORWARD_CONFIRM_MAX_CHIPS)
			: localize('paradis.portTools.confirm.open', "一覧を見る"),
		closeListLabel: localize('paradis.portTools.confirm.close', "一覧を閉じる"),
		changed: changedRows.map(row => withLabel(localize('paradis.portTools.confirm.changedRow', "{0}: {1} → {2}（元のアドレスのタブは繋がらなくなります）", row.remotePort, localText(row.localPort), localText(row.remotePort)), row.label)),
		all: rows.map(row => ({
			port: row.remotePort,
			text: withLabel(row.changesLocal
				? localize('paradis.portTools.confirm.rowChanges', "{0} → {1} を {2} に変える", row.remotePort, localText(row.localPort), localText(row.remotePort))
				: localize('paradis.portTools.confirm.rowKeeps', "{0} → {1}（そのまま）", row.remotePort, localText(row.localPort)), row.label),
			changes: row.changesLocal,
		})),
		inUse: input.inUse.length === 0 ? [] : [
			localize('paradis.portTools.confirm.inUse', "手元の番号が使用中のため変えないもの: {0}（この PC でほかのアプリがその番号を使っています。今のアドレスのまま残します）", input.inUse.map(item => item.remotePort).join(', ')),
		],
		thisWindowHeading: localize('paradis.portTools.confirm.thisWindow', "この窓"),
		thisWindow: changedRows.length > 0
			? localize('paradis.portTools.confirm.thisWindowChanges', "開いている通信が一度切れます。アドレスが変わるポートは、元のアドレスのタブが繋がらなくなります。")
			: localize('paradis.portTools.confirm.thisWindowKeeps', "開いている通信（自動更新・WebSocket・DB など）が一度切れます。開き直せば戻ります。"),
		otherWindowsHeading: localize('paradis.portTools.confirm.otherWindows', "ほかの窓"),
		otherWindows,
		denyNote: localize('paradis.portTools.confirm.denyNote', "拒否すると何も変わりません。このターミナルからのポートの変更は 3 分間、自動で断ります。"),
		approveLabel: localize('paradis.portTools.confirm.approve', "{0} 件をつなぎ直す", rows.length),
	};
}
