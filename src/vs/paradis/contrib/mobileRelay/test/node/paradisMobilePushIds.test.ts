/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_PUSH_ID_PATTERN } from '../../common/paradisMobileProtocol.js';
import { paradisMobilePushIds } from '../../node/paradisMobilePushIds.js';

function notify(fields: Record<string, unknown>): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ kind: 'agent-done', id: 'n1', title: 't', body: 'b', at: 1, ...fields }));
}

suite('paradisMobilePushIds', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('collapses one agent and groups one space with opaque ids that differ per pairing', () => {
		const keyA = new Uint8Array(32).fill(1);
		const keyB = new Uint8Array(32).fill(2);
		const question = paradisMobilePushIds(keyA, notify({ kind: 'agent-question', agentToken: 'tok-1', ws: 'w1:space-a' }));
		const error = paradisMobilePushIds(keyA, notify({ kind: 'agent-error', agentToken: 'tok-1', ws: 'w1:space-a' }));
		const done = paradisMobilePushIds(keyA, notify({ agentToken: 'tok-1', ws: 'w1:space-a' }));
		const otherAgent = paradisMobilePushIds(keyA, notify({ agentToken: 'tok-2', ws: 'w1:space-a' }));
		const otherSpace = paradisMobilePushIds(keyA, notify({ agentToken: 'tok-3', ws: 'w1:space-b' }));
		const otherPairing = paradisMobilePushIds(keyB, notify({ agentToken: 'tok-1', ws: 'w1:space-a' }));
		const noToken = paradisMobilePushIds(keyA, notify({ kind: 'disconnected' }));
		const all = [question, done, otherAgent, otherSpace, otherPairing, noToken].flatMap(ids => [ids.collapseId, ids.threadId]).filter((id): id is string => id !== undefined);

		assert.deepStrictEqual({
			sameAgentCollapses: error.collapseId === done.collapseId,
			// 許可待ち・質問は置き換えない（未回答のものが隠れないように）。まとまりには入れる
			questionNotCollapsed: question.collapseId === undefined && question.threadId === done.threadId,
			otherAgentDoesNot: otherAgent.collapseId !== done.collapseId,
			sameSpaceThread: otherAgent.threadId === done.threadId,
			otherSpaceThread: otherSpace.threadId !== done.threadId,
			perPairing: otherPairing.collapseId !== done.collapseId && otherPairing.threadId !== done.threadId,
			noTokenHasNoCollapse: noToken.collapseId === undefined && noToken.threadId !== undefined,
			// リレーが受け付ける形で、元の値を含まない
			allMatchRelayPattern: all.every(id => PARADIS_PUSH_ID_PATTERN.test(id) && id.length === 32),
			noPlaintext: all.every(id => !id.includes('tok') && !id.includes('space')),
			malformed: paradisMobilePushIds(keyA, new Uint8Array([0xff, 0x7b])),
		}, {
			sameAgentCollapses: true,
			questionNotCollapsed: true,
			otherAgentDoesNot: true,
			sameSpaceThread: true,
			otherSpaceThread: true,
			perPairing: true,
			noTokenHasNoCollapse: true,
			allMatchRelayPattern: true,
			noPlaintext: true,
			malformed: {},
		});
	});
});
