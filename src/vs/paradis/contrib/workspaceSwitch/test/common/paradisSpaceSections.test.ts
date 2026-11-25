/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAddSpaceSection, paradisAssignSpace, paradisDropRemovedRepositorySpaceSections, paradisGroupSpacesBySection, paradisMoveSpaceSection, paradisParseSpaceSections, paradisPruneSpaceAssignments, paradisRemoveSpaceSection, paradisRenameSpaceSection, paradisReorderSpaceSectionByDrop, paradisSectionOrderedSpaceKeys, paradisSerializeSpaceSections, paradisSpaceOrderAfterMove, paradisSpaceOrderAfterSwapInSection, paradisSpaceSectionIds, paradisSpaceSectionOf, ParadisSpaceSections } from '../../common/paradisSpaceSections.js';

const key = (name: string) => `worktree:file:///wt/${name}`;

function state(): ParadisSpaceSections {
	return paradisParseSpaceSections(JSON.stringify({
		repo: {
			sections: [{ id: 'doing', name: 'Doing' }, { id: 'review', name: 'Review' }],
			assignments: { [key('a')]: 'doing', [key('b')]: 'review', [key('c')]: 'doing' },
		},
	}));
}

/** 台帳を、比べやすい素の形に写す。 */
function plain(value: ParadisSpaceSections): unknown {
	return JSON.parse(paradisSerializeSpaceSections(value)!);
}

