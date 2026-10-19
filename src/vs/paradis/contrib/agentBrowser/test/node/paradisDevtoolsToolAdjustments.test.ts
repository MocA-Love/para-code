/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { readFileSync } from 'fs';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_OBSERVE_UNSUPPORTED_MESSAGE, PARADIS_DEVTOOLS_DEFAULT_TIMEOUT_MS, PARADIS_SCRIPT_CLICK_HINT, PARADIS_SCRIPT_WAIT_HINT, PARADIS_SNAPSHOT_MAX_CHARS, PARADIS_SNAPSHOT_ROOT_RECT_MARKER, ParadisSnapshotCache, paradisAdjustDevtoolsToolDescriptor, paradisAdjustDevtoolsToolResult, paradisDevtoolsTimeoutTools, paradisEvaluateHasDeadline, paradisEvaluateObserves, paradisPrepareDevtoolsToolCall, paradisShouldRetryDevtoolsToolAfterTargetClosed, paradisSnapshotMeasuresRoot, paradisSnapshotSubtree, paradisStripInternalDevtoolsArguments, paradisTakeSnapshotRootRect, paradisWithScriptHints } from '../../node/paradisDevtoolsToolAdjustments.js';
import { ParadisInputRejectionLog } from '../../node/paradisInputRejectionLog.js';

