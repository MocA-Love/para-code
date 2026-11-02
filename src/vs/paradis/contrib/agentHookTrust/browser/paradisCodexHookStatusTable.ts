/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { IParadisCodexHookTrustStatus } from '../common/paradisCodexHookTrust.js';

/** 状態の表の 1 行（場所・hooks.json・状態）。 */
export interface IParadisCodexHookStatusRow {
	readonly place: string;
	readonly path: string;
	readonly state: string;
}

/** 1 つのホームの状態の言葉（パスは表の別の列に出すので含めない）。 */
export function paradisCodexHookStateText(status: IParadisCodexHookTrustStatus): string {
	if (!status.supported) {
		// 生のエラーはログにだけ出す（利用者向けには、何をすればよいかだけを書く）
		return localize('paradis.codexHookStatus.stateUnknown', "信頼の状態を読めませんでした。hooks.json と config.toml の書き方を確かめるか、Codex の /hooks から信頼してください");
	}
	if (status.managedCount === 0) {
		return localize('paradis.codexHookStatus.stateNone', "Para Code の hook はありません");
	}
	if (status.pending.length === 0) {
		return localize('paradis.codexHookStatus.stateTrusted', "{0} 件すべて信頼済み", status.managedCount);
	}
	const events = [...new Set(status.pending.map(listing => listing.eventName).filter(name => name.length > 0))].join(', ');
	return localize('paradis.codexHookStatus.statePending', "{0} 件中 {1} 件が未信頼（{2}）", status.managedCount, status.pending.length, events);
}

/** 表の 1 つのセルに入れる文字（Markdown の表を壊す `|` と改行、強調などの記号を無効にする）。 */
function cell(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+!|<>]/g, match => `\\${match}`).replace(/\r?\n/g, ' ');
}

/** 場所 × hooks.json × 状態の Markdown の表。 */
export function paradisCodexHookStatusMarkdown(rows: readonly IParadisCodexHookStatusRow[]): string {
	const head = [
		localize('paradis.codexHookStatus.colPlace', "場所"),
		localize('paradis.codexHookStatus.colPath', "hooks.json"),
		localize('paradis.codexHookStatus.colState', "状態"),
	];
	return [
		`| ${head.map(cell).join(' | ')} |`,
		'| --- | --- | --- |',
		...rows.map(row => `| ${cell(row.place)} | ${cell(row.path)} | ${cell(row.state)} |`),
	].join('\n');
}