suite('paradisSpaceSections', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parse keeps what is readable and drops broken entries one by one', () => {
		const parsed = paradisParseSpaceSections(JSON.stringify({
			repo: {
				sections: [{ id: 'doing', name: ' Doing ' }, { id: 'doing', name: 'Duplicate' }, { id: '', name: 'No id' }, { id: 'blank', name: '  ' }, 'junk'],
				assignments: { [key('a')]: 'doing', [key('b')]: 'gone', repo: 'doing', [key('c')]: 7 },
			},
			// The same section id in another repository is dropped, and a repository left without sections is not kept.
			other: { sections: [{ id: 'doing', name: 'Clash' }], assignments: {} },
			third: { sections: [{ id: 'later', name: 'Later' }] },
			broken: 'junk',
		}));
		assert.deepStrictEqual({
			parsed: plain(parsed),
			garbage: [paradisParseSpaceSections(undefined).size, paradisParseSpaceSections('not json').size, paradisParseSpaceSections('[]').size],
		}, {
			parsed: {
				repo: { sections: [{ id: 'doing', name: 'Doing' }], assignments: { [key('a')]: 'doing' } },
				third: { sections: [{ id: 'later', name: 'Later' }], assignments: {} },
			},
			garbage: [0, 0, 0],
		});
	});

	test('order is unsectioned first, then the sections in order, each keeping the given order', () => {
		const entry = state().get('repo');
		const keys = [key('c'), key('x'), key('b'), key('a'), key('y')];
		const grouping = paradisGroupSpacesBySection(keys, entry!.sections, stateKey => paradisSpaceSectionOf(entry, stateKey));
		assert.deepStrictEqual({
			unsectioned: grouping.unsectioned,
			groups: grouping.groups.map(group => [group.section.id, group.spaces]),
			ordered: paradisSectionOrderedSpaceKeys(keys, entry),
			withoutSections: paradisSectionOrderedSpaceKeys(keys, undefined),
		}, {
			unsectioned: [key('x'), key('y')],
			groups: [['doing', [key('c'), key('a')]], ['review', [key('b')]]],
			ordered: [key('x'), key('y'), key('c'), key('a'), key('b')],
			withoutSections: keys,
		});
	});

	test('sections can be added, renamed, moved and removed inside one repository', () => {
		const base = state();
		const added = paradisAddSpaceSection(base, 'repo', { id: 'later', name: 'Later' })!;
		assert.deepStrictEqual({
			added: [...added.get('repo')!.sections.map(section => section.id)],
			duplicateId: paradisAddSpaceSection(base, 'other', { id: 'doing', name: 'Clash' }),
			firstOfRepository: plain(paradisAddSpaceSection(new Map(), 'fresh', { id: 'one', name: 'One' })!),
			renamed: paradisRenameSpaceSection(base, 'repo', 'doing', ' Now ')!.get('repo')!.sections[0],
			// The same name as another section of the repository is allowed.
			renamedToSibling: paradisRenameSpaceSection(base, 'repo', 'doing', 'Review')!.get('repo')!.sections.map(section => section.name),
			renameNoop: [paradisRenameSpaceSection(base, 'repo', 'doing', 'Doing'), paradisRenameSpaceSection(base, 'repo', 'doing', '  '), paradisRenameSpaceSection(base, 'repo', 'gone', 'X'), paradisRenameSpaceSection(base, 'other', 'doing', 'X')],
			moved: paradisMoveSpaceSection(base, 'repo', 'doing', 1)!.get('repo')!.sections.map(section => section.id),
			moveAtEdge: paradisMoveSpaceSection(base, 'repo', 'doing', -1),
			dropped: paradisReorderSpaceSectionByDrop(added, 'repo', 'later', 'doing', false)!.get('repo')!.sections.map(section => section.id),
			removed: plain(paradisRemoveSpaceSection(base, 'repo', 'doing')!),
			// Removing the last section drops the repository's entry.
			removedAll: plain(paradisRemoveSpaceSection(paradisRemoveSpaceSection(base, 'repo', 'doing')!, 'repo', 'review')!),
			ids: [...paradisSpaceSectionIds(added)],
		}, {
			added: ['doing', 'review', 'later'],
			duplicateId: undefined,
			firstOfRepository: { fresh: { sections: [{ id: 'one', name: 'One' }], assignments: {} } },
			renamed: { id: 'doing', name: 'Now' },
			renamedToSibling: ['Review', 'Review'],
			renameNoop: [undefined, undefined, undefined, undefined],
			moved: ['review', 'doing'],
			moveAtEdge: undefined,
			dropped: ['later', 'doing', 'review'],
			removed: { repo: { sections: [{ id: 'review', name: 'Review' }], assignments: { [key('b')]: 'review' } } },
			removedAll: {},
			ids: ['doing', 'review', 'later'],
		});
	});

	test('a space moves between sections; local and unknown sections are refused', () => {
		const base = state();
		assert.deepStrictEqual({
			moved: [...paradisAssignSpace(base, 'repo', key('a'), 'review')!.get('repo')!.assignments],
			unassigned: [...paradisAssignSpace(base, 'repo', key('a'), undefined)!.get('repo')!.assignments.keys()],
			refused: [
				paradisAssignSpace(base, 'repo', key('a'), 'doing'),
				paradisAssignSpace(base, 'repo', key('x'), undefined),
				paradisAssignSpace(base, 'repo', key('a'), 'gone'),
				// The main checkout (its key is the repository id) never goes into a section.
				paradisAssignSpace(base, 'repo', 'repo', 'doing'),
				paradisAssignSpace(base, 'other', key('a'), 'doing'),
			],
		}, {
			moved: [[key('a'), 'review'], [key('b'), 'review'], [key('c'), 'doing']],
			unassigned: [key('b'), key('c')],
			refused: [undefined, undefined, undefined, undefined, undefined],
		});
	});

	test('the order after a move puts the space at the target and keeps the list order', () => {
		const entry = paradisAssignSpace(state(), 'repo', key('x'), 'doing')!.get('repo');
		// x is now in "doing" with a and c; y is unsectioned; b is in "review".
		const keys = [key('y'), key('a'), key('c'), key('b'), key('x')];
		assert.deepStrictEqual({
			last: paradisSpaceOrderAfterMove(keys, entry, key('x'), 'last'),
			first: paradisSpaceOrderAfterMove(keys, entry, key('x'), 'first'),
			beforeC: paradisSpaceOrderAfterMove(keys, entry, key('x'), { stateKey: key('c'), after: false }),
			afterA: paradisSpaceOrderAfterMove(keys, entry, key('x'), { stateKey: key('a'), after: true }),
			unknown: paradisSpaceOrderAfterMove(keys, entry, key('zzz'), 'first'),
			swapDown: paradisSpaceOrderAfterSwapInSection(keys, entry, key('a'), 1),
			swapAcrossBoundary: [paradisSpaceOrderAfterSwapInSection(keys, entry, key('a'), -1), paradisSpaceOrderAfterSwapInSection(keys, entry, key('y'), 1), paradisSpaceOrderAfterSwapInSection(keys, entry, key('b'), -1)],
		}, {
			last: [key('y'), key('a'), key('c'), key('x'), key('b')],
			first: [key('y'), key('x'), key('a'), key('c'), key('b')],
			beforeC: [key('y'), key('a'), key('x'), key('c'), key('b')],
			afterA: [key('y'), key('a'), key('x'), key('c'), key('b')],
			unknown: [key('y'), key('a'), key('c'), key('x'), key('b')],
			swapDown: [key('y'), key('c'), key('a'), key('x'), key('b')],
			swapAcrossBoundary: [undefined, undefined, undefined],
		});
	});

	test('pruning drops assignments of spaces that are gone, but not when the list is empty or the scan is incomplete', () => {
		const base = state();
		const pruned = paradisPruneSpaceAssignments(base, () => [key('a'), key('z')]);
		assert.deepStrictEqual({
			pruned: [...pruned.get('repo')!.assignments.keys()],
			sectionsKept: pruned.get('repo')!.sections.length,
			// An SSH disconnect leaves the list empty or the scan incomplete: nothing may be dropped.
			emptyList: paradisPruneSpaceAssignments(base, () => []) === base,
			incompleteScan: paradisPruneSpaceAssignments(base, () => undefined) === base,
			nothingToDrop: paradisPruneSpaceAssignments(base, () => [key('a'), key('b'), key('c'), key('d')]) === base,
		}, {
			pruned: [key('a')],
			sectionsKept: 2,
			emptyList: true,
			incompleteScan: true,
			nothingToDrop: true,
		});
	});

	test('a removed repository loses its sections, but not while the repository list is empty', () => {
		const base = paradisAddSpaceSection(state(), 'other', { id: 'later', name: 'Later' })!;
		assert.deepStrictEqual({
			dropped: [...paradisDropRemovedRepositorySpaceSections(base, ['repo']).keys()],
			emptyList: paradisDropRemovedRepositorySpaceSections(base, []) === base,
			nothingToDrop: paradisDropRemovedRepositorySpaceSections(base, ['repo', 'other', 'more']) === base,
		}, {
			dropped: ['repo'],
			emptyList: true,
			nothingToDrop: true,
		});
	});
});
