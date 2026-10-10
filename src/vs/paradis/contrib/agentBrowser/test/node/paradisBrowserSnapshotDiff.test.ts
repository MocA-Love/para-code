/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_SNAPSHOT_BASELINE_MAX_AGE_MS, ParadisSnapshotBaselines, paradisDiffSnapshotBodies, paradisTakeSnapshotDiffMode, paradisWithSnapshotDiffArgument } from '../../node/paradisBrowserSnapshotDiff.js';

const TAKEN_AT = Date.UTC(2026, 9, 10, 1, 2, 3);
const WHEN = '01:02:03 UTC';

/** 変わらない行を多めに持つページ（差分が全体の半分より小さくなるように）。 */
function page(lines: readonly string[]): string {
	const filler = Array.from({ length: 80 }, (_, i) => `    uid=1_${100 + i} StaticText "Row ${i}"`);
	return ['uid=1_0 RootWebArea "Orders" url="http://localhost/orders"', '  uid=1_1 main', '    uid=1_2 heading "Orders" level="1"', ...filler, ...lines].join('\n') + '\n';
}

function response(body: string): { content: { type: string; text: string }[] } {
	return { content: [{ type: 'text', text: `# take_snapshot response\n## Latest page snapshot\n${body}` }] };
}

function textOf(result: unknown): string {
	return (result as { content: { text: string }[] }).content[0].text;
}

