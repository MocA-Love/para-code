// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 承認カードに PC の画面と同じ番号付きの選択肢を並べる（Orca W2-21）。
 *
 * PC（`agent.approval.options.v1` を広告する版）に `approval-options` を求めると、PC はそのターミナルの見えている画面から
 * 番号付きの選択肢を読んで返す。カードはそれを選択肢のボタンにし、押したら `opt:<n>` と押したときの文言を送る。
 * PC は送る直前に画面を読み直し、その番号が同じ文言のままのときだけ数字 1 文字を送る（Enter は付けない）。
 *
 * 読めないとき・古い PC・Codex の app-server 経由の承認（最初から選択肢が付いてくる）は、今までどおり
 * 「許可 / 拒否」か PC が広告した選択肢のまま。副作用の無い関数だけを置く。
 */

import type { AgentApprovalChoice, AgentInteraction } from './store.js';

/** PC の画面から読んだ選択肢 1 つ。 */
export interface ApprovalScreenOption {
	readonly n: number;
	readonly label: string;
}

/** カードに並べる選択肢と、`opt:<n>` の選択肢 ID → 押したときに添える文言。 */
export interface ApprovalOptionChoices {
	readonly choices: readonly AgentApprovalChoice[];
	readonly labels: ReadonlyMap<string, string>;
	/** PC が選択肢を読んだときの、確認の見出しまでの指紋。回答に添えて返す（PC が送る直前に照らし合わせる）。 */
	readonly promptHash?: string;
}

/** `approval-options` の返事。 */
export interface ApprovalOptionsReply {
	readonly options: readonly ApprovalScreenOption[];
	readonly promptHash?: string;
}

/**
 * 画面の選択肢を求めてよい承認か。hook から作った承認（選択肢が「許可 / 拒否」の2つだけ）に限る。
 * Codex の app-server 経由の承認は PC が構造化した選択肢を最初から付けてくる。
 */
export function shouldRequestApprovalOptions(interaction: AgentInteraction | undefined): boolean {
	if (interaction?.kind !== 'approval' || interaction.id.startsWith('codex:') || interaction.id.startsWith('codex-status:')) {
		return false;
	}
	const ids = (interaction.choices ?? []).map(choice => choice.id).sort();
	return interaction.choices === undefined || (ids.length === 2 && ids[0] === 'no' && ids[1] === 'yes');
}

/** PC の `approval-options` の返事から選択肢を取り出す。2 つ以上の正しい選択肢が無ければ undefined（読めなかった）。 */
export function parseApprovalOptionsReply(reply: Record<string, unknown>): ApprovalOptionsReply | undefined {
	const raw = reply['options'];
	if (!Array.isArray(raw) || raw.length < 2 || raw.length > 9) {
		return undefined;
	}
	const options: ApprovalScreenOption[] = [];
	for (const [index, candidate] of raw.entries()) {
		if (candidate === null || typeof candidate !== 'object') {
			return undefined;
		}
		const { n, label } = candidate as { readonly n?: unknown; readonly label?: unknown };
		if (n !== index + 1 || typeof label !== 'string' || label.length === 0 || label.length > 300) {
			return undefined;
		}
		options.push({ n, label });
	}
	const promptHash = typeof reply['promptHash'] === 'string' && /^[0-9a-f]{40}$/.test(reply['promptHash']) ? reply['promptHash'] : undefined;
	return { options, ...(promptHash !== undefined ? { promptHash } : {}) };
}

/** 画面の文言の末尾の `(esc)` など、キーの近道の表記。 */
const TRAILING_SHORTCUT = /\s*\((?:esc|[a-z]|shift\+tab)\)\s*$/i;

/**
 * 選択肢をカードのボタンにする。
 *
 * - 1 番は主ボタン（許可）。`opt:1` で送る（PC が文言を確かめてから `1` を送る）
 * - 行末が `(esc)` の選択肢（「No, and tell Claude what to do differently」など）は、今までの「拒否」と同じ
 *   `no`（Esc）で送る。数字で選んだときの動きを確かめていないため、実機で確かめてある経路に寄せる
 * - それ以外は `opt:<n>`。`No` で始まるものは拒否の見た目にする
 * - ボタンの文字からはキーの近道の表記を外す（押すのはボタンなので）
 */
export function approvalChoicesFromOptions(options: readonly ApprovalScreenOption[], promptHash?: string): ApprovalOptionChoices {
	const choices: AgentApprovalChoice[] = [];
	const labels = new Map<string, string>();
	for (const option of options) {
		const display = option.label.replace(TRAILING_SHORTCUT, '').trim() || option.label;
		if (/\(esc\)\s*$/i.test(option.label)) {
			if (!choices.some(choice => choice.id === 'no')) {
				choices.push({ id: 'no', label: display, tone: 'deny' });
			}
			continue;
		}
		const id = `opt:${option.n}`;
		const tone: AgentApprovalChoice['tone'] = option.n === 1 ? 'approve' : /^no\b/i.test(display) ? 'deny' : 'neutral';
		choices.push({ id, label: display, tone });
		labels.set(id, option.label);
	}
	return { choices, labels, ...(promptHash !== undefined ? { promptHash } : {}) };
}

/** hook の「今後は確認しない」の候補を、カードの補足の 1 行にする。 */
export function approvalSuggestionNote(suggestions: readonly string[] | undefined): string | undefined {
	return suggestions !== undefined && suggestions.length > 0 ? `今後確認しない候補: ${suggestions.join('、')}` : undefined;
}
