/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_SNAPSHOT_BASELINE_MAX_AGE_MS, ParadisSnapshotBaselines, paradisDiffSnapshotBodies, paradisTakeSnapshotDiffMode, paradisWithSnapshotDiffArgument } from '../../node/paradisBrowserSnapshotDiff.js';

const TAKEN_AT = Date.UTC(2026, 9, 10, 1, 2, 3);
const WHEN = '2026-10-10T01:02:03.000Z';

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
			`[Para Code: only what changed since the previous take_snapshot of this tab (taken at ${WHEN}): 3 added, 2 removed, 4 changed. Elements not listed are unchanged and keep their uids. If you have not seen that snapshot, or need the whole page, call take_snapshot with full: true.]`,
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
			same: `[Para Code: the page has not changed since the previous take_snapshot of this tab (taken at ${WHEN}). Its uids still work. Call take_snapshot with full: true for the whole snapshot.]\n`,
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

	test('take_snapshot gets a full argument, which is taken out before the call', () => {
		const tool = paradisWithSnapshotDiffArgument({ name: 'take_snapshot', description: 'Take a text snapshot.', inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } } } });
		const other = { name: 'click', inputSchema: { type: 'object', properties: {} } };
		assert.deepStrictEqual({
			properties: Object.keys((tool.inputSchema as { properties: object }).properties),
			mentionsFull: tool.description.includes('pass full: true'),
			otherUntouched: paradisWithSnapshotDiffArgument(other) === other,
			full: paradisTakeSnapshotDiffMode({ full: true, verbose: false }),
			diff: paradisTakeSnapshotDiffMode({ full: false }),
			none: paradisTakeSnapshotDiffMode(undefined),
		}, {
			properties: ['verbose', 'full'],
			mentionsFull: true,
			otherUntouched: true,
			full: { args: { verbose: false }, mode: 'full' },
			diff: { args: {}, mode: 'diff' },
			none: { args: undefined, mode: 'diff' },
		});
	});
});