suite('Paradis snapshot diff', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists removed, changed, moved, reordered and added elements by uid', () => {
		const before = page([
			'  uid=1_3 form "Customer"',
			'    uid=1_4 textbox "Name" value="Ann"',
			'    uid=1_5 button "Save"',
			'    uid=1_6 button "Cancel"',
			'  uid=1_7 navigation',
			'    uid=1_8 link "Help"',
			'      uid=1_9 StaticText "Help"',
			'    uid=1_10 link "Logout"',
		]);
		const after = page([
			'  uid=1_3 form "Customer"',
			'    uid=1_4 textbox "Name" value="Bob"',
			'    uid=1_6 button "Cancel"',
			'    uid=1_5 button "Save" disabled',
			'    uid=1_10 link "Logout"',
			'  uid=1_7 navigation',
			'  uid=2_0 dialog "Saved"',
			'    uid=2_1 StaticText "Customer saved"',
			'    uid=2_2 button "OK"',
		]);
		assert.strictEqual(paradisDiffSnapshotBodies(before, after, TAKEN_AT), [
			'## Page snapshot: changes only',
			`[Para Code: changes since your previous take_snapshot of this tab (${WHEN}): 3 added, 2 removed, 4 changed. Unlisted elements are unchanged and keep their uids. full: true returns the whole page (use it if you have not seen that snapshot).]`,
			'Removed (these uids no longer work):',
			'- uid=1_8 link "Help" (and 1 inside)',
			'Changed:',
			'~ the elements inside uid=1_3 are now in this order: uid=1_4, uid=1_6, uid=1_5',
			'~ uid=1_4 textbox "Name" value="Bob"',
			'~ uid=1_5 button "Save" disabled',
			'~ uid=1_10 link "Logout" (moved: now inside uid=1_3)',
			'Added:',
			'+ inside uid=1_0, after uid=1_7:',
			'  uid=2_0 dialog "Saved"',
			'    uid=2_1 StaticText "Customer saved"',
			'    uid=2_2 button "OK"',
			'',
		].join('\n'));
	});

	test('says so in one line when nothing changed, and gives up on another document or a large change', () => {
		const body = page(['  uid=1_3 button "Save"']);
		const otherDocument = body.replaceAll('uid=1_', 'uid=5_');
		const mostlyNew = page(Array.from({ length: 150 }, (_, i) => `  uid=3_${i} StaticText "New ${i}"`));
		assert.deepStrictEqual({
			same: paradisDiffSnapshotBodies(body, body, TAKEN_AT),
			otherDocument: paradisDiffSnapshotBodies(body, otherDocument, TAKEN_AT),
			mostlyNew: paradisDiffSnapshotBodies(body, mostlyNew, TAKEN_AT),
			unreadable: paradisDiffSnapshotBodies(body, 'no snapshot here\n', TAKEN_AT),
		}, {
			same: `[Para Code: no change since your previous take_snapshot of this tab (${WHEN}); its uids still work. full: true returns the whole page.]\n`,
			otherDocument: undefined,
			mostlyNew: undefined,
			unreadable: undefined,
		});
	});

	test('a name with a line break stays with its element', () => {
		const before = page(['  uid=1_3 StaticText "first', 'second"', '  uid=1_4 button "Go"']);
		const after = page(['  uid=1_3 StaticText "first', 'changed"', '  uid=1_4 button "Go"']);
		assert.strictEqual(paradisDiffSnapshotBodies(before, after, TAKEN_AT)?.split('\n').slice(2, 5).join('\n'), 'Changed:\n~ uid=1_3 StaticText "first\nchanged"');
	});

	test('diffs only against what the same tab and child last returned, within the time limit', () => {
		let now = TAKEN_AT;
		const baselines = new ParadisSnapshotBaselines(() => now);
		const child = {};
		const before = page(['  uid=1_3 textbox "Name" value="Ann"']);
		const after = page(['  uid=1_3 textbox "Name" value="Bob"']);
		const kinds: string[] = [];
		const kind = (result: unknown) => kinds.push(textOf(result).includes('## Latest page snapshot') ? 'full' : textOf(result).includes('changes only') ? 'diff' : 'unchanged');

		kind(baselines.apply('tab', child, 1, response(before), 'diff'));
		kind(baselines.apply('tab', child, 1, response(after), 'diff'));
		kind(baselines.apply('tab', child, 1, response(after), 'diff'));
		kind(baselines.apply('tab', child, 1, response(after), 'full'));
		kind(baselines.apply('other-tab', child, 1, response(after), 'diff'));
		kind(baselines.apply('tab', {}, 1, response(after), 'diff'));
		kind(baselines.apply('tab', child, 2, response(after), 'diff'));
		now += PARADIS_SNAPSHOT_BASELINE_MAX_AGE_MS + 1;
		kind(baselines.apply('tab', child, 2, response(after), 'diff'));
		baselines.forgetWhere(token => token === 'tab');
		kind(baselines.apply('tab', child, 2, response(after), 'diff'));
		const failed = { content: [{ type: 'text', text: 'Protocol error' }], isError: true };
		assert.deepStrictEqual({
			kinds,
			failedUntouched: baselines.apply('tab', child, 2, failed, 'diff') === failed,
			diffKeepsHead: textOf(baselines.apply('tab', child, 2, response(before), 'diff')).startsWith('# take_snapshot response\n## Page snapshot: changes only\n'),
		}, {
			kinds: ['full', 'diff', 'unchanged', 'full', 'full', 'full', 'full', 'full', 'full'],
			failedUntouched: true,
			diffKeepsHead: true,
		});
	});

	test('a diff larger than half of what one response can hold is not used, and a cut previous snapshot is never diffed', () => {
		const rows = (count: number, label: string) => Array.from({ length: count }, (_, i) => `  uid=1_${i + 10} StaticText "${label} ${i}"`);
		const big = ['uid=1_0 RootWebArea "Big"', ...rows(1500, 'Row')].join('\n') + '\n';
		// 400 行の文字が変わる。全体（約 5 万字）の半分より小さいが、1 回に返す 20,000 字の半分より大きい
		const changed = ['uid=1_0 RootWebArea "Big"', ...rows(1500, 'Row').map((line, i) => i < 400 ? line.replace('"Row', '"Changed row') : line)].join('\n') + '\n';
		const baselines = new ParadisSnapshotBaselines(() => TAKEN_AT);
		const child = {};
		const kinds = [big, big.replace('"Row 1499"', '"Row 1499 edited"')].map(body => textOf(baselines.apply('tab', child, 1, response(body), 'diff')).includes('changes only') ? 'diff' : 'full');
		assert.deepStrictEqual({
			bigDiff: paradisDiffSnapshotBodies(big, changed, TAKEN_AT),
			bodyLength: big.length > 40_000,
			afterCutSnapshot: kinds,
		}, {
			bigDiff: undefined,
			bodyLength: true,
			// 前回は 20,000 字で切って返したので、1 行だけ変わっても全体を返す
			afterCutSnapshot: ['full', 'full'],
		});
	});

	test('baselines are capped by count and by total characters, and expired ones are dropped', () => {
		let now = TAKEN_AT;
		// 控え全体の上限を 10,000 字にした置き場（1 つ 3,000 字ほどの控えなら 3 つまで）
		const baselines = new ParadisSnapshotBaselines(() => now, 10_000);
		const huge = (label: string) => ['uid=1_0 RootWebArea "Huge"', `  uid=1_1 StaticText "${label}${'x'.repeat(3_000)}"`].join('\n') + '\n';
		for (let i = 0; i < 6; i++) {
			baselines.apply(`huge-${i}`, {}, 1, response(huge(String(i))), 'diff');
		}
		const afterHuge = baselines.size;
		for (let i = 0; i < 40; i++) {
			baselines.apply(`small-${i}`, {}, 1, response(`uid=1_0 RootWebArea "${i}"\n`), 'diff');
		}
		const afterMany = baselines.size.entries;
		now += PARADIS_SNAPSHOT_BASELINE_MAX_AGE_MS + 1;
		baselines.apply('fresh', {}, 1, response('uid=1_0 RootWebArea "fresh"\n'), 'diff');
		assert.deepStrictEqual({
			hugeEntries: afterHuge.entries,
			hugeWithinTotal: afterHuge.chars <= 10_000,
			afterMany,
			afterExpiry: baselines.size.entries,
		}, { hugeEntries: 3, hugeWithinTotal: true, afterMany: 32, afterExpiry: 1 });
	});

	test('take_snapshot gets a full argument, which is taken out before the call', () => {
		const tool = paradisWithSnapshotDiffArgument({ name: 'take_snapshot', description: 'Take a text snapshot.', inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } } } });
		const other = { name: 'click', inputSchema: { type: 'object', properties: {} } };
		assert.deepStrictEqual({
			properties: Object.keys((tool.inputSchema as { properties: object }).properties),
			mentionsChanges: tool.description.includes('only what changed'),
			otherUntouched: paradisWithSnapshotDiffArgument(other) === other,
			full: paradisTakeSnapshotDiffMode({ full: true, verbose: false }),
			diff: paradisTakeSnapshotDiffMode({ full: false }),
			none: paradisTakeSnapshotDiffMode(undefined),
		}, {
			properties: ['verbose', 'full'],
			mentionsChanges: true,
			otherUntouched: true,
			full: { args: { verbose: false }, mode: 'full' },
			diff: { args: {}, mode: 'diff' },
			none: { args: undefined, mode: 'diff' },
		});
	});
});
