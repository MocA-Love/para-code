/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCcusageAgentForModel, paradisCcusageUnpricedModels } from '../../common/paradisCcusage.js';

suite('ParadisCcusage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies model names across every supported agent family', () => {
		assert.deepStrictEqual([
			paradisCcusageAgentForModel('Claude-3-7-Sonnet'),
			paradisCcusageAgentForModel('GPT-5'),
			paradisCcusageAgentForModel('codex-mini-latest'),
			paradisCcusageAgentForModel('vendor-codex-special'),
			paradisCcusageAgentForModel('o1-preview'),
			paradisCcusageAgentForModel('o3-mini'),
			paradisCcusageAgentForModel('o4-mini'),
			paradisCcusageAgentForModel('Gemini-2.5-Pro'),
			paradisCcusageAgentForModel('llama-3.3'),
		], [
			'claude',
			'codex',
			'codex',
			'codex',
			'codex',
			'codex',
			'codex',
			'gemini',
			'other',
		]);
	});

	test('lists models that used tokens but have no price', () => {
		const total = (model: string, cost: number, inputTokens: number, cacheReadTokens = 0) => ({ model, cost, inputTokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens });
		assert.deepStrictEqual(paradisCcusageUnpricedModels([
			total('claude-opus-5', 12.5, 1000),
			total('claude-mythos-5-2', 0, 2000),
			total('gpt-6', Number.NaN, 0, 500),
			total('claude-haiku-5', 0, 0),
		]), ['claude-mythos-5-2', 'gpt-6']);
	});
});
