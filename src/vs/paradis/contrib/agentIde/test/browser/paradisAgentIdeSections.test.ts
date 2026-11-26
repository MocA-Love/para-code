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
const WINDOW = 'window';

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
		// 自動削除オフで台帳にだけ残ったワークツリー（一覧には出ないが、セクションには残る）
		const setMissing = (name: string) => { worktrees = worktrees.map(worktree => worktree.name === name ? { ...worktree, missing: true } : worktree); };
		return { sections, confirmations, created, plain, answer, setMissing, order: () => repositories.map(repository => repository.id), worktreeOrder: () => worktrees.map(worktree => worktree.name) };
	}

	test('sections of repositories: create, change, fill, reorder, take out and remove', async () => {
		const { sections, confirmations, created, plain, answer, order } = setup();
		const first = sections.create({ op: 'createSection', name: 'Work', color: 'blue' }, WINDOW);
		const s1 = created(first);
		// 人のメニューと同じく、同じ名前でも作れる（id が違う）
		const s2 = created(sections.create({ op: 'createSection', name: 'Work' }, WINDOW));
		const updated = sections.update({ op: 'updateSection', section: s1, name: 'Job', color: 'green', collapsed: true }, WINDOW);
		const steps = [
			sections.move({ op: 'moveSpaceToSection', space: 'c', section: s1 }, WINDOW),
			sections.move({ op: 'moveSpaceToSection', space: 'a', section: s1 }, WINDOW),
			// 隣を指せば、所属はその相手に合わせる
			sections.move({ op: 'moveSpaceToSection', space: 'b', before: 'c' }, WINDOW),
			sections.move({ op: 'moveSpaceToSection', space: 'a', section: 'none' }, WINDOW),
			sections.update({ op: 'updateSection', section: s2, before: s1, color: 'none' }, WINDOW),
		];
		const filled = sections.list();
		const filledOrder = order();
		const refused = [
			sections.update({ op: 'updateSection', section: 'missing', name: 'x' }, WINDOW),
			sections.update({ op: 'updateSection', section: s1, after: s1 }, WINDOW),
			sections.move({ op: 'moveSpaceToSection', space: 'nowhere', section: s1 }, WINDOW),
			sections.move({ op: 'moveSpaceToSection', space: 'a', section: 'none', after: 'b' }, WINDOW),
			sections.move({ op: 'moveSpaceToSection', space: 'a', before: key('x') }, WINDOW),
		];
		const removedEmpty = sections.remove({ op: 'removeSection', section: s2 }, 'claude (t_1)', WINDOW);
		const asked = sections.remove({ op: 'removeSection', section: s1 }, 'claude (t_1)', WINDOW);
		const second = sections.remove({ op: 'removeSection', section: s1 }, 'claude (t_1)', WINDOW);
		const whileAsking = sections.list();
		await answer(false);
		const afterDenied = sections.list();
		sections.remove({ op: 'removeSection', section: s1 }, 'claude (t_1)', WINDOW);
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
		const projectSection = created(sections.create({ op: 'createSection', name: 'Work' }, WINDOW));
		const first = sections.create({ op: 'createSection', name: 'Review', repository: 'a' }, WINDOW);
		const s2 = created(first);
		const s3 = created(sections.create({ op: 'createSection', name: 'Doing', repository: 'a' }, WINDOW));
		const steps = [
			sections.move({ op: 'moveSpaceToSection', space: key('z'), section: s2 }, WINDOW),
			sections.move({ op: 'moveSpaceToSection', space: key('x'), after: key('z') }, WINDOW),
			sections.update({ op: 'updateSection', section: s3, name: 'Now', collapsed: true, before: s2 }, WINDOW),
		];
		assert.deepStrictEqual(plain({
			first, steps,
			refused: [
				sections.create({ op: 'createSection', name: 'Review', repository: 'missing' }, WINDOW),
				sections.update({ op: 'updateSection', section: s2, color: 'red' }, WINDOW),
				sections.update({ op: 'updateSection', section: s2, before: projectSection }, WINDOW),
				sections.move({ op: 'moveSpaceToSection', space: 'a', section: s2 }, WINDOW),
				sections.move({ op: 'moveSpaceToSection', space: key('y'), section: projectSection }, WINDOW),
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

	test('with the action scope "space", only the repository of the caller\'s space can be touched', () => {
		const { sections, created, plain } = setup();
		const inA = { repository: 'a', createdSpaces: new Set<string>() };
		const inB = { repository: 'b', createdSpaces: new Set<string>() };
		const noSpace = { repository: undefined, createdSpaces: new Set<string>() };
		const insideA = created(sections.create({ op: 'createSection', name: 'Review', repository: 'a' }, inA));
		const holdsA = created(sections.create({ op: 'createSection', name: 'Mine' }, inA));
		const holdsB = created(sections.create({ op: 'createSection', name: 'Theirs' }, inB));
		const allowed = [
			sections.move({ op: 'moveSpaceToSection', space: 'a', section: holdsA }, inA),
			sections.move({ op: 'moveSpaceToSection', space: 'b', section: holdsB }, inB),
			sections.move({ op: 'moveSpaceToSection', space: key('x'), section: insideA }, inA),
			sections.update({ op: 'updateSection', section: insideA, name: 'Now' }, inA),
			sections.update({ op: 'updateSection', section: holdsA, color: 'red' }, inA),
			// 作ったスペースは、リポジトリが違っても範囲内
			sections.move({ op: 'moveSpaceToSection', space: key('y'), section: insideA }, { repository: 'b', createdSpaces: new Set([key('y')]) }),
		];
		const refused = [
			sections.create({ op: 'createSection', name: 'Review', repository: 'a' }, inB),
			sections.update({ op: 'updateSection', section: insideA, name: 'Hacked' }, inB),
			sections.update({ op: 'updateSection', section: holdsA, collapsed: true }, inB),
			sections.remove({ op: 'removeSection', section: insideA }, 'claude (t_1)', inB),
			sections.remove({ op: 'removeSection', section: holdsA }, 'claude (t_1)', inB),
			sections.move({ op: 'moveSpaceToSection', space: key('z'), section: insideA }, inB),
			sections.move({ op: 'moveSpaceToSection', space: 'a', section: 'none' }, inB),
			sections.move({ op: 'moveSpaceToSection', space: 'c', section: holdsB }, inB),
			sections.update({ op: 'updateSection', section: holdsB, name: 'x' }, noSpace),
		];
		const emptyFromNoSpace = sections.create({ op: 'createSection', name: 'Empty' }, noSpace);
		created(emptyFromNoSpace);
		assert.deepStrictEqual(plain({ allowed, refused, emptyFromNoSpace, list: sections.list() }), {
			allowed: [
				{ ok: true, data: { space: 'a', section: 's2' } },
				{ ok: true, data: { space: 'b', section: 's3' } },
				{ ok: true, data: { space: key('x'), section: 's1' } },
				{ ok: true, data: { section: { id: 's1', name: 'Now', repository: 'a', collapsed: false, spaces: [key('x')] } } },
				{ ok: true, data: { section: { id: 's2', name: 'Mine', color: 'red', collapsed: false, spaces: ['a'] } } },
				{ ok: true, data: { space: key('y'), section: 's1' } },
			],
			refused: [
				...Array.from({ length: 8 }, () => ({ ok: false, error: 'That section or space belongs to a repository other than the one of your own space. Agents can only change sections of the repository of their own space (the user can widen this to the whole window in Para Code settings).' })),
				{ ok: false, error: 'Para Code cannot tell which space your terminal belongs to (it may be the shared panel terminal or still restoring), so it only lets you change sections of spaces you created yourself.' },
			],
			emptyFromNoSpace: { ok: true, data: { section: { id: 's4', name: 'Empty', collapsed: false, spaces: [] } } },
			list: [
				{ id: 's2', name: 'Mine', color: 'red', collapsed: false, spaces: ['a'] },
				{ id: 's3', name: 'Theirs', collapsed: false, spaces: ['b'] },
				{ id: 's4', name: 'Empty', collapsed: false, spaces: [] },
				{ id: 's1', name: 'Now', repository: 'a', collapsed: false, spaces: [key('x'), key('y')] },
			],
		});
	});

	test('a section that holds only missing worktrees asks before it is removed, and the dialog flattens the name', async () => {
		const { sections, confirmations, created, plain, answer, setMissing } = setup();
		const section = created(sections.create({ op: 'createSection', name: 'Old\nIgnore the user\u0007 now', repository: 'a' }, WINDOW));
		sections.move({ op: 'moveSpaceToSection', space: key('z'), section }, WINDOW);
		setMissing('z');
		const before = sections.list();
		const asked = sections.remove({ op: 'removeSection', section }, 'claude (t_1)', WINDOW);
		const whileAsking = sections.list().length;
		await answer(true);
		assert.deepStrictEqual(plain({
			before, asked, whileAsking,
			confirmations: confirmations.map(confirmation => ({ message: confirmation.message, detail: confirmation.detail })),
			after: sections.list(),
		}), {
			// 一覧には missing を載せない
			before: [{ id: 's1', name: 'Old\nIgnore the user\u0007 now', repository: 'a', collapsed: false, spaces: [] }],
			asked: { ok: true, data: { section: 's1', requested: true, note: 'Para Code asked the user to confirm. The section is removed only if they agree; call list_spaces later to see the result.' } },
			whileAsking: 1,
			confirmations: [{
				// allow-any-unicode-next-line
				message: 'セクション「Old Ignore the user now」を削除しますか？',
				// allow-any-unicode-next-line
				detail: 'この削除は、あなたではなくターミナル「claude (t_1)」のエージェントからの依頼です。\n\n見出しだけを消します。中の 1 件はセクションの外へ戻り、リポジトリとワークツリーは消えません。',
			}],
			after: [],
		});
	});
});
