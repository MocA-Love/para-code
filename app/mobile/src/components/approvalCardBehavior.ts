// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { AgentApprovalChoice } from '../store.js';
import type { ButtonVariant } from './button.js';

/** 並べる1つのボタン（選択肢と見た目の種類）。 */
export interface ApprovalButtonSpec {
	readonly choice: AgentApprovalChoice;
	readonly variant: ButtonVariant;
}

/**
 * 承認カードのボタンの並びと見た目。iOS の確認ダイアログと同じく、進める操作（許可）を右端に置き、
 * 並びは [拒否] [その他の選択肢] [許可] に揃える。
 *
 * 主ボタン（primary）は1画面に1つなので、許可の系統が複数ある（「許可」「このセッション中は許可」など）
 * ときは最初の1つだけを primary にし、残りは secondary として「その他」の列に入れる。
 * 同じ種類の中では PC が広告した順を保つ。
 */
export function orderApprovalChoices(choices: readonly AgentApprovalChoice[]): ApprovalButtonSpec[] {
	const primary = choices.find(choice => choice.tone === 'approve');
	const deny = choices.filter(choice => choice.tone === 'deny').map(choice => ({ choice, variant: 'destructive' as const }));
	const others = choices
		.filter(choice => choice.tone !== 'deny' && choice !== primary)
		.map(choice => ({ choice, variant: 'secondary' as const }));
	return [...deny, ...others, ...(primary !== undefined ? [{ choice: primary, variant: 'primary' as const }] : [])];
}

/** 1行に横並びで収める選択肢の数と、1つあたりの文字数の上限。超えたら縦に積む。 */
const ROW_MAX_CHOICES = 3;
const ROW_MAX_LABEL_LENGTH = 8;

/**
 * 横並びか縦積みか。Codex は「今後このコマンドは確認しない」のような長い選択肢を広告するので、
 * 横に詰めると1行に収まらず語が切れる。長いもの・多いものがあれば縦に積む。
 */
export function approvalButtonLayout(choices: readonly AgentApprovalChoice[]): 'row' | 'column' {
	return choices.length > ROW_MAX_CHOICES || choices.some(choice => choice.label.length > ROW_MAX_LABEL_LENGTH) ? 'column' : 'row';
}

/** カードに出す詳細の行数（これを超えるなら「全文を表示」でシートに開く）。 */
export const APPROVAL_DETAIL_LINES = 6;
/** 1行の目安の文字数。折り返しで行数が増えるぶんを見込む。 */
const APPROVAL_DETAIL_CHARS_PER_LINE = 48;

/** 詳細がカードの表示行数に収まらない見込みか。 */
export function isLongApprovalDetail(detail: string | undefined): boolean {
	if (detail === undefined || detail.length === 0) {
		return false;
	}
	let lines = 0;
	for (const line of detail.split('\n')) {
		lines += Math.max(1, Math.ceil(line.length / APPROVAL_DETAIL_CHARS_PER_LINE));
		if (lines > APPROVAL_DETAIL_LINES) {
			return true;
		}
	}
	return false;
}
