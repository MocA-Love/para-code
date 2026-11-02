/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisDecodeMobileAgentAction } from '../../common/paradisMobileAgentAction.js';

suite('paradisDecodeMobileAgentAction', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const head = { id: 3, token: 'tok', requestId: 'req', epoch: 'ep', windowId: 1 };
	const kind = (value: unknown) => paradisDecodeMobileAgentAction(value)?.kind ?? 'rejected';
	const interaction = (extra: object) => kind({ ...head, t: 'action/interaction', parts: ['1'], delayMs: 0, ...extra });

	test('accepts the same shapes as before and passes the optional fields through unchecked', () => {
		assert.deepStrictEqual({
			send: paradisDecodeMobileAgentAction({ ...head, t: 'action/sendMessage', text: 'hi', agent: 'codex', slashCheck: 42 }),
			setting: paradisDecodeMobileAgentAction({ ...head, t: 'action/claudeSetting', setting: 'model', value: 'opus[1m]' }),
			close: kind({ ...head, t: 'action/closePanel' }),
			keys: paradisDecodeMobileAgentAction({ ...head, t: 'action/interaction', parts: ['1', '\r'], delayMs: 1000, readyMarker: 'm', interaction: { kind: 'approval' } }),
			partsCount: [interaction({ parts: [] }), interaction({ parts: Array(500).fill('a') }), interaction({ parts: Array(501).fill('a') })],
			partLength: [interaction({ parts: ['a'.repeat(10_000)] }), interaction({ parts: ['a'.repeat(10_001)] }), interaction({ parts: [1] })],
			delayMs: [interaction({ delayMs: -1 }), interaction({ delayMs: 1000 }), interaction({ delayMs: 1001 }), interaction({ delayMs: 1.5 })],
			readyMarker: [interaction({ readyMarker: '' }), interaction({ readyMarker: 'a'.repeat(64) }), interaction({ readyMarker: 'a'.repeat(65) })],
			badSetting: [kind({ ...head, t: 'action/claudeSetting', setting: 'theme', value: 'x' }), kind({ ...head, t: 'action/claudeSetting', setting: 'model', value: 'a b' })],
			badHead: [kind({ ...head, t: 'action/closePanel', windowId: 1.5 }), kind({ ...head, t: 'action/closePanel', epoch: undefined }), kind({ ...head, t: 'action/closePanel', id: '3' }), kind({ ...head, t: 'action/sendMessage' })],
			notObject: [kind(null), kind('action/closePanel'), kind({ ...head, t: 'action/approvalOptions' })],
		}, {
			send: { ...head, kind: 'sendMessage', text: 'hi', agent: 'codex', slashCheck: 42, interaction: undefined, expectOption: undefined, expectPromptHash: undefined, approvalPiece: undefined, questionChecks: undefined },
			setting: { ...head, kind: 'claudeSetting', setting: 'model', value: 'opus[1m]', agent: undefined, slashCheck: undefined, interaction: undefined, expectOption: undefined, expectPromptHash: undefined, approvalPiece: undefined, questionChecks: undefined },
			close: 'closePanel',
			keys: { ...head, kind: 'interaction', parts: ['1', '\r'], delayMs: 1000, readyMarker: 'm', interaction: { kind: 'approval' }, agent: undefined, slashCheck: undefined, expectOption: undefined, expectPromptHash: undefined, approvalPiece: undefined, questionChecks: undefined },
			partsCount: ['rejected', 'interaction', 'rejected'],
			partLength: ['interaction', 'rejected', 'rejected'],
			delayMs: ['rejected', 'interaction', 'rejected', 'rejected'],
			readyMarker: ['rejected', 'interaction', 'rejected'],
			badSetting: ['rejected', 'rejected'],
			badHead: ['rejected', 'rejected', 'rejected', 'rejected'],
			notObject: ['rejected', 'rejected', 'rejected'],
		});
	});
});
