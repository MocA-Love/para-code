/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { GeneralShellType, PosixShellType, TerminalShellType } from '../../../../../platform/terminal/common/terminal.js';
import { IParadisTitlePinSession, ParadisClaudeTabTitlePinTracker } from '../../common/paradisClaudeTabTitlePin.js';

suite('paradisClaudeTabTitlePin', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const claude = (sessionId: string, at: number): IParadisTitlePinSession => ({ agent: 'claude', sessionId, at });

	/** 1つのタブに、(前面の種別, 会話) を順に与えたときの判断の列。 */
	function run(steps: readonly (readonly [TerminalShellType, IParadisTitlePinSession | undefined])[]): readonly (string | undefined)[] {
		const tracker = new ParadisClaudeTabTitlePinTracker();
		return steps.map(([shellType, session]) => tracker.decide(1, shellType, session));
	}

	test('pins a resumed Claude conversation once the shell leaves the front, even when the hook comes first', () => {
		assert.deepStrictEqual({
			// 起動直後: hook が先、pty の報告（版番号の名前で種別なし）が後
			hookFirst: run([[PosixShellType.Zsh, claude('s1', 1)], [undefined, claude('s1', 1)], [GeneralShellType.Claude, claude('s1', 2)]]),
			nodeClaude: run([[GeneralShellType.Node, claude('s1', 1)]]),
			// ウィンドウを読み込み直した直後はシェルと推測されている。新しい hook が来たら Claude は動いている
			afterReload: run([[PosixShellType.Zsh, claude('s1', 1)], [PosixShellType.Zsh, claude('s1', 1)], [PosixShellType.Zsh, claude('s1', 2)]]),
		}, {
			hookFirst: [undefined, 'pin', undefined],
			nodeClaude: ['pin'],
			afterReload: [undefined, undefined, 'pin'],
		});
	});

	test('does not pin again after the shell came back until the same conversation sends a new hook', () => {
		assert.deepStrictEqual(run([
			[undefined, claude('s1', 1)],
			// Claude が落ちて（SessionEnd なしに）シェルへ戻った。タブ名の側が自分で固定を解いている
			[PosixShellType.Zsh, claude('s1', 2)],
			// 後で動かした別のコマンドを Claude と取り違えない
			[undefined, claude('s1', 2)],
			// 同じ会話を再開した
			[undefined, claude('s1', 3)],
		]), ['pin', undefined, undefined, 'pin']);
	});

	test('releases the pin when the conversation ends or the pane owner is no longer Claude', () => {
		assert.deepStrictEqual({
			sessionEnd: run([[undefined, claude('s1', 1)], [GeneralShellType.Claude, undefined]]),
			// 終了後にシェルが前面に戻っていれば、タブ名の側が既に解いている
			shellAlreadyBack: run([[undefined, claude('s1', 1)], [PosixShellType.Zsh, undefined]]),
			ownerIsCodex: run([[undefined, claude('s1', 1)], [GeneralShellType.Claude, { agent: 'codex', sessionId: 'c1', at: 2 }]]),
			// `/clear` は SessionEnd の後に別の会話の SessionStart が来る。解いた後、新しい会話ですぐ固定し直す
			clear: run([[undefined, claude('s1', 1)], [GeneralShellType.Claude, undefined], [GeneralShellType.Claude, claude('s2', 3)]]),
		}, {
			sessionEnd: ['pin', 'release'],
			shellAlreadyBack: ['pin', undefined],
			ownerIsCodex: ['pin', 'release'],
			clear: ['pin', 'release', 'pin'],
		});
	});

	test('leaves panes without hooks, Codex panes and other agents in front alone', () => {
		assert.deepStrictEqual({
			// hook が届かない（WSL・信頼なし・古い Claude Code）
			noHooks: run([[undefined, undefined], [GeneralShellType.Claude, undefined]]),
			// Codex のペイン（仮タイトルは Codex の側が持つ）
			codexPane: run([[GeneralShellType.Codex, { agent: 'codex', sessionId: 'c1', at: 1 }]]),
			otherAgentInFront: run([[GeneralShellType.Codex, claude('s1', 1)], [GeneralShellType.Codex, claude('s1', 2)]]),
			// 入れ子の Codex の hook は持ち主の判定で外れるので、会話は Claude のまま変わらない
			nestedCodex: run([[undefined, claude('s1', 1)], [GeneralShellType.Claude, claude('s1', 1)], [GeneralShellType.Claude, claude('s1', 4)]]),
		}, {
			noHooks: [undefined, undefined],
			codexPane: [undefined],
			otherAgentInFront: [undefined, undefined],
			nestedCodex: ['pin', undefined, undefined],
		});
	});

	test('forgets closed tabs', () => {
		const tracker = new ParadisClaudeTabTitlePinTracker();
		tracker.decide(1, undefined, claude('s1', 1));
		tracker.decide(2, undefined, claude('s2', 1));
		tracker.retain(new Set([2]));
		tracker.forget(2);
		assert.deepStrictEqual([tracker.decide(1, GeneralShellType.Claude, undefined), tracker.decide(2, GeneralShellType.Claude, undefined)], [undefined, undefined]);
	});
});
