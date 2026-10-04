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

import { paradisReadPermissionWarning } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisAgentApprovalOptions.js';
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
	/** 選択肢の上に出ている警告の行（`agent.approval.detail.v1`。読めたときだけ）。 */
	readonly warning?: string;
}

/** `approval-options` の返事。 */
export interface ApprovalOptionsReply {
	readonly options: readonly ApprovalScreenOption[];
	readonly promptHash?: string;
	readonly warning?: string;
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

/**
 * 選択肢は使わず、選択肢の上の警告（`warning`）だけを PC に求める承認か。mod が「以後は確認しない」（`always`）まで値で
 * 答えられる承認は、PC が広告した選択肢のまま答えるが、警告は画面にしか無いので読みに行く（agent.approval.detail.v1）。
 */
export function shouldRequestApprovalWarningOnly(interaction: AgentInteraction | undefined): boolean {
	if (interaction?.kind !== 'approval' || interaction.id.startsWith('codex:') || interaction.id.startsWith('codex-status:')) {
		return false;
	}
	return !shouldRequestApprovalOptions(interaction) && (interaction.choices ?? []).some(choice => choice.id === 'always');
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
	const warning = paradisReadPermissionWarning(reply['warning']);
	return { options, ...(promptHash !== undefined ? { promptHash } : {}), ...(warning !== undefined ? { warning } : {}) };
}

/** 画面の文言の末尾の `(esc)` など、キーの近道の表記。 */
const TRAILING_SHORTCUT = /\s*\((?:esc|[a-z]|shift\+tab)\)\s*$/i;

/** ただの「No」（`2. No`）。今までの「拒否」と同じことをするので、ボタンは「拒否」1 つにまとめる。 */
const PLAIN_NO = /^no\.?$/i;
/** ただの「Yes」（`1. Yes`）。ボタンの文字は「許可」にする（送るときは画面の文言で確かめる）。 */
const PLAIN_YES = /^yes\.?$/i;

/**
 * 選択肢をカードのボタンにする。
 *
 * - 1 番は主ボタン（許可）。`opt:1` で送る（PC が文言を確かめてから `1` を送る）。ただの「Yes」は「許可」と書く
 * - 拒否は「拒否」（`no`。mod が待っていれば mod へ、いなければ Esc）1 つにまとめる。ただの「No」と、行末が `(esc)` の
 *   選択肢（「No, and tell Claude what to do differently」など）はこれに寄せる（決定 2。数字で選んだときの動きを確かめて
 *   いないため、実機で確かめてある経路に寄せる）。どちらも無ければ足す
 * - それ以外は `opt:<n>`。`No` で始まるもの（「No, keep planning」など）は拒否の見た目にする
 * - ボタンの文字からはキーの近道の表記を外す（押すのはボタンなので）
 */
export function approvalChoicesFromOptions(options: readonly ApprovalScreenOption[], promptHash?: string, warning?: string): ApprovalOptionChoices {
	const choices: AgentApprovalChoice[] = [];
	const labels = new Map<string, string>();
	for (const option of options) {
		const display = option.label.replace(TRAILING_SHORTCUT, '').trim() || option.label;
		if (/\(esc\)\s*$/i.test(option.label) || (option.n > 1 && PLAIN_NO.test(display))) {
			continue;
		}
		const id = `opt:${option.n}`;
		const tone: AgentApprovalChoice['tone'] = option.n === 1 ? 'approve' : /^no\b/i.test(display) ? 'deny' : 'neutral';
		choices.push({ id, label: option.n === 1 && PLAIN_YES.test(display) ? '許可' : display, tone });
		labels.set(id, option.label);
	}
	// 拒否（Esc）は常に出す。行末の `(esc)` が折り返しなどで読めなかったときも、拒否できないカードにしない（シミュレータ確認の気づき (a)）。
	choices.push({ id: 'no', label: '拒否', tone: 'deny' });
	return { choices, labels, ...(promptHash !== undefined ? { promptHash } : {}), ...(warning !== undefined ? { warning } : {}) };
}
