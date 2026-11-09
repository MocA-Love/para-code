/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisWorkspaceSections, paradisAddSection, paradisAssignRepository, paradisGroupRepositoriesBySection, paradisLedgerOrderAfterMove, paradisLedgerOrderAfterSwapInSection, paradisMoveSection, paradisOrderRepositoriesBySection, paradisParseCollapsedSections, paradisParseWorkspaceSections, paradisRelativeRepository, paradisRemoveSection, paradisRenameSection, paradisReorderSectionByDrop, paradisSectionOrderedIds, paradisSerializeCollapsedSections, paradisSerializeWorkspaceSections, paradisSetSectionColor, PARADIS_EMPTY_WORKSPACE_SECTIONS } from '../../common/paradisWorkspaceSections.js';

const repos = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));

function state(sections: { id: string; name: string; color?: string }[], assignments: Record<string, string>): IParadisWorkspaceSections {
	return { sections, assignments: new Map(Object.entries(assignments)) };
}

function summarize(groups: ReturnType<typeof paradisGroupRepositoriesBySection<{ id: string }>>): [string | undefined, string[]][] {
	return groups.map(group => [group.section?.id, group.repositories.map(repository => repository.id)]);
}

suite('ParadisWorkspaceSections', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads and writes the ledger, keeping unknown repositories and dropping broken entries one by one', () => {
		const raw = JSON.stringify({
			sections: [
				{ id: 'work', name: 'Work', color: 'blue' },
				{ id: 'hobby', name: 'Hobby' },
				{ id: 'work', name: 'Duplicate' },
				{ id: 'uncategorized', name: 'Reserved' },
				{ id: 'blank', name: '  ' },
				'broken',
			],
			assignments: { a: 'work', b: 'hobby', gone: 'work', c: 'deleted-section', d: 42 },
			future: 'ignored',
		});
		const parsed = paradisParseWorkspaceSections(raw);
		assert.deepStrictEqual({ sections: parsed.sections, assignments: [...parsed.assignments] }, {
			sections: [{ id: 'work', name: 'Work', color: 'blue' }, { id: 'hobby', name: 'Hobby', color: undefined }],
			assignments: [['a', 'work'], ['b', 'hobby'], ['gone', 'work']],
		});
		const roundTrip = paradisParseWorkspaceSections(paradisSerializeWorkspaceSections(parsed));
		assert.deepStrictEqual([roundTrip.sections, [...roundTrip.assignments]], [parsed.sections, [...parsed.assignments]]);
	});

	test('an old ledger without the sections key reads as no sections, so the list looks as before', () => {
		for (const raw of [undefined, '', 'not json', '[]', 'null']) {
			assert.deepStrictEqual(paradisParseWorkspaceSections(raw).sections, []);
		}
		assert.deepStrictEqual(summarize(paradisGroupRepositoriesBySection(repos, PARADIS_EMPTY_WORKSPACE_SECTIONS)), [[undefined, ['a', 'b', 'c', 'd', 'e']]]);
		assert.deepStrictEqual(paradisSectionOrderedIds(['c', 'a', 'b'], PARADIS_EMPTY_WORKSPACE_SECTIONS), ['c', 'a', 'b']);
	});

	test('reads the collapsed set strictly per entry', () => {
		assert.deepStrictEqual(paradisParseCollapsedSections('["work", 3, "", "uncategorized"]'), new Set(['work', 'uncategorized']));
		assert.deepStrictEqual(paradisParseCollapsedSections('{'), new Set());
		assert.strictEqual(paradisSerializeCollapsedSections(new Set(['work', 'hobby'])), '["hobby","work"]');
	});

	test('groups by section order, keeps empty sections and puts the uncategorized group last only when it has projects', () => {
		const sections = state([{ id: 'hobby', name: 'Hobby' }, { id: 'work', name: 'Work' }, { id: 'empty', name: 'Empty' }], { a: 'work', c: 'hobby', d: 'work', e: 'removed' });
		assert.deepStrictEqual(summarize(paradisGroupRepositoriesBySection(repos, sections)), [
			['hobby', ['c']],
			['work', ['a', 'd']],
			['empty', []],
			[undefined, ['b', 'e']],
		]);
		const allAssigned = state([{ id: 'work', name: 'Work' }], { a: 'work', b: 'work' });
		assert.deepStrictEqual(summarize(paradisGroupRepositoriesBySection(repos.slice(0, 2), allAssigned)), [['work', ['a', 'b']]]);
	});

	test('next and previous go through collapsed sections in list order and wrap around', () => {
		const sections = state([{ id: 'hobby', name: 'Hobby' }, { id: 'work', name: 'Work' }], { a: 'work', c: 'hobby', d: 'work' });
		const ordered = paradisOrderRepositoriesBySection(repos, sections);
		assert.deepStrictEqual(ordered.map(repository => repository.id), ['c', 'a', 'd', 'b', 'e']);
		const walk = (start: string, delta: number, steps: number) => {
			const visited: (string | undefined)[] = [];
			let current: string | undefined = start;
			for (let index = 0; index < steps; index++) {
				current = paradisRelativeRepository(ordered, current, delta)?.id;
				visited.push(current);
			}
			return visited;
		};
		assert.deepStrictEqual([walk('c', 1, 5), walk('c', -1, 2), paradisRelativeRepository(ordered, 'unknown', 1)?.id, paradisRelativeRepository([], 'a', 1)], [
			['a', 'd', 'b', 'e', 'c'],
			['e', 'b'],
			'c',
			undefined,
		]);
	});

	test('adds, renames, colors, reorders and moves sections', () => {
		let current: IParadisWorkspaceSections = PARADIS_EMPTY_WORKSPACE_SECTIONS;
		current = paradisAddSection(current, { id: 'work', name: 'Work' })!;
		current = paradisAddSection(current, { id: 'hobby', name: 'Hobby' })!;
		current = paradisAddSection(current, { id: 'read', name: 'Reading' })!;
		assert.strictEqual(paradisAddSection(current, { id: 'work', name: 'Again' }), undefined);
		current = paradisRenameSection(current, 'work', '  Job  ')!;
		assert.strictEqual(paradisRenameSection(current, 'work', '   '), undefined);
		current = paradisSetSectionColor(current, 'hobby', 'green')!;
		current = paradisMoveSection(current, 'read', -1)!;
		assert.strictEqual(paradisMoveSection(current, 'work', -1), undefined);
		const dropped = paradisReorderSectionByDrop(current, 'work', 'hobby', true)!;
		assert.deepStrictEqual([current.sections, dropped.sections.map(section => section.id)], [
			[{ id: 'work', name: 'Job' }, { id: 'read', name: 'Reading' }, { id: 'hobby', name: 'Hobby', color: 'green' }],
			['read', 'hobby', 'work'],
		]);
	});

	test('deleting a section moves its projects back to uncategorized and keeps the others', () => {
		const sections = state([{ id: 'work', name: 'Work' }, { id: 'hobby', name: 'Hobby' }], { a: 'work', b: 'hobby', c: 'work' });
		const removed = paradisRemoveSection(sections, 'work')!;
		assert.deepStrictEqual([removed.sections.map(section => section.id), [...removed.assignments], summarize(paradisGroupRepositoriesBySection(repos, removed))], [
			['hobby'],
			[['b', 'hobby']],
			[['hobby', ['b']], [undefined, ['a', 'c', 'd', 'e']]],
		]);
		assert.strictEqual(paradisRemoveSection(sections, 'missing'), undefined);
	});

	test('assigning a project and aligning the project ledger to the list order', () => {
		const sections = state([{ id: 'work', name: 'Work' }, { id: 'hobby', name: 'Hobby' }], { a: 'hobby', b: 'work' });
		const ledger = ['a', 'b', 'c', 'd', 'e'];
		// Dropped on the "work" header: goes to the end of work.
		const intoWork = paradisAssignRepository(sections, 'd', 'work')!;
		// Dropped before "a" (in hobby): joins hobby in front of a.
		const beforeA = paradisAssignRepository(sections, 'e', 'hobby')!;
		// Back to uncategorized.
		const toUncategorized = paradisAssignRepository(sections, 'b', undefined)!;
		assert.deepStrictEqual([
			paradisLedgerOrderAfterMove(ledger, intoWork, 'd', undefined),
			paradisLedgerOrderAfterMove(ledger, beforeA, 'e', { repositoryId: 'a', after: false }),
			paradisLedgerOrderAfterMove(ledger, toUncategorized, 'b', undefined),
			paradisAssignRepository(sections, 'a', 'hobby'),
			paradisAssignRepository(sections, 'a', 'missing'),
		], [
			['b', 'd', 'a', 'c', 'e'],
			['b', 'e', 'a', 'c', 'd'],
			['a', 'c', 'd', 'e', 'b'],
			undefined,
			undefined,
		]);
	});

	test('move up and down stay inside the section', () => {
		const sections = state([{ id: 'work', name: 'Work' }], { b: 'work', d: 'work' });
		const ledger = ['a', 'b', 'c', 'd', 'e'];
		assert.deepStrictEqual([
			paradisLedgerOrderAfterSwapInSection(ledger, sections, 'd', -1),
			paradisLedgerOrderAfterSwapInSection(ledger, sections, 'b', -1),
			paradisLedgerOrderAfterSwapInSection(ledger, sections, 'a', -1),
			paradisLedgerOrderAfterSwapInSection(ledger, sections, 'a', 1),
		], [
			['d', 'b', 'a', 'c', 'e'],
			undefined,
			undefined,
			['b', 'd', 'c', 'a', 'e'],
		]);
	});
});
