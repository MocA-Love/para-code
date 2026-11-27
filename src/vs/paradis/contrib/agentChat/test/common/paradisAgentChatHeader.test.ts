/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentChatHeaderHides, ParadisAgentChatHeaderWatch, paradisAgentChatHeaderState } from '../../common/paradisAgentChatHeader.js';
import { IParadisAgentChatState } from '../../common/paradisAgentChatState.js';

suite('paradisAgentChatHeaderState', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const state = (extra: Partial<IParadisAgentChatState>): IParadisAgentChatState => ({ token: 'pane', agent: 'claude', epoch: 'e', rev: 0, messages: [], live: null, interaction: null, busy: false, ...extra } as IParadisAgentChatState);

	test('names the agent, the model and effort from the transcript, and the status with its attention and busy marks', () => {
		const summary = (value: IParadisAgentChatState | undefined) => {
			const header = paradisAgentChatHeaderState(value);
			return [header.agent, header.agentName, header.model, header.status, header.attention, header.busy];
		};
		assert.deepStrictEqual([
			summary(undefined),
			summary(state({ info: { model: 'claude-opus-4-5', effort: 'high' }, busy: true })),
			summary(state({ busy: true, interaction: { kind: 'approval', id: 'a' } })),
			summary(state({ interaction: { kind: 'question', id: 'q' } })),
			summary(state({ agent: 'codex', info: { model: 'gpt-5.5', transcriptStale: true } })),
			summary(state({ agentExited: true })),
		], [
			[undefined, '', '', '', false, false],
			['claude', 'Claude Code', 'claude-opus-4-5 · high', '作業中', false, true],
			['claude', 'Claude Code', '', '許可を待っています', true, false],
			['claude', 'Claude Code', '', '質問に答えるのを待っています', true, false],
			['codex', 'Codex', 'gpt-5.5', 'この会話は最新を取得できていません', true, false],
			['claude', 'Claude Code', '', '終了しました', false, false],
		]);
	});

	test('tells about a change of the conversation only when the header would change', () => {
		const changed = store.add(new Emitter<void>());
		let current: IParadisAgentChatState | undefined = state({});
		const watch = store.add(new ParadisAgentChatHeaderWatch({ get state() { return current; }, onDidChange: changed.event }));
		let fired = 0;
		store.add(watch.onDidChange(() => fired++));
		// 発言が増えただけ（見出しは同じ）
		current = state({ rev: 1, messages: [{ rev: 0, role: 'assistant', kind: 'text', text: 'はい' }] });
		changed.fire();
		const sameHeader = fired;
		current = state({ rev: 2, busy: true });
		changed.fire();
		assert.deepStrictEqual({ sameHeader, afterBusy: fired }, { sameHeader: 0, afterBusy: 1 });
	});

	test('header hides come back on dispose, and also when the pane closes, the chat view closes or the conversation changes', () => {
		const hides = store.add(new ParadisAgentChatHeaderHides());
		const changes: number[] = [];
		store.add(hides.onDidChange(instanceId => changes.push(instanceId)));
		const shown = () => [1, 2, 3, 4].filter(instanceId => hides.isHidden(instanceId));
		const log: number[][] = [];

		// 2 人が畳んだら、2 人とも戻すまで畳んだまま。dispose を 2 回呼んでも害は無い
		const first = hides.hide(1, 'a');
		const second = hides.hide(1, 'a');
		first.dispose();
		first.dispose();
		log.push(shown());
		second.dispose();
		log.push(shown());

		// ペインが閉じた・チャット表示が閉じた（release）。その後の dispose は、新しく畳んだ側を戻さない
		const forgotten = hides.hide(2, 'b');
		hides.release(2);
		const again = hides.hide(2, 'b');
		forgotten.dispose();
		log.push(shown());
		again.dispose();

		// 会話が替わったら戻る。畳んだときに会話が無ければ、最初に現れた会話を覚える
		const tokens = new Map<number, string | undefined>([[3, 'c'], [4, undefined]]);
		const conversationHides = [hides.hide(3, 'c'), hides.hide(4, undefined)];
		tokens.set(4, 'd');
		hides.checkTokens(instanceId => tokens.get(instanceId));
		log.push(shown());
		tokens.set(3, 'c2');
		tokens.set(4, 'd2');
		hides.checkTokens(instanceId => tokens.get(instanceId));
		log.push(shown());
		conversationHides.forEach(hide => hide.dispose());

		assert.deepStrictEqual({ log, changes }, {
			log: [[1], [], [2], [3, 4], []],
			changes: [1, 1, 2, 2, 2, 2, 3, 4, 3, 4],
		});
	});
});
