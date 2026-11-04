// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { copyAction, type ContextMenuAction, type ContextMenuOps, type ContextMenuSpec } from '../../components/contextMenuModel.js';

/** メニューの見出しに出す引数の長さの上限（それより長い分は「コピー」で全文を写す）。 */
const MESSAGE_LIMIT = 600;

function clip(text: string): string {
	return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}…` : text;
}

/**
 * ツール実行の 1 行（ステップ）の長押しのメニュー（Q549 U8 案 A）。1 行で切れている引数の全文を見出しの下に出し、
 * 「引数をコピー」と（入力が引数の要約と違うときは）「入力の全文をコピー」を並べる。
 */
export function buildToolStepMenu(input: { readonly label: string; readonly arg?: string; readonly rawInput?: string }, ops: ContextMenuOps): ContextMenuSpec {
	const actions: ContextMenuAction[] = [];
	const arg = input.arg ?? '';
	if (arg.length > 0) {
		actions.push(copyAction(ops, { id: 'copy-arg', title: '引数をコピー', icon: 'copy', text: arg, toast: '引数をコピーしました' }));
	}
	const raw = input.rawInput?.trim() ?? '';
	if (raw.length > 0 && raw !== arg) {
		actions.push(copyAction(ops, { id: 'copy-input', title: '入力の全文をコピー', icon: 'code', text: raw, toast: '入力をコピーしました' }));
	}
	actions.push(copyAction(ops, { id: 'copy-name', title: 'ツール名をコピー', subtitle: input.label, icon: 'name', startsSection: actions.length > 0, text: input.label, toast: 'ツール名をコピーしました' }));
	return { title: input.label, ...(arg.length > 0 ? { message: clip(arg) } : {}), actions };
}

/** ツール実行のまとまり（「4× Read, Edit, Bash」）の長押しのメニュー。並びの全文と、1 行ずつの一覧のコピー。 */
export function buildToolRunMenu(input: { readonly steps: readonly { readonly label: string; readonly arg?: string }[] }, ops: ContextMenuOps): ContextMenuSpec {
	const names: string[] = [];
	for (const step of input.steps) {
		if (!names.includes(step.label)) {
			names.push(step.label);
		}
	}
	const list = input.steps.map(step => step.arg !== undefined && step.arg.length > 0 ? `${step.label} ${step.arg}` : step.label).join('\n');
	return {
		title: `${input.steps.length}× ${names.join(', ')}`,
		message: clip(list),
		actions: [copyAction(ops, { id: 'copy-list', title: '実行の一覧をコピー', icon: 'copy', text: list, toast: '実行の一覧をコピーしました' })],
	};
}
