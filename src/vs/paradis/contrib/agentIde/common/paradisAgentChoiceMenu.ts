/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex が入力欄の代わりに出す選択画面（Plan モードの「Implement this plan?」、起動時の更新の案内、
// モデルの切り替えの案内、hooks の確認）を画面から読む。
//
// これらの画面はキー入力を握り、Enter で既定の選択肢（実装に進む・今すぐ更新する・新しいモデルを使う）を
// 選ぶ。Plan メニューは Stop hook の後に出るので hook の状態は「終わった」のまま、更新の案内は hook が
// 届く前に出る。状態だけを見ていると、別のエージェントが送った Enter で既定が選ばれる。
//
// 見分け方は Orca（stablyai/orca、MIT License、Copyright (c) 2026 Lovecast Inc.）の
// src/main/runtime/agent-state-rules/codex.json の plan_implement_menu と
// src/main/runtime/startup-dialog-blocked-signals.ts を参考にした（キーの案内の行が画面の最後の行に
// あることを条件にする。答えた後に残った文言では当てない）。文言は codex-cli 0.158.0 / 0.160.0 の
// 実画面と 0.160.0 のバイナリの文字列で確かめ、0.161.0 のキーの案内の表記の変更はソースとスナップショットで確かめた。外れたときはこれまでどおり hook の状態だけで判断する。

/** 選択画面の種類。 */
export type ParadisAgentChoiceMenuKind =
	/** Plan モードのターンの後の「Implement this plan?」（Enter で実装に進む）。 */
	| 'plan_implement'
	/** 起動時の更新の案内（Enter で今すぐ更新する。Codex は更新して終わる）。 */
	| 'update'
	/** 新しいモデルの案内・使えなくなったモデルの知らせ（Enter でモデルを切り替える）。 */
	| 'model_switch'
	/** 信頼していない hooks の確認（Enter で確認の画面へ進む）。 */
	| 'hooks_review';

/** 画面から読んだ選択画面。 */
export interface IParadisAgentChoiceMenu {
	readonly kind: ParadisAgentChoiceMenuKind;
	/** 見出しの行（無い画面もある）。 */
	readonly title?: string;
	/** 選択肢の文言（番号を落とし、説明の列は「 - 」でつなぐ）。選択肢の無い知らせでは空。 */
	readonly options: readonly string[];
	/** カーソルのある選択肢の番号（0 始まり）。 */
	readonly selected?: number;
	/** Enter を押すと何が起きるか（エージェントへ返す説明）。 */
	readonly enterWould: string;
}

/**
 * キーの案内の Ctrl の表記（空白を落とした形の正規表現の断片）。codex-cli 0.160.0 までは「ctrl+」、
 * 0.161.0 からは macOS が「⌃」、Linux が「^」、Windows が「ctrl+」（codex-rs/tui/src/key_hint.rs の MODIFIER_LABELS）。
 */
const CTRL_LABEL = '(?:ctrl\\+|\u2303|\\^)';

interface IChoiceMenuRule {
	readonly kind: ParadisAgentChoiceMenuKind;
	/** 文言を確かめた CLI の版（表を見直すときの目安）。 */
	readonly observedIn: string;
	/** 画面の最後の行（空白を落とした形）。 */
	readonly keyRow: RegExp;
	/** キーの案内の行より上で探す見出し（空白を落とした形）。無ければ見出しを要らない。 */
	readonly title?: RegExp;
	readonly enterWould: string;
}

const RULES: readonly IChoiceMenuRule[] = [
	{
		// 「Implement this plan?」/「› 1. Yes, implement this plan  Switch to Default and start coding」/
		// 「2. Yes, clear context and implement」/「3. No, stay in Plan mode」/「enter select · esc back」
		kind: 'plan_implement',
		observedIn: 'codex-cli 0.160.0',
		keyRow: /^enterselect\u00b7escback$/i,
		title: /^Implementthisplan\?$/i,
		enterWould: 'Enter would pick the highlighted choice, by default "Yes, implement this plan", and Codex would leave Plan mode and start changing files',
	},
	{
		// 「Update available · 0.158.0 → 0.159.0」/「› 1. Update now (runs `npm install -g @openai/codex`)」/
		// 「2. Skip」/「3. Skip until next version」/「enter continue · esc skip」。以前の版は「Press enter to continue」
		kind: 'update',
		observedIn: 'codex-cli 0.158.0 / 0.160.0',
		keyRow: /^(?:entercontinue\u00b7escskip|Pressentertocontinue)$/i,
		title: /^Updateavailable[\u00b7!]/i,
		enterWould: 'Enter would pick the highlighted choice, by default "Update now", which installs a new Codex version and exits',
	},
	{
		// 新しいモデルの案内「Meet GPT-6 Sol」/「› 1. Try new model」/「2. Use existing model」/
		// 「enter/esc confirm · ctrl+c quit」。使えなくなったモデルの知らせは選択肢が無く「enter/esc continue · ctrl+c quit」。
		// 0.161.0 から Ctrl の表記が OS ごとに変わった（macOS は「⌃c」、Linux は「^c」、Windows は「ctrl+c」のまま）
		kind: 'model_switch',
		observedIn: 'codex-cli 0.158.0 / 0.160.0 / 0.161.0',
		keyRow: new RegExp(`^enter/esc(?:confirm|continue)\u00b7${CTRL_LABEL}cquit$`, 'i'),
		enterWould: 'Enter would confirm the highlighted choice and switch the model Codex uses',
	},
	{
		// 「Hooks need review」/「› 1. Review hooks」/「2. Trust all and continue」/
		// 「3. Continue without trusting (hooks won't run)」/「enter confirm · esc skip」
		kind: 'hooks_review',
		observedIn: 'codex-cli 0.158.0 / 0.160.0',
		keyRow: /^enterconfirm\u00b7escskip$/i,
		title: /^Hooksneedreview$/i,
		enterWould: 'Enter would pick the highlighted choice about trusting the hooks Codex found',
	},
];

