/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisCodexFrontSessions } from '../../common/paradisCodexFrontSession.js';

suite('ParadisCodexFrontSessions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 控えの流し直しの許可要求は、画面で確かめていないので裏の承認待ちにしない。Codex の終わりでは承認待ちだけを消し、
	// 表の会話は残す。
	test('does not record a replayed background approval, and clears waits but keeps the conversation on screen when Codex ends', () => {
		const sessions = new ParadisCodexFrontSessions();
		const results = [
			sessions.classify('pane', 'UserPromptSubmit', 'front', undefined, 1),
			sessions.classify('pane', 'PermissionRequest', 'behind', undefined, 2, { recordWait: false }),
		];
		const afterReplay = sessions.backgroundWaits();
		results.push(sessions.classify('pane', 'PermissionRequest', 'behind', undefined, 3));
		const afterLive = sessions.backgroundWaits();
		const cleared = [sessions.clearBackgroundWaits('pane'), sessions.clearBackgroundWaits('pane')];
		results.push(sessions.classify('pane', 'Stop', 'front', undefined, 4));
		assert.deepStrictEqual({ results, afterReplay, afterLive, cleared, afterEnd: sessions.backgroundWaits() }, {
			results: ['front', 'background', 'background', 'front'],
			afterReplay: [],
			afterLive: [{ token: 'pane', since: 3 }],
			cleared: [true, false],
			afterEnd: [],
		});
	});

	// 台帳に無いペインでは、控えていた会話を表にする（無ければ最初に届いた hook の会話）。
	test('takes the known conversation of an unknown pane as the one on screen', () => {
		const sessions = new ParadisCodexFrontSessions();
		assert.deepStrictEqual([
			sessions.classify('known', 'Stop', 'behind', undefined, 1, { knownFront: 'front' }),
			sessions.classify('known', 'Stop', 'front', undefined, 2),
			sessions.classify('fresh', 'Stop', 'first', undefined, 3),
			sessions.classify('fresh', 'Stop', 'second', undefined, 4),
			sessions.classify('restarted', 'SessionStart', 'new', 'startup', 5, { knownFront: 'old' }),
		], ['background', 'front', 'front', 'background', 'front']);
	});
});
