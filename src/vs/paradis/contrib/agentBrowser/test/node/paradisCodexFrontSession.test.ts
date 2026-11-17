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

	// 台帳に無いペインでは、表を決める hook が来るまで表を固定せず、それまでは表として通す。
	test('does not fix the conversation on screen of an unknown pane until a hook that sets it', () => {
		const sessions = new ParadisCodexFrontSessions();
		assert.deepStrictEqual([
			sessions.classify('fresh', 'Stop', 'first', undefined, 3),
			sessions.classify('fresh', 'Stop', 'second', undefined, 4),
			sessions.classify('fresh', 'UserPromptSubmit', 'second', undefined, 5),
			sessions.classify('fresh', 'Stop', 'first', undefined, 6),
			sessions.classify('compacting', 'SessionStart', 'behind', 'compact', 7),
			sessions.classify('compacting', 'Stop', 'other', undefined, 8),
		], ['front', 'front', 'front', 'background', 'front', 'front']);
	});

	// Codex 0.171（alpha）のサイドチャットは、送っても表の会話を移さない（0.171.0-alpha.10 のソースの形。hook の印は呼び出し側が
	// transcript_path と session_meta の attached_thread から決める）。サイドチャットの承認待ちは裏の待ちとして覚える。
	test('keeps the main conversation on screen when a Codex side chat sends, also for a pane it does not know yet', () => {
		const sessions = new ParadisCodexFrontSessions();
		const results = [
			sessions.classify('pane', 'UserPromptSubmit', 'main', undefined, 1),
			sessions.classify('pane', 'SessionStart', 'side', 'fork', 2, { sideChat: true }),
			sessions.classify('pane', 'UserPromptSubmit', 'side', undefined, 3, { sideChat: true }),
			sessions.classify('pane', 'PermissionRequest', 'side', undefined, 4, { sideChat: true }),
			sessions.classify('pane', 'Stop', 'main', undefined, 5),
			sessions.classify('restarted', 'UserPromptSubmit', 'side', undefined, 6, { sideChat: true }),
			sessions.classify('restarted', 'Stop', 'main', undefined, 7),
		];
		assert.deepStrictEqual({ results, front: [sessions.front('pane'), sessions.front('restarted')], waits: sessions.backgroundWaits() }, {
			results: ['front', 'background', 'background', 'background', 'front', 'background', 'front'],
			front: ['main', undefined],
			waits: [{ token: 'pane', since: 4 }],
		});
	});
});