/** 見出しを探す、キーの案内の行より上の行数。 */
const MENU_SEARCH_LINES = 20;

/** 選択肢の行（行頭のカーソル、番号、文言）。 */
const OPTION_LINE = /^(?<cursor>[\u203a\u276f>]\s*)?(?<number>\d+)\.\s+(?<label>\S.*)$/;

function compact(text: string): string {
	return text.replace(/[\s\u2500-\u257f]+/g, '');
}

function trimLine(line: string): string {
	return line.replace(/^[\s\u2500-\u257f]+|[\s\u2500-\u257f]+$/g, '');
}

/**
 * 画面の最後の行がキーの案内で、その上に見出しがあれば、選択画面として返す。分からなければ undefined。
 *
 * 画面の文字はターミナルの中のプログラムが書けるので、「止めて人に任せる」側にだけ使う
 * （当たったら送らない。送ってよい根拠にはしない）。
 */
export function paradisAgentChoiceMenu(screen: string | undefined): IParadisAgentChoiceMenu | undefined {
	if (screen === undefined || screen.length === 0) {
		return undefined;
	}
	const lines = screen.split('\n').map(trimLine).filter(line => line.length > 0);
	if (lines.length === 0) {
		return undefined;
	}
	const keyRow = compact(lines[lines.length - 1]);
	const above = lines.slice(Math.max(0, lines.length - 1 - MENU_SEARCH_LINES), lines.length - 1);
	for (const rule of RULES) {
		if (!rule.keyRow.test(keyRow)) {
			continue;
		}
		let start = 0;
		let title: string | undefined;
		if (rule.title) {
			const titleIndex = findLastIndex(above, line => rule.title!.test(compact(line)));
			if (titleIndex < 0) {
				continue;
			}
			title = above[titleIndex];
			start = titleIndex + 1;
		}
		// 見出しの無い画面（モデルの案内）では、本文に番号付きの行がありうるので、キーの案内の行のすぐ上に
		// 続く選択肢だけを取る
		const optionLines = rule.title ? above.slice(start) : trailingOptionLines(above);
		const options: string[] = [];
		let selected: number | undefined;
		for (const line of optionLines) {
			const match = OPTION_LINE.exec(line);
			if (!match?.groups) {
				continue;
			}
			if (match.groups.cursor !== undefined) {
				selected = options.length;
			}
			options.push(match.groups.label.split(/\s{2,}/).join(' - '));
		}
		return {
			kind: rule.kind,
			...(title !== undefined ? { title } : {}),
			options,
			...(selected !== undefined ? { selected } : {}),
			enterWould: rule.enterWould,
		};
	}
	return undefined;
}

/** 末尾から続く選択肢の行。 */
function trailingOptionLines(lines: readonly string[]): readonly string[] {
	let start = lines.length;
	while (start > 0 && OPTION_LINE.test(lines[start - 1])) {
		start--;
	}
	return lines.slice(start);
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
	for (let index = items.length - 1; index >= 0; index--) {
		if (predicate(items[index])) {
			return index;
		}
	}
	return -1;
}

/** 選択画面で止まっているときに、エージェントへ返す説明。 */
export function paradisAgentChoiceMenuMessage(menu: IParadisAgentChoiceMenu): string {
	const name = menu.title !== undefined ? `"${menu.title}"` : `its ${menu.kind.replace('_', ' ')}`;
	return `Codex in that terminal is waiting for a person to choose in ${name} menu (${menu.kind}). ${menu.enterWould}. Para Code does not send keys or text there: ask the user to choose, and wait until the menu is gone.`;
}
