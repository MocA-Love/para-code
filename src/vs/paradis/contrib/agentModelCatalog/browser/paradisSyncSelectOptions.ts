/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export interface IParadisSelectOption {
	readonly value: string;
	readonly label: string;
}

/**
 * `<select>` の選択肢を `wanted` の並びに揃える。作り直さず、差分だけを入れ替える。
 *
 * 選択肢を丸ごと作り直すと、利用者が開いていたドロップダウンが閉じる。モデル候補は CLI から
 * 数秒遅れて届くことがあるので、同じ値の option は同じ要素のまま残し、消えた値だけを外し、
 * 増えた値だけを足し、表示名が変わったものだけを書き換える。
 *
 * @returns 何か変えたか（何も変わらなければ DOM に一切触れていない）
 */
export function paradisSyncSelectOptions(select: HTMLSelectElement, wanted: readonly IParadisSelectOption[]): boolean {
	let changed = false;
	const wantedValues = new Set(wanted.map(item => item.value));
	for (const option of Array.from(select.options)) {
		if (!wantedValues.has(option.value)) {
			option.remove();
			changed = true;
		}
	}
	wanted.forEach((item, index) => {
		let option = Array.from(select.options).find(candidate => candidate.value === item.value);
		if (option === undefined) {
			option = select.ownerDocument.createElement('option');
			option.value = item.value;
			option.textContent = item.label;
			select.insertBefore(option, select.options[index] ?? null);
			changed = true;
			return;
		}
		if (option.textContent !== item.label) {
			option.textContent = item.label;
			changed = true;
		}
		if (select.options[index] !== option) {
			select.insertBefore(option, select.options[index] ?? null);
			changed = true;
		}
	});
	return changed;
}
