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
import { IParadisSpaceSection } from '../../common/paradisSpaceSections.js';
import { IParadisSectionGroup, IParadisWorkspaceSection } from '../../common/paradisWorkspaceSections.js';
import { ICreatingSpaceElement, IParadisWorkspaceTreeSource, ISectionHeaderElement, ISpaceSectionHeaderElement, isPinnedKeep, isWorktree, paradisBuildWorkspaceTree, paradisKeepBelongsTo, paradisPinnedKeepAriaLevel, paradisCollectTreeWorktrees, paradisWorkspaceDropDecision, paradisWorkspaceTreeElementId, SECTION_DRAFT_KEY, SPACE_SECTION_DRAFT_KEY, WorkspaceTreeElement } from '../../browser/paradisWorkspaceSectionTree.js';

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
	/** beta のスペースのセクション */
	readonly betaSpaceSections?: IParadisSpaceSection[];
	/** スペースの名前 → スペースのセクションの id */
	readonly spaceAssignments?: Record<string, string>;
	readonly collapsedSpaceSections?: string[];
	readonly spaceSectionDraftRepositoryId?: string;
}

function source(options: ISourceOptions): IParadisWorkspaceTreeSource {
	const children = new Map<string, (IParadisWorktree | ICreatingSpaceElement)[]>([
		['alpha', [mainCheckout('alpha'), worktree('alpha', 'a1')]],
		['beta', [mainCheckout('beta'), worktree('beta', 'b1'), ...(options.betaSpaceSections || options.spaceSectionDraftRepositoryId ? [worktree('beta', 'b3'), worktree('beta', 'b4')] : []), { creatingJob: { id: 7, repositoryId: 'beta', name: 'b2', stageLabel: 'creating' } }]],
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
		spaceSections: repositoryId => repositoryId === 'beta' ? options.betaSpaceSections ?? [] : [],
		spaceSectionOf: child => isWorktree(child) ? options.spaceAssignments?.[child.name] : undefined,
		isSpaceSectionCollapsed: id => (options.collapsedSpaceSections ?? []).includes(id),
		spaceSectionDraftRepositoryId: options.spaceSectionDraftRepositoryId,
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
			label += ` +${entry.element.keepLevels}${entry.element.keepSpaceSectionId ? ` in ${entry.element.keepSpaceSectionId}` : ''}`;
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

	test('keeps belong to the closed project or the closed section just above them', () => {
		const closedProject = paradisBuildWorkspaceTree(sectioned({ collapsedRepositories: ['beta'], pinned: ['b1'] }));
		const closedSection = paradisBuildWorkspaceTree(sectioned({ collapsedSections: ['work'], pinned: ['b1'] }));
		const projectKeep = paradisCollectTreeWorktrees(closedProject.elements).find(wt => isPinnedKeep(wt))!;
		const sectionKeep = paradisCollectTreeWorktrees(closedSection.elements).find(wt => isPinnedKeep(wt))!;
		assert.ok(isPinnedKeep(projectKeep) && isPinnedKeep(sectionKeep));
		const work = closedSection.headers.get('work')!;
		const uncategorized = closedSection.headers.get('uncategorized')!;
		assert.deepStrictEqual([
			paradisKeepBelongsTo(projectKeep, beta),
			paradisKeepBelongsTo(projectKeep, alpha),
			paradisKeepBelongsTo(projectKeep, work),
			paradisKeepBelongsTo(sectionKeep, work),
			paradisKeepBelongsTo(sectionKeep, uncategorized),
			paradisKeepBelongsTo(sectionKeep, beta),
		], [true, false, false, true, false, false]);
	});

	test('keeps are read at the level they are drawn at', () => {
		const flat = paradisBuildWorkspaceTree(source({ collapsedRepositories: ['beta'], pinned: ['b1'] }));
		const closedProject = paradisBuildWorkspaceTree(sectioned({ collapsedRepositories: ['beta'], pinned: ['b1'] }));
		const closedSection = paradisBuildWorkspaceTree(sectioned({ collapsedSections: ['work'], pinned: ['b1'] }));
		const levels = [flat, closedProject, closedSection].map(built => {
			const keep = paradisCollectTreeWorktrees(built.elements).find(wt => isPinnedKeep(wt))!;
			assert.ok(isPinnedKeep(keep));
			return paradisPinnedKeepAriaLevel(keep, built.sectioned);
		});
		assert.deepStrictEqual(levels, [2, 3, 3]);
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

	const doing: IParadisSpaceSection = { id: 'doing', name: 'Doing' };
	const review: IParadisSpaceSection = { id: 'review', name: 'Review' };
	const b1 = 'worktree:worktree:file:///worktrees/beta/b1';
	const b3 = 'worktree:worktree:file:///worktrees/beta/b3';
	const b4 = 'worktree:worktree:file:///worktrees/beta/b4';

	test('space sections: local, then unsectioned spaces, then each section with its spaces as real children', () => {
		const built = paradisBuildWorkspaceTree(source({ betaSpaceSections: [doing, review], spaceAssignments: { b3: 'review', b1: 'doing', b4: 'gone' } }));
		assert.deepStrictEqual({
			sectioned: built.sectioned,
			headers: [...built.spaceSectionHeaders.values()].map(header => [header.key, header.ownerRepositoryId, header.spaces.map(space => space.name), header.creatingCount]),
			members: [...built.spaceSectionMemberIds],
			beta: shape(built.elements)[1],
		}, {
			sectioned: false,
			headers: [['doing', 'beta', ['b1'], 0], ['review', 'beta', ['b3'], 0]],
			members: [b1, b3],
			beta: {
				'repo:beta (open)': [
					'worktree:beta',
					// b4 points at a section that no longer exists; the creating row has no section.
					b4,
					'creating:7',
					{ 'spaceSection:doing (open)': [b1] },
					{ 'spaceSection:review (open)': [b3] },
				]
			},
		});
	});

	test('space sections: an empty section shows the drop hint, a draft is the last header of its repository', () => {
		const built = paradisBuildWorkspaceTree(source({ betaSpaceSections: [doing], spaceSectionDraftRepositoryId: 'beta' }));
		const alphaDraft = paradisBuildWorkspaceTree(source({ spaceSectionDraftRepositoryId: 'alpha' }));
		assert.deepStrictEqual({
			beta: shape(built.elements)[1],
			members: [...built.spaceSectionMemberIds],
			alpha: shape(alphaDraft.elements)[0],
		}, {
			beta: {
				'repo:beta (open)': [
					'worktree:beta', b1, b3, b4, 'creating:7',
					{ 'spaceSection:doing (open)': ['spaceSectionEmpty:doing'] },
					{ [`spaceSection:${SPACE_SECTION_DRAFT_KEY} (open)`]: [] },
				]
			},
			members: ['spaceSectionEmpty:doing'],
			alpha: {
				'repo:alpha (open)': [
					'worktree:alpha', 'worktree:worktree:file:///worktrees/alpha/a1',
					{ [`spaceSection:${SPACE_SECTION_DRAFT_KEY} (open)`]: [] },
				]
			},
		});
	});

	test('space sections: a closed section keeps its pins right below the header, and only while its project and project section are open', () => {
		const options: ISourceOptions = { betaSpaceSections: [doing, review], spaceAssignments: { b1: 'doing', b3: 'doing', b4: 'review' }, collapsedSpaceSections: ['doing'], pinned: ['b3'] };
		const open = paradisBuildWorkspaceTree(source(options));
		const closedProject = paradisBuildWorkspaceTree(source({ ...options, collapsedRepositories: ['beta'] }));
		const closedProjectSection = paradisBuildWorkspaceTree(sectioned({ ...options, collapsedSections: ['work'] }));
		const ids = (built: ReturnType<typeof paradisBuildWorkspaceTree>) => (function collect(entries: Iterable<IObjectTreeElement<WorkspaceTreeElement>>): string[] {
			return [...entries].flatMap(entry => [paradisWorkspaceTreeElementId(entry.element), ...(entry.children ? collect(entry.children) : [])]);
		})(built.elements);
		const duplicates = (built: ReturnType<typeof paradisBuildWorkspaceTree>) => ids(built).filter((id, index, all) => all.indexOf(id) !== index);
		const keep = paradisCollectTreeWorktrees(open.elements).find(wt => isPinnedKeep(wt))!;
		assert.ok(isPinnedKeep(keep));
		assert.deepStrictEqual({
			open: shape(open.elements)[1],
			closedProject: shape(closedProject.elements).slice(1, 3),
			closedProjectSection: shape(closedProjectSection.elements).slice(0, 2),
			duplicates: [duplicates(open), duplicates(closedProject), duplicates(closedProjectSection)],
			belongs: [
				paradisKeepBelongsTo(keep, open.spaceSectionHeaders.get('doing')!),
				paradisKeepBelongsTo(keep, open.spaceSectionHeaders.get('review')!),
				paradisKeepBelongsTo(keep, beta),
			],
			ariaLevels: [paradisPinnedKeepAriaLevel(keep, false), paradisPinnedKeepAriaLevel(keep, true)],
		}, {
			open: {
				'repo:beta (open)': [
					'worktree:beta',
					'creating:7',
					{ 'spaceSection:doing (closed)': [b1, b3] },
					'pinnedKeep:worktree:file:///worktrees/beta/b3 +0 in doing',
					{ 'spaceSection:review (open)': [b4] },
				]
			},
			closedProject: [
				{
					'repo:beta (closed)': [
						'worktree:beta',
						'creating:7',
						{ 'spaceSection:doing (closed)': [b1, b3] },
						{ 'spaceSection:review (open)': [b4] },
					]
				},
				'pinnedKeep:worktree:file:///worktrees/beta/b3 +1',
			],
			closedProjectSection: [
				{
					'section:work (closed)': [
						{ 'repo:alpha (open)': ['worktree:alpha', 'worktree:worktree:file:///worktrees/alpha/a1'] },
						{
							'repo:beta (open)': [
								'worktree:beta',
								'creating:7',
								{ 'spaceSection:doing (closed)': [b1, b3] },
								{ 'spaceSection:review (open)': [b4] },
							]
						},
					]
				},
				'pinnedKeep:worktree:file:///worktrees/beta/b3 +2',
			],
			duplicates: [[], [], []],
			belongs: [true, false, false],
			ariaLevels: [3, 4],
		});
	});

	test('space sections: the meta presence and the last row of a project section see the spaces inside', () => {
		const built = paradisBuildWorkspaceTree(sectioned({ betaSpaceSections: [doing], spaceAssignments: { b4: 'doing' } }));
		assert.deepStrictEqual({
			worktrees: paradisCollectTreeWorktrees(built.elements).map(wt => wt.name),
			last: [...built.sectionLastRowIds][0],
		}, {
			worktrees: ['local', 'a1', 'local', 'b1', 'b3', 'b4', 'local'],
			last: b4,
		});
	});

	test('space sections: drop decisions stay inside one repository', () => {
		const built = paradisBuildWorkspaceTree(source({ betaSpaceSections: [doing, review], spaceAssignments: { b1: 'doing' }, spaceSectionDraftRepositoryId: 'beta' }));
		const doingHeader = built.spaceSectionHeaders.get('doing')!;
		const reviewHeader = built.spaceSectionHeaders.get('review')!;
		const draft = built.spaceSectionHeaders.get(SPACE_SECTION_DRAFT_KEY)!;
		const otherHeader: ISpaceSectionHeaderElement = { paradisSpaceSectionHeader: true, ownerRepositoryId: 'alpha', section: { id: 'other', name: 'Other' }, key: 'other', spaces: [], creatingCount: 0 };
		const reviewEmpty = { paradisSpaceSectionEmpty: 'review', ownerRepositoryId: 'beta' };
		const spaceB1 = worktree('beta', 'b1');
		const spaceB3 = worktree('beta', 'b3');
		const cases: [string, ReturnType<typeof paradisWorkspaceDropDecision>][] = [
			['space onto header', paradisWorkspaceDropDecision(spaceB3, doingHeader, false)],
			['space onto empty row', paradisWorkspaceDropDecision(spaceB3, reviewEmpty, true)],
			['space onto draft header', paradisWorkspaceDropDecision(spaceB3, draft, false)],
			['space onto header of another project', paradisWorkspaceDropDecision(spaceB3, otherHeader, false)],
			['main checkout onto header', paradisWorkspaceDropDecision(mainCheckout('beta'), doingHeader, false)],
			['project onto space header', paradisWorkspaceDropDecision(alpha, doingHeader, false)],
			['sectioned space onto main checkout', paradisWorkspaceDropDecision(spaceB1, mainCheckout('beta'), false, true)],
			['unsectioned space onto main checkout', paradisWorkspaceDropDecision(spaceB3, mainCheckout('beta'), false, false)],
			['sectioned space onto main checkout of another project', paradisWorkspaceDropDecision(spaceB1, mainCheckout('alpha'), false, true)],
			['space onto space in another section', paradisWorkspaceDropDecision(spaceB3, spaceB1, true)],
			['space header onto space header', paradisWorkspaceDropDecision(doingHeader, reviewHeader, true)],
			['space header onto itself', paradisWorkspaceDropDecision(doingHeader, doingHeader, true)],
			['space header onto draft', paradisWorkspaceDropDecision(doingHeader, draft, false)],
			['space header onto header of another project', paradisWorkspaceDropDecision(doingHeader, otherHeader, false)],
			['space header onto space', paradisWorkspaceDropDecision(doingHeader, spaceB3, false)],
			['space header onto project', paradisWorkspaceDropDecision(doingHeader, beta, false)],
		];
		assert.deepStrictEqual(cases, [
			['space onto header', { kind: 'intoSpaceSection', sectionId: 'doing' }],
			['space onto empty row', { kind: 'intoSpaceSection', sectionId: 'review' }],
			['space onto draft header', undefined],
			['space onto header of another project', undefined],
			['main checkout onto header', undefined],
			['project onto space header', undefined],
			['sectioned space onto main checkout', { kind: 'intoSpaceSection', sectionId: undefined }],
			['unsectioned space onto main checkout', undefined],
			['sectioned space onto main checkout of another project', undefined],
			['space onto space in another section', { kind: 'reorder', after: true }],
			['space header onto space header', { kind: 'reorder', after: true }],
			['space header onto itself', undefined],
			['space header onto draft', undefined],
			['space header onto header of another project', undefined],
			['space header onto space', undefined],
			['space header onto project', undefined],
		]);
	});
});
