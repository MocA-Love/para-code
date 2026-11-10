/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { IObjectTreeElement, ObjectTreeElementCollapseState } from '../../../../../base/browser/ui/tree/tree.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisWorkspaceRepository, IParadisWorktree } from '../../common/paradisWorkspaceSwitch.js';
import { IParadisSectionGroup, IParadisWorkspaceSection } from '../../common/paradisWorkspaceSections.js';
import { ICreatingSpaceElement, IParadisWorkspaceTreeSource, ISectionHeaderElement, isPinnedKeep, paradisBuildWorkspaceTree, paradisCollectTreeWorktrees, paradisWorkspaceDropDecision, paradisWorkspaceTreeElementId, SECTION_DRAFT_KEY, WorkspaceTreeElement } from '../../browser/paradisWorkspaceSectionTree.js';

function repository(id: string): IParadisWorkspaceRepository {
	return { id, name: id, uri: URI.file(`/repos/${id}`) };
}

function mainCheckout(repositoryId: string): IParadisWorktree {
	return { repositoryId, name: 'local', uri: URI.file(`/repos/${repositoryId}`), isMainCheckout: true };
}

function worktree(repositoryId: string, name: string): IParadisWorktree {
	return { repositoryId, name, uri: URI.file(`/worktrees/${repositoryId}/${name}`) };
}

const alpha = repository('alpha');
const beta = repository('beta');
const gamma = repository('gamma');
const work: IParadisWorkspaceSection = { id: 'work', name: 'Work' };
const empty: IParadisWorkspaceSection = { id: 'empty', name: 'Empty' };

interface ISourceOptions {
	readonly groups?: IParadisSectionGroup<IParadisWorkspaceRepository>[];
	readonly sectionCount?: number;
	readonly drafting?: boolean;
	readonly collapsedSections?: string[];
	readonly collapsedRepositories?: string[];
	readonly pinned?: string[];
}

function source(options: ISourceOptions): IParadisWorkspaceTreeSource {
	const children = new Map<string, (IParadisWorktree | ICreatingSpaceElement)[]>([
		['alpha', [mainCheckout('alpha'), worktree('alpha', 'a1')]],
		['beta', [mainCheckout('beta'), worktree('beta', 'b1'), { creatingJob: { id: 7, repositoryId: 'beta', name: 'b2', stageLabel: 'creating' } }]],
		['gamma', [mainCheckout('gamma')]],
	]);
	return {
		repositories: [alpha, beta, gamma],
		groups: options.groups ?? [{ section: undefined, repositories: [alpha, beta, gamma] }],
		sectionCount: options.sectionCount ?? 0,
		drafting: options.drafting ?? false,
		isSectionCollapsed: key => (options.collapsedSections ?? []).includes(key),
		isRepositoryCollapsed: id => (options.collapsedRepositories ?? []).includes(id),
		repositoryChildren: repo => children.get(repo.id) ?? [],
		isPinned: wt => (options.pinned ?? []).includes(wt.name === 'local' ? wt.repositoryId : wt.name),
	};
}

const sectioned = (overrides: ISourceOptions = {}) => source({
	groups: [{ section: work, repositories: [alpha, beta] }, { section: empty, repositories: [] }, { section: undefined, repositories: [gamma] }],
	sectionCount: 2,
	...overrides,
});

/** 行を「identity（開閉）」と子の入れ子の形に写す。控えは段数も書く。 */
function shape(entries: Iterable<IObjectTreeElement<WorkspaceTreeElement>>): unknown[] {
	return [...entries].map(entry => {
		let label = paradisWorkspaceTreeElementId(entry.element);
		if (isPinnedKeep(entry.element)) {
			label += ` +${entry.element.keepLevels}`;
		}
		if (entry.collapsed !== undefined) {
			const collapsed = entry.collapsed === true || entry.collapsed === ObjectTreeElementCollapseState.PreserveOrCollapsed || entry.collapsed === ObjectTreeElementCollapseState.Collapsed;
			label += collapsed ? ' (closed)' : ' (open)';
		}
		return entry.children ? { [label]: shape(entry.children) } : label;
	});
}

