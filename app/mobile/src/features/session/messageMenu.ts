// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { copyAction, type ContextMenuAction, type ContextMenuOps, type ContextMenuSpec } from '../../components/contextMenuModel.js';
import { markdownCopyParts, markdownExternalLinks, markdownPlainText } from '../../components/markdownParse.js';

/**
 * 会話の発言の長押しのメニュー（Q548 案 A。資料 3 章）。
 *
 * - エージェントの発言: 「テキストをコピー」（記号を外した文字）・「Markdown のままコピー」・「段落を選んでコピー」・
 *   「コードを選んでコピー」・「URL を（選んで）コピー」（本文にリンクがあるとき）・「範囲を選んでコピー…」（選択して読む）・「共有…」
 * - 自分の発言: 「テキストをコピー」・「範囲を選んでコピー…」・「共有…」（本文はそのまま写す）
 *
 * 「引用して返信」は入れていない（入力欄が書きかけを読み直す口を持たないため。PR 本文の残課題）。
 */
export function buildMessageMenu(input: { readonly text: string; readonly markdown: boolean }, ops: ContextMenuOps & { selectRange(): void }): ContextMenuSpec {
	const actions: ContextMenuAction[] = [];
	if (!input.markdown) {
		actions.push(copyAction(ops, { id: 'copy', title: 'テキストをコピー', icon: 'copy', text: input.text, toast: 'テキストをコピーしました' }));
	} else {
		const plain = markdownPlainText(input.text);
		actions.push(copyAction(ops, { id: 'copy', title: 'テキストをコピー', icon: 'copy', text: plain, toast: 'テキストをコピーしました' }));
		if (plain !== input.text.trim()) {
			actions.push(copyAction(ops, { id: 'copy-markdown', title: 'Markdown のままコピー', subtitle: '記号（**、`、-）を残します', icon: 'markdown', text: input.text, toast: 'Markdown をコピーしました' }));
		}
		const { paragraphs, codes } = markdownCopyParts(input.text);
		if (paragraphs.length > 1) {
			actions.push({
				id: 'paragraphs',
				title: '段落を選んでコピー',
				icon: 'paragraph',
				children: paragraphs.map((part, index) => copyAction(ops, { id: `paragraph:${index}`, title: part.label, text: part.text, toast: '段落をコピーしました' })),
			});
		}
		if (codes.length === 1 && codes[0] !== undefined) {
			actions.push(copyAction(ops, { id: 'code:0', title: 'コードをコピー', subtitle: codes[0].label, icon: 'code', text: codes[0].text, toast: 'コードをコピーしました' }));
		} else if (codes.length > 1) {
			actions.push({
				id: 'codes',
				title: 'コードを選んでコピー',
				icon: 'code',
				children: codes.map((part, index) => copyAction(ops, { id: `code:${index}`, title: part.label, text: part.text, toast: 'コードをコピーしました' })),
			});
		}
		// 本文のリンクの URL（Q549 U9。ネイティブのメニューでは発言の長押しがリンクの長押しより先に取るので、ここに並べる）
		const links = markdownExternalLinks(input.text);
		if (links.length === 1 && links[0] !== undefined) {
			actions.push(copyAction(ops, { id: 'link:0', title: 'URL をコピー', subtitle: links[0].url, icon: 'browser', text: links[0].url, toast: 'URL をコピーしました' }));
		} else if (links.length > 1) {
			actions.push({
				id: 'links',
				title: 'URL を選んでコピー',
				icon: 'browser',
				children: links.map((link, index) => copyAction(ops, { id: `link:${index}`, title: link.label === link.url ? link.url : link.label, subtitle: link.url, text: link.url, toast: 'URL をコピーしました' })),
			});
		}
	}
	actions.push({ id: 'select', title: '範囲を選んでコピー…', icon: 'select', startsSection: true, onSelect: ops.selectRange });
	actions.push({ id: 'share', title: '共有…', icon: 'share', onSelect: () => ops.share(input.markdown ? markdownPlainText(input.text) : input.text) });
	return { actions };
}
