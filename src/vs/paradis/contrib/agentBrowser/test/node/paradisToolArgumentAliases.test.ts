/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisParseRunStepsFlow } from '../../node/paradisBrowserRunStepsFlow.js';
import { paradisDevtoolsArgumentsForChild, paradisNormalizeLegacyToolArguments } from '../../node/paradisToolArgumentAliases.js';

suite('paradisToolArgumentAliases', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the old millisecond names as the new second names, and keeps the new name when both are given', () => {
		assert.deepStrictEqual({
			settle: paradisNormalizeLegacyToolArguments('click_by', { text: 'Save', settle_ms: 500 }),
			settleBoth: paradisNormalizeLegacyToolArguments('click', { uid: '1_2', settle_ms: 500, settle_seconds: 1 }),
			scroll: paradisNormalizeLegacyToolArguments('scroll_to', { text: 'Row 9', settle_ms: 250 }),
			waitUntil: paradisNormalizeLegacyToolArguments('wait_until', { selector: '#a', interval_ms: 100, network_idle_ms: 500, timeout_seconds: 5 }),
			evaluate: paradisNormalizeLegacyToolArguments('evaluate_script', { function: '() => 1', timeout: 30000 }),
			navigate: paradisNormalizeLegacyToolArguments('navigate_page', { type: 'url', url: 'https://example.com/', timeout: 0, settle_ms: 0 }),
			notNumber: paradisNormalizeLegacyToolArguments('wait_until', { selector: '#a', interval_ms: '100' }),
			otherTool: paradisNormalizeLegacyToolArguments('get_text', { selector: '#a', settle_ms: 500 }),
		}, {
			settle: { text: 'Save', settle_seconds: 0.5 },
			settleBoth: { uid: '1_2', settle_seconds: 1 },
			scroll: { text: 'Row 9', step_wait_seconds: 0.25 },
			waitUntil: { selector: '#a', timeout_seconds: 5, interval_seconds: 0.1, network_idle_seconds: 0.5 },
			evaluate: { function: '() => 1', timeout_seconds: 30 },
			navigate: { type: 'url', url: 'https://example.com/', settle_seconds: 0, timeout_seconds: 0 },
			notNumber: { selector: '#a', interval_ms: '100' },
			otherTool: { selector: '#a', settle_ms: 500 },
		});
	});

	test('reads the old names inside run_steps and saved recipe steps, including nested loops and the tool arguments', () => {
		const legacySteps = [
			{ tool: 'click_by', args: { text: 'Next', settle_ms: 300 } },
			{ expect: { text: 'Saved', timeout_ms: 8000 } },
			{ sleep_ms: 500 },
			{ repeat_until: { disabled: { role: 'button', name: 'Next' } }, steps: [{ sleep_ms: 200 }, { tool: 'wait_for', args: { text: 'Done', timeout: 4000 } }] },
		];
		const currentSteps = [
			{ tool: 'click_by', args: { text: 'Next', settle_seconds: 0.3 } },
			{ expect: { text: 'Saved', timeout_seconds: 8 } },
			{ sleep_seconds: 0.5 },
			{ repeat_until: { disabled: { role: 'button', name: 'Next' } }, steps: [{ sleep_seconds: 0.2 }, { tool: 'wait_for', args: { text: 'Done', timeout_seconds: 4 } }] },
		];
		assert.deepStrictEqual({
			runSteps: paradisNormalizeLegacyToolArguments('run_steps', { steps: legacySteps, settle_ms: 1000 }),
			saveRecipe: paradisNormalizeLegacyToolArguments('save_recipe', { name: 'next', steps: legacySteps, done_when: { text: 'Done', timeout_ms: 3000 } }),
			unchanged: paradisNormalizeLegacyToolArguments('run_steps', { steps: currentSteps }),
		}, {
			runSteps: { steps: currentSteps, settle_seconds: 1 },
			saveRecipe: { name: 'next', steps: currentSteps, done_when: { text: 'Done', timeout_seconds: 3 } },
			unchanged: { steps: currentSteps },
		});
	});

	test('run_steps parses a step list written with the old names the same as one written with the new names', () => {
		const parse = (steps: unknown[]) => {
			const parsed = paradisParseRunStepsFlow({ steps });
			return parsed.ok ? parsed.steps : parsed.error;
		};
		assert.deepStrictEqual(
			parse([{ sleep_ms: 1500 }, { expect: { text: 'Saved', timeout_ms: 2000 } }]),
			parse([{ sleep_seconds: 1.5 }, { expect: { text: 'Saved', timeout_seconds: 2 } }]),
		);
	});

	test('gives the bundled chrome-devtools-mcp its millisecond timeout back', () => {
		assert.deepStrictEqual({
			evaluate: paradisDevtoolsArgumentsForChild('evaluate_script', { function: '() => 1', timeout_seconds: 2.5 }),
			waitFor: paradisDevtoolsArgumentsForChild('wait_for', { text: 'Done', timeout_seconds: 0 }),
			legacy: paradisDevtoolsArgumentsForChild('navigate_page', { type: 'reload', timeout: 5000 }),
			other: paradisDevtoolsArgumentsForChild('wait_until', { selector: '#a', timeout_seconds: 5 }),
		}, {
			evaluate: { function: '() => 1', timeout: 2500 },
			waitFor: { text: 'Done', timeout: 0 },
			legacy: { type: 'reload', timeout: 5000 },
			other: { selector: '#a', timeout_seconds: 5 },
		});
	});
});
