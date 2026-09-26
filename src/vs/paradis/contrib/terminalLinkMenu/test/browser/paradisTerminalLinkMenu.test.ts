/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { paradisHttpUrlFromTerminalLinkText, ParadisTerminalLinkCommandId } from '../../browser/paradisTerminalLinkMenu.contribution.js';

function context(values: Record<string, unknown>): IContext {
	return { getValue: <T>(key: string) => values[key] as T };
}

suite('ParadisTerminalLinkMenu', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only treats http(s) links as URLs', () => {
		assert.deepStrictEqual([
			'https://github.com/example/app/pull/128/files?diff=split&w=1',
			' http://localhost:5173/ ',
			'HTTPS://EXAMPLE.COM',
			'file:///Users/example/app/src/index.ts',
			'/Users/example/app/src/index.ts:12',
			'http://',
			'localhost:5173',
			'',
			undefined,
		].map(paradisHttpUrlFromTerminalLinkText), [
			'https://github.com/example/app/pull/128/files?diff=split&w=1',
			'http://localhost:5173/',
			'HTTPS://EXAMPLE.COM',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('adds copy / open-in-browser to the top of the terminal context menu only over a URL', () => {
		const items = MenuRegistry.getMenuItems(MenuId.TerminalInstanceContext)
			.filter(isIMenuItem)
			.filter(item => item.command.id === ParadisTerminalLinkCommandId.CopyLink || item.command.id === ParadisTerminalLinkCommandId.OpenLinkInIntegratedBrowser);
		const visible = (values: Record<string, unknown>) => items
			.filter(item => item.when?.evaluate(context(values)) ?? true)
			.map(item => item.command.id);

		assert.deepStrictEqual({
			groups: [...new Set(items.map(item => item.group))],
			overUrl: visible({ paradisTerminalUrlLinkAtMouse: true }),
			elsewhere: visible({}),
		}, {
			groups: ['0_0_paradisLink'],
			overUrl: [ParadisTerminalLinkCommandId.CopyLink, ParadisTerminalLinkCommandId.OpenLinkInIntegratedBrowser],
			elsewhere: [],
		});
	});
});
