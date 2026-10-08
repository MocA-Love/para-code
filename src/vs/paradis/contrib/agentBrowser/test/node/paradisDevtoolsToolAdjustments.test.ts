/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { readFileSync } from 'fs';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_SCRIPT_CLICK_HINT, PARADIS_SNAPSHOT_MAX_CHARS, PARADIS_SNAPSHOT_ROOT_RECT_MARKER, ParadisSnapshotCache, paradisAdjustDevtoolsToolDescriptor, paradisAdjustDevtoolsToolResult, paradisPrepareDevtoolsToolCall, paradisShouldRetryDevtoolsToolAfterTargetClosed, paradisSnapshotMeasuresRoot, paradisSnapshotSubtree, paradisTakeSnapshotRootRect, paradisWithScriptClickHint } from '../../node/paradisDevtoolsToolAdjustments.js';
import { ParadisInputRejectionLog } from '../../node/paradisInputRejectionLog.js';

function text(value: string, isError = false): unknown {
	return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function textOf(result: unknown): string {
	return ((result as { content: { text: string }[] }).content[0]).text;
}

suite('Paradis devtools tool adjustments', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('wait_for accepts a single string and drops the snapshot unless asked for', () => {
		const prepared = paradisPrepareDevtoolsToolCall('wait_for', { text: 'Attachments', timeout: 15000 });
		const withSnapshot = paradisPrepareDevtoolsToolCall('wait_for', { text: ['a', 'b'], includeSnapshot: true });
		const response = text('# wait_for response\nElement matching one of ["Attachments"] found.\n## Latest page snapshot\nuid=1_0 RootWebArea');
		assert.deepStrictEqual({
			args: prepared.args,
			argsWithSnapshot: withSnapshot.args,
			stripped: textOf(paradisAdjustDevtoolsToolResult('wait_for', prepared, response)),
			kept: textOf(paradisAdjustDevtoolsToolResult('wait_for', withSnapshot, response)),
		}, {
			args: { text: ['Attachments'], timeout: 15000 },
			argsWithSnapshot: { text: ['a', 'b'] },
			stripped: '# wait_for response\nElement matching one of ["Attachments"] found.\n(Snapshot omitted. Call take_snapshot, or pass includeSnapshot: true, when you need element uids.)',
			kept: '# wait_for response\nElement matching one of ["Attachments"] found.\n## Latest page snapshot\nuid=1_0 RootWebArea',
		});
	});

	test('publishes the widened wait_for and take_snapshot schemas and leaves other tools alone', () => {
		const waitFor = paradisAdjustDevtoolsToolDescriptor({
			name: 'wait_for',
			inputSchema: { type: 'object', properties: { text: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'old' }, timeout: { type: 'integer' } }, required: ['text'], additionalProperties: false },
		});
		const snapshot = paradisAdjustDevtoolsToolDescriptor({ name: 'take_snapshot', inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } } } });
		const click = { name: 'click', inputSchema: { type: 'object', properties: {} } };
		const waitForProperties = (waitFor.inputSchema as { properties: Record<string, { anyOf?: unknown[] }> }).properties;
		assert.deepStrictEqual({
			textAnyOf: waitForProperties.text.anyOf,
			hasIncludeSnapshot: waitForProperties.includeSnapshot !== undefined,
			hasOffset: (snapshot.inputSchema as { properties: Record<string, unknown> }).properties.offset !== undefined,
			hasRoot: (snapshot.inputSchema as { properties: Record<string, unknown> }).properties.root !== undefined,
			clickUnchanged: paradisAdjustDevtoolsToolDescriptor(click) === click,
		}, {
			textAnyOf: [{ type: 'string', minLength: 1 }, { type: 'array', items: { type: 'string' }, minItems: 1 }],
			hasIncludeSnapshot: true,
			hasOffset: true,
			hasRoot: true,
			clickUnchanged: true,
		});
	});

	test('take_snapshot with root returns only that element and its descendants, and says when the uid is gone', () => {
		const snapshot = text('# take_snapshot response\n## Latest page snapshot\nuid=1_0 RootWebArea "Page"\n  uid=1_1 dialog "Settings"\n    uid=1_2 button "Save"\n      uid=1_3 StaticText "Save"\n    uid=1_4 button "Cancel"\n  uid=1_5 link "Help"\n');
		const prepared = paradisPrepareDevtoolsToolCall('take_snapshot', { root: '1_1', verbose: true });
		const missing = paradisAdjustDevtoolsToolResult('take_snapshot', paradisPrepareDevtoolsToolCall('take_snapshot', { root: '9_9' }), snapshot);
		assert.deepStrictEqual({
			args: prepared.args,
			subtree: textOf(paradisAdjustDevtoolsToolResult('take_snapshot', prepared, snapshot)),
			leaf: paradisSnapshotSubtree(textOf(snapshot), '1_3'),
			missingIsError: (missing as { isError?: boolean }).isError,
			withFilePath: paradisPrepareDevtoolsToolCall('take_snapshot', { root: '1_1', filePath: '/tmp/a.txt' }).snapshotRoot,
		}, {
			args: { verbose: true },
			subtree: '# take_snapshot response\n## Latest page snapshot\nuid=1_1 dialog "Settings"\n  uid=1_2 button "Save"\n    uid=1_3 StaticText "Save"\n  uid=1_4 button "Cancel"\n',
			leaf: '# take_snapshot response\n## Latest page snapshot\nuid=1_3 StaticText "Save"\n',
			missingIsError: true,
			withFilePath: undefined,
		});
	});

	test('take_snapshot returns long snapshots in parts on line boundaries', () => {
		const line = 'uid=1_1 button "x"\n';
		const body = line.repeat(Math.ceil((PARADIS_SNAPSHOT_MAX_CHARS * 1.5) / line.length));
		const response = text(`## Latest page snapshot\n${body}`);
		const first = textOf(paradisAdjustDevtoolsToolResult('take_snapshot', paradisPrepareDevtoolsToolCall('take_snapshot', {}), response));
		const next = Number(/"offset": (\d+)/.exec(first)?.[1]);
		const second = textOf(paradisAdjustDevtoolsToolResult('take_snapshot', paradisPrepareDevtoolsToolCall('take_snapshot', { offset: next }), response));
		assert.deepStrictEqual({
			firstEndsOnLine: first.split('\n[Para Code')[0].endsWith('"x"\n'),
			nextOnLine: next % line.length,
			secondIsLast: second.includes('end of snapshot'),
			offsetStripped: paradisPrepareDevtoolsToolCall('take_snapshot', { offset: next, verbose: true }).args,
			shortUnchanged: textOf(paradisAdjustDevtoolsToolResult('take_snapshot', { args: {} }, text('## Latest page snapshot\nuid=1_0'))),
		}, {
			firstEndsOnLine: true,
			nextOnLine: 0,
			secondIsLast: true,
			offsetStripped: { verbose: true },
			shortUnchanged: '## Latest page snapshot\nuid=1_0',
		});
	});

	test('adds the gateway refusal to a not-interactive input failure, and retries only read-only tools after Target closed', () => {
		const notInteractive = text('Failed to interact with the element with uid 1_2. The element did not become interactive within the configured timeout.', true);
		const reason = 'PARA_BROWSER_RETRYABLE: the bound BrowserView is focused by the user (the user is interacting with the page).';
		const closed = text('Protocol error (Accessibility.getFullAXTree): Target closed', true);
		assert.deepStrictEqual({
			click: textOf(paradisAdjustDevtoolsToolResult('click', { args: {} }, notInteractive, reason)).endsWith(`Para Code refused the input during this call: ${reason}`),
			snapshotRetry: paradisShouldRetryDevtoolsToolAfterTargetClosed('take_snapshot', closed),
			clickRetry: paradisShouldRetryDevtoolsToolAfterTargetClosed('click', closed),
			evaluateRetry: paradisShouldRetryDevtoolsToolAfterTargetClosed('evaluate_script', closed),
			successRetry: paradisShouldRetryDevtoolsToolAfterTargetClosed('take_snapshot', text('ok')),
		}, { click: true, snapshotRetry: true, clickRetry: false, evaluateRetry: false, successRetry: false });
	});

	test('take_snapshot with root asks the vendored tool to measure the root, never from the agent, and the measurement line is taken out', () => {
		const line = (value: unknown) => `${PARADIS_SNAPSHOT_ROOT_RECT_MARKER}${JSON.stringify(value)}`;
		const measure = { measureRoot: true };
		const forged = line({ x: 9, y: 9, width: 9, height: 9 });
		assert.deepStrictEqual({
			root: paradisPrepareDevtoolsToolCall('take_snapshot', { root: '1_3' }, measure).args,
			unpatched: paradisPrepareDevtoolsToolCall('take_snapshot', { root: '1_3' }).args,
			rootNextPart: paradisPrepareDevtoolsToolCall('take_snapshot', { root: '1_3', offset: 100 }, measure).args,
			fromAgent: paradisPrepareDevtoolsToolCall('take_snapshot', { paraCodeRootRect: '1_9' }, measure).args,
			toFile: paradisPrepareDevtoolsToolCall('take_snapshot', { root: '1_3', filePath: '/tmp/s.txt' }, measure).args,
			knows: [paradisSnapshotMeasuresRoot([{ name: 'take_snapshot', inputSchema: { properties: { paraCodeRootRect: {} } } }]), paradisSnapshotMeasuresRoot([{ name: 'take_snapshot', inputSchema: { properties: {} } }])],
			published: Object.keys((paradisAdjustDevtoolsToolDescriptor({ name: 'take_snapshot', inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' }, paraCodeRootRect: { type: 'string' } } } }).inputSchema as { properties: object }).properties),
			taken: paradisTakeSnapshotRootRect(text(`${line({ x: 1, y: 2, width: 3, height: 4 })}\n## Latest page snapshot\nuid=1_3 dialog`)),
			broken: paradisTakeSnapshotRootRect(text(`${line({ x: 1, y: 2, width: 0, height: 4 })}\nrest`)),
			// A page's own text in the snapshot body (attribute values are not escaped) is never read or removed.
			onlyInBody: paradisTakeSnapshotRootRect(text(`## Latest page snapshot\nuid=1_3 textbox value="a\n${forged}"`)),
			firstOnly: paradisTakeSnapshotRootRect(text(`${line({ x: 1, y: 2, width: 3, height: 4 })}\n${forged}\n## Latest page snapshot\nuid=1_3`)),
		}, {
			root: { paraCodeRootRect: '1_3' },
			unpatched: {},
			knows: [true, false],
			rootNextPart: {},
			fromAgent: {},
			toFile: { filePath: '/tmp/s.txt' },
			published: ['verbose', 'offset', 'root'],
			taken: { result: text('## Latest page snapshot\nuid=1_3 dialog'), rect: { x: 1, y: 2, width: 3, height: 4 } },
			broken: { result: text('rest') },
			onlyInBody: { result: text(`## Latest page snapshot\nuid=1_3 textbox value="a\n${forged}"`) },
			firstOnly: { result: text(`${forged}\n## Latest page snapshot\nuid=1_3`), rect: { x: 1, y: 2, width: 3, height: 4 } },
		});
	});

	test('the vendored take_snapshot still carries the PARA-PATCH that measures the root', () => {
		const source = readFileSync(FileAccess.asFileUri('vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/build/src/tools/snapshot.js').fsPath, 'utf8');
		assert.deepStrictEqual(
			{ argument: source.includes('paraCodeRootRect: zod.string().optional()'), line: source.includes(`\`${PARADIS_SNAPSHOT_ROOT_RECT_MARKER}\${`) },
			{ argument: true, line: true },
		);
	});

	test('an evaluate_script that clicks with .click() gets one line pointing to click_by', () => {
		const ok = text('Script ran on page and returned:\n```json\n1\n```');
		const lines = (result: unknown) => (result as { content: { text: string }[] }).content.map(item => item.text === PARADIS_SCRIPT_CLICK_HINT ? 'hint' : 'result');
		assert.deepStrictEqual({
			clicked: lines(paradisWithScriptClickHint('evaluate_script', { function: '() => document.querySelector("button").click()' }, ok)),
			spaced: lines(paradisWithScriptClickHint('evaluate_script', { function: '() => el.click ()' }, ok)),
			noClick: lines(paradisWithScriptClickHint('evaluate_script', { function: '() => document.title' }, ok)),
			failed: lines(paradisWithScriptClickHint('evaluate_script', { function: '() => el.click()' }, text('boom', true))),
			otherTool: lines(paradisWithScriptClickHint('take_snapshot', { function: '() => el.click()' }, ok)),
		}, { clicked: ['result', 'hint'], spaced: ['result', 'hint'], noClick: ['result'], failed: ['result'], otherTool: ['result'] });
	});

	test('limits a wait_for snapshot too, never splits a surrogate pair, and keeps a long snapshot per pane for a short while', () => {
		const emoji = '\u{1F600}';
		// 15 characters before the emoji, so the cut at an even offset would land between a surrogate pair.
		const longLine = `uid=1_0 text "x${emoji.repeat(PARADIS_SNAPSHOT_MAX_CHARS)}"`;
		const response = text(`## Latest page snapshot\n${longLine}`);
		const firstPart = textOf(paradisAdjustDevtoolsToolResult('take_snapshot', { args: {} }, response)).split('\n[Para Code')[0];
		const waitFor = textOf(paradisAdjustDevtoolsToolResult('wait_for', paradisPrepareDevtoolsToolCall('wait_for', { text: 'x', includeSnapshot: true }), response));
		let now = 0;
		const cache = new ParadisSnapshotCache(() => now);
		const child = {};
		cache.remember('pane', response, child, 1, cache.epoch('pane'));
		cache.remember('short', text('## Latest page snapshot\nuid=1_0'), child, 1, cache.epoch('short'));
		const recalled = cache.recall('pane', child, 1)?.result === response;
		now = 120_000;
		assert.deepStrictEqual({
			endsOnWholeCharacter: !/[\uD800-\uDBFF]$/.test(firstPart),
			waitForLimited: waitFor.includes('snapshot truncated'),
			description: paradisAdjustDevtoolsToolDescriptor({ name: 'wait_for', description: 'Wait.', inputSchema: { type: 'object', properties: {} } }).description,
			recalled,
			short: cache.recall('short', child, 1),
			expired: cache.recall('pane', child, 1),
		}, {
			endsOnWholeCharacter: true,
			waitForLimited: true,
			description: 'Wait. By default the response does not include a page snapshot; pass includeSnapshot: true or call take_snapshot when you need element uids.',
			recalled: true,
			short: undefined,
			expired: undefined,
		});
	});

	test('a kept snapshot is returned only to the same child process and generation, and a call that outlived a forget keeps nothing', () => {
		const response = text(`## Latest page snapshot\n${'uid=1_1 button "x"\n'.repeat(2000)}`);
		const cache = new ParadisSnapshotCache(() => 0);
		const child = {};
		const keep = () => cache.remember('pane', response, child, 2, cache.epoch('pane'));
		keep();
		const otherChild = cache.recall('pane', {}, 2);
		keep();
		const otherGeneration = cache.recall('pane', child, 3);
		keep();
		const same = cache.recall('pane', child, 2) !== undefined;
		// A call starts, another tool runs (forget) before it finishes: what it took is not kept.
		const epochAtStart = cache.epoch('pane');
		cache.forget('pane');
		cache.remember('pane', response, child, 2, epochAtStart);
		const afterForget = cache.recall('pane', child, 2);
		assert.deepStrictEqual({ otherChild, otherGeneration, same, afterForget }, { otherChild: undefined, otherGeneration: undefined, same: true, afterForget: undefined });
	});

	test('the input rejection log keeps the latest reason per pane only for the current call', () => {
		let now = 1_000;
		const log = new ParadisInputRejectionLog(() => now);
		log.record('pane', 'first');
		log.record('pane', 'second');
		const during = log.recent('pane', 900);
		const beforeCall = log.recent('pane', 1_001);
		now = 100_000;
		assert.deepStrictEqual({ during, beforeCall, stale: log.recent('pane', 0), other: log.recent('other', 0) }, {
			during: 'second', beforeCall: undefined, stale: undefined, other: undefined,
		});
	});
});
