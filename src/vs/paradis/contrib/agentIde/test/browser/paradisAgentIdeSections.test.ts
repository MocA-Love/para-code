/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfirmationResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { IParadisConfirmation, IParadisDialogService } from '../../../confirmDialog/browser/paradisDialogService.js';
import { ParadisSpaceSectionsService } from '../../../workspaceSwitch/browser/paradisSpaceSectionsService.js';
import { ParadisWorkspaceSectionsService } from '../../../workspaceSwitch/browser/paradisWorkspaceSectionsService.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisAgentIdeSections } from '../../browser/paradisAgentIdeSections.js';
import { ParadisAgentIdeResult } from '../../common/paradisAgentIde.js';

const key = (name: string) => `worktree:file:///wt/${name}`;

// allow-any-unicode-next-line
const CONFIRMATION = { message: 'セクション「Job」を削除しますか？', detail: 'この削除は、あなたではなくターミナル「claude (t_1)」のエージェントからの依頼です。\n\n見出しだけを消します。中の 2 件はセクションの外へ戻り、リポジトリとワークツリーは消えません。', primaryButton: '削除', destructive: true };

suite('ParadisAgentIdeSections', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		let repositories: IParadisWorkspaceRepository[] = ['a', 'b', 'c'].map(id => ({ id, name: id, uri: URI.file(`/repos/${id}`) }));
		let worktrees: IParadisWorktree[] = ['x', 'y', 'z'].map(name => ({ repositoryId: 'a', name, uri: URI.file(`/wt/${name}`) }));
		const storage = store.add(new InMemoryStorageService());
		const switchService = upcastPartial<IParadisWorkspaceSwitchService>({
			get repositories() { return repositories; },
			onDidChangeRepositories: Event.None,
			reorderRepositories: (orderedIds: readonly string[]) => { repositories = orderedIds.map(id => repositories.find(repository => repository.id === id)!); },
		});
		const worktreeService = upcastPartial<IParadisWorktreeService>({
			onDidChangeWorktrees: Event.None,
			getWorktrees: repositoryId => repositoryId === 'a' ? worktrees : [],
			getKnownWorktreeStateKeys: () => [],
			isWorktreeListComplete: () => true,
			setWorktreeOrder: (_repositoryId, orderedUris) => { worktrees = orderedUris.map(uri => worktrees.find(worktree => worktree.uri.toString() === uri)!); },
		});
		const confirmations: IParadisConfirmation[] = [];
		const answers: ((result: IConfirmationResult) => void)[] = [];
		const sections = new ParadisAgentIdeSections(
			switchService,
			worktreeService,
			store.add(new ParadisWorkspaceSectionsService(storage, switchService, new NullLogService())),
			store.add(new ParadisSpaceSectionsService(storage, switchService, worktreeService, new NullLogService())),
			upcastPartial<IParadisDialogService>({
				confirm: confirmation => {
					confirmations.push(confirmation);
					return new Promise<IConfirmationResult>(resolve => answers.push(resolve));
				},
			}),
			upcastPartial<IHostService>({}),
			new NullLogService(),
		);
		// セクションの id は UUID なので、作った順の名札（s1, s2, …）に置き換えて比べる
		const labels = new Map<string, string>();
		const created = (result: ParadisAgentIdeResult): string => {
			assert.ok(result.ok);
			const id = (result.data as { section: { id: string } }).section.id;
			labels.set(id, `s${labels.size + 1}`);
			return id;
		};
		const plain = (value: unknown): unknown => {
			let json = JSON.stringify(value);
			for (const [id, label] of labels) {
				json = json.split(id).join(label);
			}
			return JSON.parse(json);
		};
		const answer = async (confirmed: boolean) => {
			answers.shift()!({ confirmed });
			await timeout(0);
		};
		return { sections, confirmations, created, plain, answer, order: () => repositories.map(repository => repository.id), worktreeOrder: () => worktrees.map(worktree => worktree.name) };
	}

	test('sections of repositories: create, change, fill, reorder, take out and remove', async () => {
		const { sections, confirmations, created, plain, answer, order } = setup();
		const first = sections.create({ op: 'createSection', name: 'Work', color: 'blue' });
		const s1 = created(first);
		// 人のメニューと同じく、同じ名前でも作れる（id が違う）
		const s2 = created(sections.create({ op: 'createSection', name: 'Work' }));
		const updated = sections.update({ op: 'updateSection', section: s1, name: 'Job', color: 'green', collapsed: true });
		const steps = [
			sections.move({ op: 'moveSpaceToSection', space: 'c', section: s1 }),
			sections.move({ op: 'moveSpaceToSection', space: 'a', section: s1 }),
			// 隣を指せば、所属はその相手に合わせる
			sections.move({ op: 'moveSpaceToSection', space: 'b', before: 'c' }),
			sections.move({ op: 'moveSpaceToSection', space: 'a', section: 'none' }),
			sections.update({ op: 'updateSection', section: s2, before: s1, color: 'none' }),
		];
		const filled = sections.list();
		const filledOrder = order();
		const refused = [
			sections.update({ op: 'updateSection', section: 'missing', name: 'x' }),
			sections.update({ op: 'updateSection', section: s1, after: s1 }),
			sections.move({ op: 'moveSpaceToSection', space: 'nowhere', section: s1 }),
			sections.move({ op: 'moveSpaceToSection', space: 'a', section: 'none', after: 'b' }),
			sections.move({ op: 'moveSpaceToSection', space: 'a', before: key('x') }),
		];
		const removedEmpty = sections.remove({ op: 'removeSection', section: s2 }, 'claude (t_1)');
		const asked = sections.remove({ op: 'removeSection', section: s1 }, 'claude (t_1)');
		const second = sections.remove({ op: 'removeSection', section: s1 }, 'claude (t_1)');
		const whileAsking = sections.list();
		await answer(false);
		const afterDenied = sections.list();
		sections.remove({ op: 'removeSection', section: s1 }, 'claude (t_1)');
		await answer(true);
		assert.deepStrictEqual(plain({
			first, updated, steps, filled, filledOrder, refused, removedEmpty, asked, second,
			confirmations: confirmations.map(confirmation => ({ message: confirmation.message, detail: confirmation.detail, primaryButton: confirmation.primaryButton, destructive: confirmation.destructive })),
			whileAsking: whileAsking.length,
			afterDenied: afterDenied.length,
			afterConfirmed: sections.list(),
			order: order(),
		}), {
			first: { ok: true, data: { section: { id: 's1', name: 'Work', color: 'blue', collapsed: false, spaces: [] } } },
			updated: { ok: true, data: { section: { id: 's1', name: 'Job', color: 'green', collapsed: true, spaces: [] } } },
			steps: [
				{ ok: true, data: { space: 'c', section: 's1' } },
				{ ok: true, data: { space: 'a', section: 's1' } },
				{ ok: true, data: { space: 'b', section: 's1' } },
				{ ok: true, data: { space: 'a', section: null } },
				{ ok: true, data: { section: { id: 's2', name: 'Work', collapsed: false, spaces: [] } } },
			],
			filled: [
				{ id: 's2', name: 'Work', collapsed: false, spaces: [] },
				{ id: 's1', name: 'Job', color: 'green', collapsed: true, spaces: ['b', 'c'] },
			],
			filledOrder: ['b', 'c', 'a'],
			refused: [
				{ ok: false, error: 'Unknown section "missing". Sections: s2 ("Work"); s1 ("Job").' },
				{ ok: false, error: '"before" / "after" must name another section of the same list: sections of repositories are ordered among themselves, and sections inside a repository among the sections of that repository.' },
				{ ok: false, error: 'Unknown space "nowhere". Call list_spaces for the space keys.' },
				{ ok: false, error: '"b" is in section "s1", which differs from "section". Omit "section" to join the section of the space named by "before" / "after".' },
				{ ok: false, error: '"before" / "after" must name another space of the same kind: another repository for a repository, another worktree space of the same repository for a worktree space.' },
			],
			removedEmpty: { ok: true, data: { section: 's2', removed: true } },
			asked: { ok: true, data: { section: 's1', requested: true, note: 'Para Code asked the user to confirm. The section is removed only if they agree; call list_spaces later to see the result.' } },
			second: { ok: false, error: 'Para Code is already asking the user about another section removal. Wait until they answer.' },
			confirmations: [CONFIRMATION, CONFIRMATION],
			whileAsking: 1,
			afterDenied: 1,
			afterConfirmed: [],
			// 消しても、リポジトリは一覧に残る
			order: ['b', 'c', 'a'],
		});
	});

	test('sections inside a repository: hold its worktree spaces, have no color, and refuse spaces of another kind', () => {
		const { sections, created, plain, worktreeOrder } = setup();
		const projectSection = created(sections.create({ op: 'createSection', name: 'Work' }));
		const first = sections.create({ op: 'createSection', name: 'Review', repository: 'a' });
		const s2 = created(first);
		const s3 = created(sections.create({ op: 'createSection', name: 'Doing', repository: 'a' }));
		const steps = [
			sections.move({ op: 'moveSpaceToSection', space: key('z'), section: s2 }),
			sections.move({ op: 'moveSpaceToSection', space: key('x'), after: key('z') }),
			sections.update({ op: 'updateSection', section: s3, name: 'Now', collapsed: true, before: s2 }),
		];
		assert.deepStrictEqual(plain({
			first, steps,
			refused: [
				sections.create({ op: 'createSection', name: 'Review', repository: 'missing' }),
				sections.update({ op: 'updateSection', section: s2, color: 'red' }),
				sections.update({ op: 'updateSection', section: s2, before: projectSection }),
				sections.move({ op: 'moveSpaceToSection', space: 'a', section: s2 }),
				sections.move({ op: 'moveSpaceToSection', space: key('y'), section: projectSection }),
			],
			list: sections.list(),
			worktreeOrder: worktreeOrder(),
		}), {
			first: { ok: true, data: { section: { id: 's2', name: 'Review', repository: 'a', collapsed: false, spaces: [] } } },
			steps: [
				{ ok: true, data: { space: key('z'), section: 's2' } },
				{ ok: true, data: { space: key('x'), section: 's2' } },
				{ ok: true, data: { section: { id: 's3', name: 'Now', repository: 'a', collapsed: true, spaces: [] } } },
			],
			refused: [
				{ ok: false, error: 'Unknown repository "missing". Pass a space key of kind "repository" from list_spaces.' },
				{ ok: false, error: 'Sections inside a repository have no color.' },
				{ ok: false, error: '"before" / "after" must name another section of the same list: sections of repositories are ordered among themselves, and sections inside a repository among the sections of that repository.' },
				{ ok: false, error: 'Section "s2" is a section inside repository "a" and only holds its worktree spaces. A repository goes into a section without "repository" in list_spaces "sections".' },
				{ ok: false, error: 'A worktree space only goes into a section of its own repository ("repository": "a" in list_spaces "sections").' },
			],
			list: [
				{ id: 's1', name: 'Work', collapsed: false, spaces: [] },
				{ id: 's3', name: 'Now', repository: 'a', collapsed: true, spaces: [] },
				{ id: 's2', name: 'Review', repository: 'a', collapsed: false, spaces: [key('z'), key('x')] },
			],
			worktreeOrder: ['y', 'z', 'x'],
		});
	});
});