suite('paradisWorkspaceSectionTree', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('without sections the list is the same flat list as before (projects at the root, keeps one level in)', () => {
		const built = paradisBuildWorkspaceTree(source({ collapsedRepositories: ['beta'], pinned: ['b1'] }));
		assert.deepStrictEqual({
			sectioned: built.sectioned,
			headers: [...built.headers.keys()],
			last: [...built.sectionLastRowIds],
			first: [...built.sectionFirstRepositoryIds],
			shape: shape(built.elements),
		}, {
			sectioned: false,
			headers: [],
			last: [],
			first: [],
			shape: [
				{ 'repo:alpha (open)': ['worktree:alpha', 'worktree:worktree:file:///worktrees/alpha/a1'] },
				{ 'repo:beta (closed)': ['worktree:beta', 'worktree:worktree:file:///worktrees/beta/b1', 'creating:7'] },
				'pinnedKeep:worktree:file:///worktrees/beta/b1 +1',
				{ 'repo:gamma (open)': ['worktree:gamma'] },
			],
		});
	});

	test('with sections the projects are children of the header and the spaces are their children', () => {
		const built = paradisBuildWorkspaceTree(sectioned());
		assert.deepStrictEqual({
			sectioned: built.sectioned,
			headers: [...built.headers.values()].map(header => [header.key, header.first, header.repositories.map(repo => repo.id)]),
			last: [...built.sectionLastRowIds],
			first: [...built.sectionFirstRepositoryIds],
			shape: shape(built.elements),
		}, {
			sectioned: true,
			headers: [['work', true, ['alpha', 'beta']], ['empty', false, []], ['uncategorized', false, ['gamma']]],
			last: ['creating:7', 'sectionEmpty:empty', 'worktree:gamma'],
			first: ['alpha', 'gamma'],
			shape: [
				{
					'section:work (open)': [
						{ 'repo:alpha (open)': ['worktree:alpha', 'worktree:worktree:file:///worktrees/alpha/a1'] },
						{ 'repo:beta (open)': ['worktree:beta', 'worktree:worktree:file:///worktrees/beta/b1', 'creating:7'] },
					]
				},
				{ 'section:empty (open)': ['sectionEmpty:empty'] },
				{ 'section:uncategorized (open)': [{ 'repo:gamma (open)': ['worktree:gamma'] }] },
			],
		});
	});

	test('a closed section keeps its children (the ledger decides the state) and shows its pins two levels in, once', () => {
		const built = paradisBuildWorkspaceTree(sectioned({ collapsedSections: ['work'], collapsedRepositories: ['alpha'], pinned: ['alpha', 'b1'] }));
		const ids = (function collect(entries: Iterable<IObjectTreeElement<WorkspaceTreeElement>>): string[] {
			return [...entries].flatMap(entry => [paradisWorkspaceTreeElementId(entry.element), ...(entry.children ? collect(entry.children) : [])]);
		})(built.elements);
		assert.deepStrictEqual({
			last: [...built.sectionLastRowIds],
			shape: shape(built.elements).slice(0, 3),
			duplicates: ids.filter((id, index) => ids.indexOf(id) !== index),
		}, {
			last: ['pinnedKeep:worktree:file:///worktrees/beta/b1', 'sectionEmpty:empty', 'worktree:gamma'],
			shape: [
				{
					'section:work (closed)': [
						{ 'repo:alpha (closed)': ['worktree:alpha', 'worktree:worktree:file:///worktrees/alpha/a1'] },
						{ 'repo:beta (open)': ['worktree:beta', 'worktree:worktree:file:///worktrees/beta/b1', 'creating:7'] },
					]
				},
				'pinnedKeep:alpha +2',
				'pinnedKeep:worktree:file:///worktrees/beta/b1 +2',
			],
			duplicates: [],
		});
	});

	test('a closed project inside an open section keeps its pins one level in, and the last keep ends the section', () => {
		const built = paradisBuildWorkspaceTree(sectioned({ collapsedRepositories: ['beta'], pinned: ['b1'] }));
		assert.deepStrictEqual({
			last: [...built.sectionLastRowIds][0],
			work: shape(built.elements)[0],
		}, {
			last: 'pinnedKeep:worktree:file:///worktrees/beta/b1',
			work: {
				'section:work (open)': [
					{ 'repo:alpha (open)': ['worktree:alpha', 'worktree:worktree:file:///worktrees/alpha/a1'] },
					{ 'repo:beta (closed)': ['worktree:beta', 'worktree:worktree:file:///worktrees/beta/b1', 'creating:7'] },
					'pinnedKeep:worktree:file:///worktrees/beta/b1 +1',
				]
			},
		});
	});

	test('a closed section without pins has no last row (the header carries no line)', () => {
		const built = paradisBuildWorkspaceTree(sectioned({ collapsedSections: ['work'] }));
		assert.deepStrictEqual([...built.sectionLastRowIds], ['sectionEmpty:empty', 'worktree:gamma']);
	});

	test('a section being drafted shows its header before the uncategorized one, even with no sections yet', () => {
		const built = paradisBuildWorkspaceTree(source({ drafting: true }));
		assert.deepStrictEqual(shape(built.elements), [
			{ [`section:${SECTION_DRAFT_KEY} (open)`]: [] },
			{
				'section:uncategorized (open)': [
					{ 'repo:alpha (open)': ['worktree:alpha', 'worktree:worktree:file:///worktrees/alpha/a1'] },
					{ 'repo:beta (open)': ['worktree:beta', 'worktree:worktree:file:///worktrees/beta/b1', 'creating:7'] },
					{ 'repo:gamma (open)': ['worktree:gamma'] },
				]
			},
		]);
	});

	test('the meta presence sees spaces at every depth, keeps included', () => {
		const built = paradisBuildWorkspaceTree(sectioned({ collapsedSections: ['work'], pinned: ['a1'] }));
		assert.deepStrictEqual(paradisCollectTreeWorktrees(built.elements).map(wt => paradisWorkspaceTreeElementId(wt)), [
			'worktree:alpha',
			'worktree:worktree:file:///worktrees/alpha/a1',
			'worktree:beta',
			'worktree:worktree:file:///worktrees/beta/b1',
			'pinnedKeep:worktree:file:///worktrees/alpha/a1',
			'worktree:gamma',
		]);
	});

	test('drop decisions follow the kind of row, not its depth', () => {
		const built = paradisBuildWorkspaceTree(sectioned({ collapsedRepositories: ['beta'], pinned: ['b1'] }));
		const headers = built.headers;
		const work = headers.get('work')!;
		const uncategorized = headers.get('uncategorized')!;
		const emptyHeader = headers.get('empty')!;
		const draft: ISectionHeaderElement = { paradisSectionHeader: true, section: undefined, key: SECTION_DRAFT_KEY, repositories: [], first: false };
		const a1 = worktree('alpha', 'a1');
		const a2 = worktree('alpha', 'a2');
		const keep = paradisCollectTreeWorktrees(built.elements).find(wt => isPinnedKeep(wt))!;
		const cases: [string, ReturnType<typeof paradisWorkspaceDropDecision>][] = [
			['project onto header', paradisWorkspaceDropDecision(gamma, work, false)],
			['project onto uncategorized header', paradisWorkspaceDropDecision(alpha, uncategorized, true)],
			['project onto empty row', paradisWorkspaceDropDecision(alpha, { paradisSectionEmpty: 'empty' }, false)],
			['project onto draft header', paradisWorkspaceDropDecision(alpha, draft, false)],
			['project onto project (same section)', paradisWorkspaceDropDecision(alpha, beta, true)],
			['project onto project (other section)', paradisWorkspaceDropDecision(gamma, alpha, false)],
			['project onto space', paradisWorkspaceDropDecision(alpha, a1, false)],
			['project onto keep', paradisWorkspaceDropDecision(alpha, keep, false)],
			['header onto header', paradisWorkspaceDropDecision(work, emptyHeader, true)],
			['header onto itself', paradisWorkspaceDropDecision(work, work, true)],
			['header onto uncategorized', paradisWorkspaceDropDecision(work, uncategorized, false)],
			['header onto its project', paradisWorkspaceDropDecision(emptyHeader, alpha, false)],
			['space onto space (same project)', paradisWorkspaceDropDecision(a2, a1, true)],
			['space onto main checkout', paradisWorkspaceDropDecision(a1, mainCheckout('alpha'), false)],
			['space onto space (other project)', paradisWorkspaceDropDecision(a1, worktree('beta', 'b1'), false)],
			['space onto keep', paradisWorkspaceDropDecision(worktree('beta', 'b2'), keep, false)],
		];
		assert.deepStrictEqual(cases, [
			['project onto header', { kind: 'intoSection', sectionId: 'work' }],
			['project onto uncategorized header', { kind: 'intoSection', sectionId: undefined }],
			['project onto empty row', { kind: 'intoSection', sectionId: 'empty' }],
			['project onto draft header', undefined],
			['project onto project (same section)', { kind: 'reorder', after: true }],
			['project onto project (other section)', { kind: 'reorder', after: false }],
			['project onto space', undefined],
			['project onto keep', undefined],
			['header onto header', { kind: 'reorder', after: true }],
			['header onto itself', undefined],
			['header onto uncategorized', undefined],
			['header onto its project', undefined],
			['space onto space (same project)', { kind: 'reorder', after: true }],
			['space onto main checkout', undefined],
			['space onto space (other project)', undefined],
			['space onto keep', undefined],
		]);
	});
});
