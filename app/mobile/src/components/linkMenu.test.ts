// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { isFullTextCapped, PC_FULL_TEXT_LIMIT } from './agentIoClip.js';
import type { ContextMenuOps, ContextMenuSpec } from './contextMenuModel.js';
import { buildExternalLinkMenu, buildLocalFileLinkMenu } from './linkMenu.js';
import { markdownExternalLinks } from './markdownParse.js';
import { buildToolRunMenu, buildToolStepMenu } from '../features/session/toolRunMenu.js';

function ops(log: string[]): ContextMenuOps {
	return { canCopy: true, copy: (text, toast) => log.push(`${toast}: ${text}`), copyLater: () => undefined, share: () => undefined };
}

function rows(menu: ContextMenuSpec): unknown {
	return { title: menu.title, message: menu.message, actions: menu.actions.map(action => [action.id, action.subtitle]) };
}

describe('link and tool row menus (Q549)', () => {
	it('U4: opens, copies the path and the path with the line from a file link card', () => {
		const log: string[] = [];
		const menu = buildLocalFileLinkMenu({ path: 'src/app.ts', line: 42, column: 3 }, { ...ops(log), open: () => log.push('open') });
		expect(rows(menu)).toEqual({ title: 'src/app.ts', message: undefined, actions: [['open', undefined], ['copy-path', 'src/app.ts'], ['copy-location', 'src/app.ts:42:3']] });
		expect(rows(buildLocalFileLinkMenu({ path: 'README.md' }, { ...ops(log), open: () => undefined })).actions).toEqual([['open', undefined], ['copy-path', 'README.md']]);
		menu.actions[2]?.onSelect?.();
		expect(log).toEqual(['パスと行番号をコピーしました: src/app.ts:42:3']);
	});

	it('U9: offers open and copy for an external link, and collects each URL once', () => {
		expect(rows(buildExternalLinkMenu({ url: 'https://example.com/a' }, { ...ops([]), open: () => undefined })).actions).toEqual([['open', undefined], ['copy-url', 'https://example.com/a']]);
		expect(markdownExternalLinks('[a](https://example.com/a) と [b](https://example.com/b)\n\n> [a](https://example.com/a)\n\n| [c](https://example.com/c) |\n| --- |')).toEqual([
			{ label: 'a', url: 'https://example.com/a' },
			{ label: 'b', url: 'https://example.com/b' },
			{ label: 'c', url: 'https://example.com/c' },
		]);
	});

	it('U8: shows the full argument and copies it, the raw input and the tool list', () => {
		const step = buildToolStepMenu({ label: 'Bash', arg: 'npm test -- --grep login', rawInput: '{"command":"npm test -- --grep login"}' }, ops([]));
		expect(rows(step)).toEqual({ title: 'Bash', message: 'npm test -- --grep login', actions: [['copy-arg', undefined], ['copy-input', undefined], ['copy-name', 'Bash']] });
		expect(rows(buildToolRunMenu({ steps: [{ label: 'Read', arg: 'a.ts' }, { label: 'Read', arg: 'b.ts' }, { label: 'Edit' }] }, ops([])))).toEqual({
			title: '3× Read, Edit',
			message: 'Read a.ts\nRead b.ts\nEdit',
			actions: [['copy-list', undefined]],
		});
	});

	it('U10: treats a full text of exactly the PC limit as cut', () => {
		expect([isFullTextCapped('x'.repeat(PC_FULL_TEXT_LIMIT - 1)), isFullTextCapped('x'.repeat(PC_FULL_TEXT_LIMIT))]).toEqual([false, true]);
	});
});
