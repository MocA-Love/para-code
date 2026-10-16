/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 押す点に当たった要素（elementFromPoint）が、目的の要素とどういう関係かを、ページの中で判定する関数の定義（文字列）。
// paradisBrowserQueryPageScript.ts（click_by / fill_by / inspect_element）の中へそのまま埋め込む。
//
// 親子は表示の木（flat tree）でたどる。shadow DOM の中の要素は host の子、slot へ割り当てた要素は slot の子として扱う
// （Node.contains は shadow の境界を越えないため、カスタム要素の中のボタンを「覆われている」と取り違える）。
// 祖先に当たるのは、目的の要素が pointer-events: none のとき（人が押しても同じ祖先が受ける）と、目的の要素がその点で
// 切り取られて見えないとき（overflow: hidden の外。押すと祖先を押してしまう）。後者は覆われている扱いにする。

/**
 * `pointerHit(el, hit)` と `pointerReaches(el, hit, purpose)` を定義する文。
 * pointerHit は 'self' | 'child'（目的の要素の中）| 'ancestor'（目的の要素を含む）| 'other'。
 * pointerReaches はその点を押して目的の要素を操作したことになるか。fill はフィールド自身がフォーカスを受ける必要があるので祖先では断る。
 */
export const PARADIS_POINTER_HIT_PAGE_SCRIPT = String.raw`
	const flatParent = node => node.assignedSlot || node.parentElement || (node.parentNode && node.parentNode.host) || null;
	const flatContains = (ancestor, node) => {
		for (let current = node, depth = 0; current && depth < 4000; current = flatParent(current), depth++) {
			if (current === ancestor) { return true; }
		}
		return false;
	};
	const pointerHit = (el, hit) => hit === el ? 'self' : flatContains(el, hit) ? 'child' : flatContains(hit, el) ? 'ancestor' : 'other';
	const pointerReaches = (el, hit, purpose) => {
		const reach = pointerHit(el, hit);
		if (reach === 'self' || reach === 'child') { return true; }
		return reach === 'ancestor' && purpose !== 'fill' && getComputedStyle(el).pointerEvents === 'none';
	};
`;
