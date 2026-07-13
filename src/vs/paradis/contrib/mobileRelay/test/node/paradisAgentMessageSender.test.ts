/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisSendAgentMessageToTui } from '../../common/paradisAgentMessageSender.js';

suite('ParadisAgentMessageSender', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('sends bracketed paste and Enter as separate writes after validation', async () => {
		const events: string[] = [];
		const outcome = await paradisSendAgentMessageToTui(
			'一回目',
			async (text, execute, bracketedPasteMode) => { events.push(`send:${JSON.stringify([text, execute, bracketedPasteMode])}`); },
			async () => { events.push('validate'); return true; },
			async () => { events.push('delay'); },
		);
		assert.deepStrictEqual({ outcome, events }, {
			outcome: { consumed: true, executed: true },
			events: ['validate', 'send:["一回目",false,true]', 'delay', 'validate', 'send:["\\r",false,false]'],
		});
	});

	test('reports a consumed draft without Enter when the session changes during the paste delay', async () => {
		const sent: string[] = [];
		const validations = [true, false];
		const outcome = await paradisSendAgentMessageToTui(
			'一回目', async text => { sent.push(text); }, async () => validations.shift() ?? false, async () => { },
		);
		assert.deepStrictEqual({ outcome, sent }, { outcome: { consumed: true, executed: false }, sent: ['一回目'] });
	});

	test('does not paste when the session is already stale', async () => {
		const sent: string[] = [];
		const outcome = await paradisSendAgentMessageToTui('一回目', async text => { sent.push(text); }, async () => false, async () => { });
		assert.deepStrictEqual({ outcome, sent }, { outcome: { consumed: false, executed: false }, sent: [] });
	});
});
