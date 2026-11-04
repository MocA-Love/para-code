// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { copyAction, type ContextMenuOps, type ContextMenuSpec } from './contextMenuModel.js';
import type { LocalFileTarget } from '../localFileTarget.js';

/**
 * 会話の本文の中のリンクの長押しのメニュー（Q549）。
 *
 * - U4 ファイルのリンクのカード: 「ファイルを開く」「パスをコピー」「行番号つきでコピー」（行があるときだけ）。
 *   写すのはエージェントが書いたままのパス
 * - U9 外のリンク: 「開く」「URL をコピー」。押したときは今までどおりすぐ開く
 */
export function buildLocalFileLinkMenu(target: LocalFileTarget, ops: ContextMenuOps & { readonly open: () => void }): ContextMenuSpec {
	const location = target.line !== undefined ? `${target.path}:${target.line}${target.column !== undefined ? `:${target.column}` : ''}` : undefined;
	return {
		title: target.path,
		actions: [
			{ id: 'open', title: 'ファイルを開く', icon: 'open', onSelect: ops.open },
			copyAction(ops, { id: 'copy-path', title: 'パスをコピー', subtitle: target.path, icon: 'path', startsSection: true, text: target.path, toast: 'パスをコピーしました' }),
			...(location !== undefined ? [copyAction(ops, { id: 'copy-location', title: '行番号つきでコピー', subtitle: location, icon: 'line', text: location, toast: 'パスと行番号をコピーしました' })] : []),
		],
	};
}

export function buildExternalLinkMenu(link: { readonly url: string }, ops: ContextMenuOps & { readonly open: () => void }): ContextMenuSpec {
	return {
		title: link.url,
		actions: [
			{ id: 'open', title: '開く', icon: 'browser', onSelect: ops.open },
			copyAction(ops, { id: 'copy-url', title: 'URL をコピー', subtitle: link.url, icon: 'copy', text: link.url, toast: 'URL をコピーしました' }),
		],
	};
}
