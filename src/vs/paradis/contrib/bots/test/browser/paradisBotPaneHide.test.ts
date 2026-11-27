/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditorCloseContext } from '../../../../../workbench/common/editor.js';
import { ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { PARADIS_BOT_GREETING_PROMPT, PARADIS_BOT_INBOX_WAKE_PROMPT, paradisBotFirstPrompt } from '../../common/paradisBotTools.js';
import { paradisBotPaneHidesOnClose, paradisIsBotPaneHidden, paradisMarkBotPaneHidden, paradisResetBotPaneHideForTest, paradisShowHiddenBotPane } from '../../browser/paradisBotPaneHide.js';
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

	test('閉じても止めずに隠すのは、利用者が閉じた Bot の会話のタブだけ（スペースの切り替え・置き換え・終了の途中・ほかのターミナルは触らない）', () => {
		paradisAddTerminalHiddenOnClose(5);
		const bot = { instanceId: 5, isDisposed: false };
		const base = { context: EditorCloseContext.UNKNOWN, shuttingDown: false, switching: false, instance: bot };
		assert.deepStrictEqual([
			paradisBotPaneHidesOnClose(base),
			paradisBotPaneHidesOnClose({ ...base, context: EditorCloseContext.MOVE }),
			paradisBotPaneHidesOnClose({ ...base, context: EditorCloseContext.REPLACE }),
			paradisBotPaneHidesOnClose({ ...base, shuttingDown: true }),
			paradisBotPaneHidesOnClose({ ...base, switching: true }),
			paradisBotPaneHidesOnClose({ ...base, instance: { instanceId: 6, isDisposed: false } }),
			paradisBotPaneHidesOnClose({ ...base, instance: { instanceId: 5, isDisposed: true } }),
		], [true, false, false, false, false, false, false]);
	});

	test('最初の指示: 作った直後は挨拶、伝言で起こしたら受け箱。眠った会話を続けるときは挨拶しない', () => {
		assert.deepStrictEqual([
			paradisBotFirstPrompt({ greet: true }, false),
			paradisBotFirstPrompt({ greet: true }, true),
			paradisBotFirstPrompt({ inbox: true }, true),
			paradisBotFirstPrompt({}, false),
		], [PARADIS_BOT_GREETING_PROMPT, undefined, PARADIS_BOT_INBOX_WAKE_PROMPT, undefined]);
	});
});
