/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';
import { paradisParseRunStepsFlow } from '../../node/paradisBrowserRunStepsFlow.js';
import { paradisAdjustDevtoolsToolDescriptor } from '../../node/paradisDevtoolsToolAdjustments.js';
import { paradisDevtoolsArgumentsForChild, paradisMentionLegacyArgumentNames, paradisNormalizeLegacyToolArguments, paradisRenamedLegacyArguments } from '../../node/paradisToolArgumentAliases.js';

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
			legacy: paradisDevtoolsArgumentsForChild('navigate_page', { type: 'reload', timeout: 5000 }),
			other: paradisDevtoolsArgumentsForChild('wait_until', { selector: '#a', timeout_seconds: 5 }),
		}, {
			evaluate: { function: '() => 1', timeout: 2500 },
			legacy: { type: 'reload', timeout: 5000 },
			other: { selector: '#a', timeout_seconds: 5 },
		});
	});

	test('a zero timeout, or one that rounds to zero, means the default (upstream would wait without a limit)', () => {
		assert.deepStrictEqual({
			navigateZero: paradisDevtoolsArgumentsForChild('navigate_page', { type: 'reload', timeout_seconds: 0 }),
			navigateTiny: paradisDevtoolsArgumentsForChild('navigate_page', { type: 'url', url: 'https://example.com/', timeout_seconds: 0.0004 }),
			navigateLegacyZero: paradisDevtoolsArgumentsForChild('navigate_page', { type: 'reload', timeout: 0 }),
			waitForZero: paradisDevtoolsArgumentsForChild('wait_for', { text: 'Done', timeout_seconds: 0 }),
			negative: paradisDevtoolsArgumentsForChild('evaluate_script', { function: '() => 1', timeout_seconds: -1 }),
		}, {
			navigateZero: { type: 'reload' },
			navigateTiny: { type: 'url', url: 'https://example.com/' },
			navigateLegacyZero: { type: 'reload' },
			waitForZero: { text: 'Done' },
			negative: { function: '() => 1' },
		});
	});

	test('an error about a renamed argument also names what the agent sent', () => {
		const sent = { selector: '#a', network_idle_ms: 50 };
		const renames = paradisRenamedLegacyArguments('wait_until', sent, paradisNormalizeLegacyToolArguments('wait_until', sent));
		const failure = { content: [{ type: 'text', text: '"network_idle_seconds" must be a number from 0.1 to 30.' }], isError: true };
		assert.deepStrictEqual({
			renames,
			mentioned: paradisMentionLegacyArgumentNames(failure, renames),
			success: paradisMentionLegacyArgumentNames({ content: [{ type: 'text', text: '"network_idle_seconds" ok' }] }, renames),
			currentName: paradisRenamedLegacyArguments('wait_until', { network_idle_seconds: 0.5 }, { network_idle_seconds: 0.5 }),
		}, {
			renames: [['network_idle_ms', 'network_idle_seconds']],
			mentioned: { content: [{ type: 'text', text: '"network_idle_seconds" (sent as "network_idle_ms" in milliseconds) must be a number from 0.1 to 30.' }], isError: true },
			success: { content: [{ type: 'text', text: '"network_idle_seconds" ok' }] },
			currentName: [],
		});
	});

	test('tools/call reads the old names first, then checks the arguments, then gives chrome-devtools-mcp its milliseconds back', async () => {
		const routed: string[] = [];
		const upstreamTimeout = { type: 'integer', description: 'Maximum wait time in milliseconds.' };
		const devtools = [
			paradisAdjustDevtoolsToolDescriptor({ name: 'wait_for', description: 'Wait for the specified text.', inputSchema: { type: 'object', properties: { text: { type: 'array', items: { type: 'string' }, minItems: 1 }, timeout: upstreamTimeout }, required: ['text'], additionalProperties: false } }),
			paradisAdjustDevtoolsToolDescriptor({ name: 'navigate_page', description: 'Go to a URL.', inputSchema: { type: 'object', properties: { type: { type: 'string' }, url: { type: 'string' }, timeout: upstreamTimeout }, additionalProperties: false } }),
		];
		const service = Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
			_listDevtoolsTools: async () => devtools,
			_requireIngressLease: () => { },
			_allToolProviders: () => [],
			_observeSettings: () => ({ settle: false, state: false }),
			_runStepsFlowEnabled: () => false,
			_siteNotesEnabled: () => false,
			_siteRecipesEnabled: () => false,
			_snapshotDiffEnabled: () => false,
			_paneRemoteAuthorityOf: () => undefined,
			_listedToolSchemas: new Map(),
			_cursorPacing: { begin: () => ({ dispose: () => { } }) },
			_callerRefusalBeforeLane: async () => undefined,
			_evictionNoteKey: () => undefined,
			_withEvictionNote: (_key: unknown, result: unknown) => result,
			_withHumanCheck: async (_lease: unknown, _name: unknown, _args: unknown, result: unknown) => result,
			_isSubagentCall: () => false,
			_callToolRouted: async (_lease: unknown, name: string, params: { arguments?: unknown }) => {
				routed.push(`${name} ${JSON.stringify(params.arguments)}`);
				return name === 'wait_until' ? { content: [{ type: 'text', text: '"network_idle_seconds" must be a number from 0.1 to 30.' }], isError: true } : { content: [{ type: 'text', text: 'ok' }] };
			},
		}) as unknown as { _callTool(lease: object, params: { name: string; arguments: unknown }): Promise<{ content: { text: string }[]; isError?: boolean }> };
		const call = (name: string, args: unknown) => service._callTool({ token: 'pane' }, { name, arguments: args });
		const refused = await call('wait_for', { text: ['Done'], timeout_seconds: 'soon' });
		const tooShort = await call('wait_until', { selector: '#a', network_idle_ms: 50 });
		await call('wait_for', { text: ['Done'], timeout: 4000 });
		await call('wait_for', { text: ['Done'], timeout_seconds: 2.5 });
		await call('navigate_page', { type: 'reload', timeout_seconds: 0 });
		assert.deepStrictEqual({
			refused: [refused.isError, refused.content[0].text.split(' Arguments ')[0]],
			tooShort: tooShort.content[0].text,
			routed,
		}, {
			refused: [true, 'wait_for was not run: "timeout_seconds" of wait_for must be a number, not a string ("soon").'],
			tooShort: '"network_idle_seconds" (sent as "network_idle_ms" in milliseconds) must be a number from 0.1 to 30.',
			routed: [
				'wait_until {"selector":"#a","network_idle_seconds":0.05}',
				'wait_for {"text":["Done"],"timeout":4000}',
				'wait_for {"text":["Done"],"timeout":2500}',
				'navigate_page {"type":"reload"}',
			],
		});
	});
});
