/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisReviewNotesTargetVerdict } from '../../../mobileRelay/electron-browser/paradisMobileAgentPromptDelivery.js';
import { paradisIsRemoteTerminalViewing, paradisLastRemoteTerminalViewAt, paradisNoteRemoteTerminalViewing, paradisForgetRemoteTerminalViewing, paradisSetHibernationWakeHandler } from '../../browser/paradisAgentHibernationRemoteViews.js';

suite('paradisAgentHibernation (mobile)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// 休止中のタブは素のシェル。スマホからの依頼文は、前面のコマンドがエージェントと確かめられないので断られる
	test('a hibernated pane is a plain shell, so a request from the phone is refused instead of typed into the shell', () => {
		assert.strictEqual(paradisReviewNotesTargetVerdict({ isAgent: true, status: undefined, parked: false, canPasteMultiline: false, screenShowsPrompt: false }), 'not-running');
	});

	test('opening a terminal on the phone wakes it and keeps it from hibernating until the phone leaves', () => {
		const woken: number[] = [];
		store.add(paradisSetHibernationWakeHandler(instanceId => woken.push(instanceId)));
		paradisNoteRemoteTerminalViewing(7, true);
		const whileViewing = { viewing: paradisIsRemoteTerminalViewing(7), seen: paradisLastRemoteTerminalViewAt(7) !== undefined };
		paradisNoteRemoteTerminalViewing(7, false);
		const afterLeaving = { viewing: paradisIsRemoteTerminalViewing(7), seen: paradisLastRemoteTerminalViewAt(7) !== undefined };
		paradisForgetRemoteTerminalViewing(7);
		assert.deepStrictEqual({ woken, whileViewing, afterLeaving, forgotten: paradisLastRemoteTerminalViewAt(7) }, {
			woken: [7],
			whileViewing: { viewing: true, seen: true },
			afterLeaving: { viewing: false, seen: true },
			forgotten: undefined,
		});
	});
});
