// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { findContextMenuAction, type ContextMenuSpec } from '../../components/contextMenuModel.js';
import { buildMessageMenu } from './messageMenu.js';

function tree(menu: ContextMenuSpec): unknown {
	return menu.actions.map(action => action.children !== undefined ? { [action.title]: action.children.map(child => child.title) } : action.title);
}

describe('buildMessageMenu', () => {
	it('lists text, markdown, paragraph and code copies, then range select and share for an agent reply', () => {
		const log: string[] = [];
		let selected = 0;
		const menu = buildMessageMenu(
			{ text: '直しました。\n\n- **一つ目**\n- 二つ目\n\n```ts\nconst a = 1;\n```\n\n```bash\nnpm test\n```', markdown: true },
			{ canCopy: true, copyLater: () => undefined, copy: (text, toast) => log.push(`${toast}: ${text}`), share: text => log.push(`share: ${text}`), selectRange: () => { selected++; } },
		);
		expect(tree(menu)).toEqual([
			'テキストをコピー',
			'Markdown のままコピー',
			{ '段落を選んでコピー': ['直しました。', '• 一つ目', '• 二つ目'] },
			{ 'コードを選んでコピー': ['ts · const a = 1;', 'bash · npm test'] },
			'範囲を選んでコピー…',
			'共有…',
		]);
		findContextMenuAction(menu.actions, 'copy')?.onSelect?.();
		findContextMenuAction(menu.actions, 'code:1')?.onSelect?.();
		findContextMenuAction(menu.actions, 'select')?.onSelect?.();
		expect({ log, selected }).toEqual({
			log: ['テキストをコピーしました: 直しました。\n\n• 一つ目\n• 二つ目\n\nconst a = 1;\n\nnpm test', 'コードをコピーしました: npm test'],
			selected: 1,
		});
	});

	it('keeps a plain reply short: no markdown copy when nothing would change, one code item for one block', () => {
		const ops = { canCopy: true, copyLater: () => undefined, copy: () => undefined, share: () => undefined, selectRange: () => undefined };
		expect(tree(buildMessageMenu({ text: '了解です', markdown: true }, ops))).toEqual(['テキストをコピー', '範囲を選んでコピー…', '共有…']);
		expect(tree(buildMessageMenu({ text: '見て\n\n```\nls\n```', markdown: true }, ops))).toEqual(['テキストをコピー', 'Markdown のままコピー', 'コードをコピー', '範囲を選んでコピー…', '共有…']);
	});

	it('copies the user message as typed', () => {
		const log: string[] = [];
		const menu = buildMessageMenu({ text: '**そのまま**', markdown: false }, { canCopy: true, copyLater: () => undefined, copy: text => log.push(text), share: () => undefined, selectRange: () => undefined });
		expect(tree(menu)).toEqual(['テキストをコピー', '範囲を選んでコピー…', '共有…']);
		menu.actions[0]?.onSelect?.();
		expect(log).toEqual(['**そのまま**']);
	});

	it('lists the link URLs so they can be copied even though the message menu takes the long press', () => {
		const ops = { canCopy: true, copyLater: () => undefined, copy: () => undefined, share: () => undefined, selectRange: () => undefined };
		expect(tree(buildMessageMenu({ text: '[資料](https://example.com/a) を見て', markdown: true }, ops))).toEqual(['テキストをコピー', 'Markdown のままコピー', 'URL をコピー', '範囲を選んでコピー…', '共有…']);
		expect(tree(buildMessageMenu({ text: '[a](https://example.com/a)\n\n[b](https://example.com/b)', markdown: true }, ops))).toEqual(['テキストをコピー', 'Markdown のままコピー', { '段落を選んでコピー': ['a (https://example.com/a)', 'b (https://example.com/b)'] }, { 'URL を選んでコピー': ['a', 'b'] }, '範囲を選んでコピー…', '共有…']);
	});

	it('lists a bare URL in the message the same way as a Markdown link', () => {
		const ops = { canCopy: true, copyLater: () => undefined, copy: () => undefined, share: () => undefined, selectRange: () => undefined };
		const menu = buildMessageMenu({ text: '詳しくは https://example.com/docs を見て', markdown: true }, ops);
		expect([tree(menu), findContextMenuAction(menu.actions, 'link:0')?.subtitle]).toEqual([['テキストをコピー', 'URL をコピー', '範囲を選んでコピー…', '共有…'], 'https://example.com/docs']);
	});
});