function text(value: string, isError = false): unknown {
	return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function textOf(result: unknown): string {
	return ((result as { content: { text: string }[] }).content[0]).text;
}

suite('Paradis devtools tool adjustments', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('navigate_page refuses javascript:, data: and internal URLs, and keeps http, https, about:blank and file', () => {
		const refused = (url: string, type?: string) => paradisPrepareDevtoolsToolCall('navigate_page', { url, ...(type !== undefined ? { type } : {}) }).refuse;
		assert.deepStrictEqual({
			javascript: refused(`javascript:document.title='x'`),
			upperCase: refused(' JavaScript:alert(1)') !== undefined,
			data: refused('data:text/html,<script>alert(1)</script>') !== undefined,
			chrome: refused('chrome://settings') !== undefined,
			viewSource: refused('view-source:https://example.com') !== undefined,
			viewSourceFile: refused('view-source:file:///tmp/report.html') !== undefined,
			tab: refused('\tjavascript:alert(1)') !== undefined,
			newline: refused('java\nscript:alert(1)') !== undefined,
			allowed: ['https://example.com/a', 'http://localhost:3000', 'about:blank', 'file:///tmp/report.html'].map(url => refused(url)),
			reloadKeepsUrl: refused('javascript:void 0', 'reload'),
		}, {
			javascript: 'navigate_page only opens http, https, about:blank or file URLs, not javascript: URLs. To run code in the page, use evaluate_script.',
			upperCase: true,
			data: true,
			chrome: true,
			viewSource: true,
			viewSourceFile: true,
			tab: true,
			newline: true,
			allowed: [undefined, undefined, undefined, undefined],
			reloadKeepsUrl: undefined,
		});
	});

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

	// q.html Q397 A1: setTimeout で待つスクリプトには wait_until を勧める 1 行を足す
	test('an evaluate_script that clicks with .click() or waits with setTimeout gets one line each pointing to click_by and wait_until', () => {
		const ok = text('Script ran on page and returned:\n```json\n1\n```');
		const lines = (result: unknown) => (result as { content: { text: string }[] }).content.map(item => item.text === PARADIS_SCRIPT_CLICK_HINT ? 'click' : item.text === PARADIS_SCRIPT_WAIT_HINT ? 'wait' : 'result');
		assert.deepStrictEqual({
			clicked: lines(paradisWithScriptHints('evaluate_script', { function: '() => document.querySelector("button").click()' }, ok)),
			spaced: lines(paradisWithScriptHints('evaluate_script', { function: '() => el.click ()' }, ok)),
			waited: lines(paradisWithScriptHints('evaluate_script', { function: 'async () => { await new Promise(r => setTimeout(r, 2000)); return document.title; }' }, ok)),
			both: lines(paradisWithScriptHints('evaluate_script', { function: 'async () => { el.click(); await new Promise(r => setTimeout (r, 500)); }' }, ok)),
			noClick: lines(paradisWithScriptHints('evaluate_script', { function: '() => document.title' }, ok)),
			failed: lines(paradisWithScriptHints('evaluate_script', { function: '() => el.click()' }, text('boom', true))),
			otherTool: lines(paradisWithScriptHints('take_snapshot', { function: '() => el.click()' }, ok)),
		}, { clicked: ['result', 'click'], spaced: ['result', 'click'], waited: ['result', 'wait'], both: ['result', 'click', 'wait'], noClick: ['result'], failed: ['result'], otherTool: ['result'] });
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

	test('evaluate_script gets a hidden argument to evaluate without waiting, only when the vendored server knows it', () => {
		const source = readFileSync(FileAccess.asFileUri('vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/build/src/tools/script.js').fsPath, 'utf8');
		assert.deepStrictEqual({
			patched: [source.includes('paraCodeObserve: zod.boolean().optional()'), source.includes('PARA_BROWSER_DIALOG_OPEN')],
			knows: [paradisEvaluateObserves([{ name: 'evaluate_script', inputSchema: { properties: { paraCodeObserve: {} } } }]), paradisEvaluateObserves([{ name: 'evaluate_script', inputSchema: { properties: {} } }])],
			published: Object.keys((paradisAdjustDevtoolsToolDescriptor({ name: 'evaluate_script', inputSchema: { type: 'object', properties: { function: { type: 'string' }, paraCodeObserve: { type: 'boolean' } } } }).inputSchema as { properties: object }).properties),
			kept: paradisPrepareDevtoolsToolCall('evaluate_script', { function: 'f', paraCodeObserve: true }, { evaluateObserve: true }).args,
			refused: paradisPrepareDevtoolsToolCall('evaluate_script', { function: 'f', paraCodeObserve: true }),
		}, {
			patched: [true, true],
			knows: [true, false],
			published: ['function'],
			kept: { function: 'f', paraCodeObserve: true },
			// 対応していない vendored では従来の評価（ダイアログを承認しうる）に戻さず、渡さずに断る
			refused: { args: { function: 'f' }, refuse: PARADIS_OBSERVE_UNSUPPORTED_MESSAGE },
		});
	});
	test('an agent cannot send the internal non-waiting evaluate argument', () => {
		assert.deepStrictEqual([
			paradisStripInternalDevtoolsArguments('evaluate_script', { function: 'f', paraCodeObserve: true }),
			paradisStripInternalDevtoolsArguments('evaluate_script', { function: 'f' }),
			paradisStripInternalDevtoolsArguments('click', { uid: '1_2', paraCodeObserve: true }),
		], [{ function: 'f' }, { function: 'f' }, { uid: '1_2', paraCodeObserve: true }]);
	});

	// q.html Q379 の 4: 答えないページの評価を、puppeteer の既定の 180 秒ではなく締め切りで諦める
	test('evaluate_script gets a hidden deadline only when the vendored server knows it, and an agent cannot send one', () => {
		const source = readFileSync(FileAccess.asFileUri('vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/build/src/tools/script.js').fsPath, 'utf8');
		const tool = { name: 'evaluate_script', inputSchema: { type: 'object', properties: { function: { type: 'string' }, paraCodeDeadlineMs: { type: 'number' } } } };
		assert.deepStrictEqual({
			patched: [source.includes('paraCodeDeadlineMs: zod.number().optional()'), source.includes('PARA_BROWSER_PAGE_UNRESPONSIVE')],
			knows: [paradisEvaluateHasDeadline([tool]), paradisEvaluateHasDeadline([{ name: 'evaluate_script', inputSchema: { properties: {} } }])],
			published: Object.keys((paradisAdjustDevtoolsToolDescriptor(tool).inputSchema as { properties: object }).properties),
			kept: paradisPrepareDevtoolsToolCall('evaluate_script', { function: 'f', paraCodeDeadlineMs: 11000 }, { evaluateDeadline: true }).args,
			// 知らない vendored は未知の引数を断るので、締め切り無しの従来の評価に戻す
			dropped: paradisPrepareDevtoolsToolCall('evaluate_script', { function: 'f', paraCodeDeadlineMs: 11000 }),
			stripped: paradisStripInternalDevtoolsArguments('evaluate_script', { function: 'f', paraCodeDeadlineMs: 1 }),
		}, {
			patched: [true, true],
			knows: [true, false],
			published: ['function'],
			kept: { function: 'f', paraCodeDeadlineMs: 11000 },
			dropped: { args: { function: 'f' } },
			stripped: { function: 'f' },
		});
	});

	// q.html Q394: 答えないページの evaluate_script・take_snapshot を、puppeteer の 180 秒ではなく締め切りで諦める
	test('evaluate_script and take_snapshot get a hidden timeout only when the vendored server knows it, and evaluate_script takes the agent\'s timeout', () => {
		const evaluate = { name: 'evaluate_script', inputSchema: { type: 'object', properties: { function: { type: 'string' }, paraCodeObserve: { type: 'boolean' }, paraCodeDeadlineMs: { type: 'number' }, paraCodeTimeoutMs: { type: 'number' } } } };
		const snapshot = { name: 'take_snapshot', inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' }, paraCodeRootRect: { type: 'string' }, paraCodeTimeoutMs: { type: 'number' } } } };
		const both = paradisDevtoolsTimeoutTools([evaluate, snapshot, { name: 'click', inputSchema: { properties: { paraCodeTimeoutMs: {} } } }]);
		const evaluateArgs = (args: Record<string, unknown>, timeoutTools?: ReadonlySet<string>) => paradisPrepareDevtoolsToolCall('evaluate_script', { function: 'f', ...args }, { evaluateObserve: true, evaluateDeadline: true, timeoutTools }).args;
		assert.deepStrictEqual({
			knows: [...both],
			published: {
				evaluate: Object.keys((paradisAdjustDevtoolsToolDescriptor(evaluate).inputSchema as { properties: object }).properties),
				snapshot: Object.keys((paradisAdjustDevtoolsToolDescriptor(snapshot).inputSchema as { properties: object }).properties),
			},
			evaluate: {
				byDefault: evaluateArgs({}, both),
				longer: evaluateArgs({ timeout: 90_000 }, both),
				clamped: [evaluateArgs({ timeout: 10 }, both), evaluateArgs({ timeout: 900_000 }, both), evaluateArgs({ timeout: 'soon' }, both)],
				// 知らない vendored は未知の引数を断るので、`timeout` を外して締め切り無しで評価する
				unknown: evaluateArgs({ timeout: 120_000 }),
				// Para Code の読む・待つ道具の評価には付けない（自分の締め切りがある）
				internal: [evaluateArgs({ paraCodeDeadlineMs: 11_000 }, both), evaluateArgs({ paraCodeObserve: true }, both)],
			},
			snapshot: [paradisPrepareDevtoolsToolCall('take_snapshot', {}, { timeoutTools: both }).args, paradisPrepareDevtoolsToolCall('take_snapshot', { paraCodeTimeoutMs: 1 }).args],
			stripped: [paradisStripInternalDevtoolsArguments('evaluate_script', { function: 'f', paraCodeTimeoutMs: 1, timeout: 5000 }), paradisStripInternalDevtoolsArguments('take_snapshot', { paraCodeTimeoutMs: 1 })],
		}, {
			knows: ['evaluate_script', 'take_snapshot'],
			published: { evaluate: ['function', 'timeout'], snapshot: ['verbose', 'offset', 'root'] },
			evaluate: {
				byDefault: { function: 'f', paraCodeTimeoutMs: PARADIS_DEVTOOLS_DEFAULT_TIMEOUT_MS },
				longer: { function: 'f', paraCodeTimeoutMs: 90_000 },
				clamped: [{ function: 'f', paraCodeTimeoutMs: 1_000 }, { function: 'f', paraCodeTimeoutMs: 100_000 }, { function: 'f', paraCodeTimeoutMs: PARADIS_DEVTOOLS_DEFAULT_TIMEOUT_MS }],
				unknown: { function: 'f' },
				internal: [{ function: 'f', paraCodeDeadlineMs: 11_000 }, { function: 'f', paraCodeObserve: true }],
			},
			snapshot: [{ paraCodeTimeoutMs: PARADIS_DEVTOOLS_DEFAULT_TIMEOUT_MS }, {}],
			stripped: [{ function: 'f', timeout: 5000 }, {}],
		});
	});

	test('a call the vendored server gave up on says what to do next, and other failures stay as they are', () => {
		const timedOut = (tool: string, ms: number) => text(`PARA_BROWSER_PAGE_UNRESPONSIVE: ${tool} did not finish within ${ms} ms.`, true);
		// evaluate_script は action の中で失敗するので、vendored の応答では `Error: ` の後ろに来る
		const evaluate = textOf(paradisAdjustDevtoolsToolResult('evaluate_script', { args: {} }, text('Error: PARA_BROWSER_PAGE_UNRESPONSIVE: evaluate_script did not finish within 60000 ms.', true)));
		const snapshot = textOf(paradisAdjustDevtoolsToolResult('take_snapshot', { args: {} }, timedOut('take_snapshot', 65_000)));
		assert.deepStrictEqual({
			evaluate: [evaluate.startsWith('PARA_BROWSER_PAGE_UNRESPONSIVE: the script did not finish within 60 s'), evaluate.includes('larger "timeout"')],
			snapshot: snapshot.startsWith('PARA_BROWSER_PAGE_UNRESPONSIVE: the page did not return its accessibility tree within 65 s'),
			other: textOf(paradisAdjustDevtoolsToolResult('evaluate_script', { args: {} }, text('Error: boom', true))),
		}, { evaluate: [true, true], snapshot: true, other: 'Error: boom' });
	});

	// q.html Q393・Q394: vendored の PARA-PATCH が当たっていること（パッケージを更新したら当て直す）
	test('the vendored server still carries the PARA-PATCHes for the tool timeout, the bounded stable-DOM wait and the still-loading navigation', () => {
		const read = (path: string) => readFileSync(FileAccess.asFileUri(`vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/build/src/${path}`).fsPath, 'utf8');
		const handler = read('ToolHandler.js');
		const response = read('McpResponse.js');
		const wait = read('WaitForHelper.js');
		const pages = read('tools/pages.js');
		assert.deepStrictEqual({
			handler: [handler.includes('params?.paraCodeTimeoutMs'), handler.includes('did not finish within'), handler.includes('paraCodeOnAcquired(acquiredGuard)')],
			// 諦めた take_snapshot は、遅れて終わってもページのスナップショットを書き換えない
			abandoned: response.includes('if (!this.paraCodeAbandoned?.()) {'),
			schemas: [read('tools/script.js').includes('paraCodeTimeoutMs: zod.number().optional()'), read('tools/snapshot.js').includes('paraCodeTimeoutMs: zod.number().optional()')],
			wait: wait.includes('Promise.race([pendingObserver, this.timeout(this.#stableDomTimeout)'),
			pages: [pages.includes(`'Page.frameNavigated', paraCodeOnFrameNavigated`), (pages.match(/paraCodeStillLoadingLine\(error, paraCodeCommitted/g) ?? []).length],
		}, { handler: [true, true, true], abandoned: true, schemas: [true, true], wait: true, pages: [true, 4] });
	});

});
