/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisIsBotPaneHidden, paradisMarkBotPaneHidden, paradisResetBotPaneHideForTest, paradisShowHiddenBotPane } from '../../browser/paradisBotPaneHide.js';
import { paradisAddTerminalHiddenOnClose, paradisResetTerminalHiddenOnCloseForTest, paradisTerminalEditorsHideOnClose } from '../../../workspaceSwitch/browser/paradisTerminalHideOnClose.js';

suite('Paradis bot pane hide on close', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		paradisResetBotPaneHideForTest();
		paradisResetTerminalHiddenOnCloseForTest();
	});

	function fakeInstance(instanceId: number): ITerminalInstance & { disposed: Emitter<ITerminalInstance> } {
		const disposed = store.add(new Emitter<ITerminalInstance>());
		return { instanceId, isDisposed: false, onDisposed: disposed.event, disposed } as unknown as ITerminalInstance & { disposed: Emitter<ITerminalInstance> };
	}

	test('閉じるタブが全部 Bot の会話のペインなら確認を出さない。ほかのターミナルが混ざれば出す', () => {
		const bot = fakeInstance(1);
		const other = fakeInstance(2);
		paradisAddTerminalHiddenOnClose(1);
		assert.deepStrictEqual([
			paradisTerminalEditorsHideOnClose([{ terminalInstance: bot }]),
			paradisTerminalEditorsHideOnClose([{ terminalInstance: bot }, { terminalInstance: other }]),
			paradisTerminalEditorsHideOnClose([{ terminalInstance: other }]),
			paradisTerminalEditorsHideOnClose([{}]),
			paradisTerminalEditorsHideOnClose([]),
		], [true, false, false, false, false]);
	});

	test('裏に回したペインは開き直すとエディタへ戻し、終わったペインは控えから消える', async () => {
		const shown = fakeInstance(3);
		const ended = fakeInstance(4);
		paradisMarkBotPaneHidden(shown);
		paradisMarkBotPaneHidden(ended);
		ended.disposed.fire(ended);
		const backgrounds: number[] = [];
		const terminalService = { showBackgroundTerminal: async (instance: ITerminalInstance) => { backgrounds.push(instance.instanceId); } } as Pick<ITerminalService, 'showBackgroundTerminal'>;
		const first = await paradisShowHiddenBotPane(terminalService, shown);
		const second = await paradisShowHiddenBotPane(terminalService, shown);
		assert.deepStrictEqual({ first, second, backgrounds, endedHidden: paradisIsBotPaneHidden(4) }, { first: true, second: false, backgrounds: [3], endedHidden: false });
	});
});
