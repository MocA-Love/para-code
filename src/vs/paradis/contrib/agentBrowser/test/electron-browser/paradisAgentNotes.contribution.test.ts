/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentNoteRequest, IParadisAgentNoteResult, PARADIS_AGENT_NOTES_METHOD } from '../../common/paradisAgentNotes.js';
import { ParadisAgentNotesChannel } from '../../electron-browser/paradisAgentNotes.contribution.js';
import { IParadisPaneTokenService } from '../../browser/paradisPaneTokenService.js';
import {
	IParadisSpaceNote,
	IParadisSpaceNotesService,
	IParadisSpaceNoteSummary,
	paradisRemoveSpaceNoteTask,
	paradisSpaceNoteSummary,
	paradisToggleSpaceNoteTask,
} from '../../../workspaceSwitch/common/paradisSpaceNotes.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, ParadisBindingScope } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

/** 本物のサービスと同じ純粋関数を使うメモ置き場（保存・上限まわりだけを省いたもの）。 */
class FakeSpaceNotesService implements IParadisSpaceNotesService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeNotes = Event.None;
	readonly notes = new Map<string, IParadisSpaceNote>();
	/** 本物の canAccept（件数・キー長の上限）が更新を黙って捨てる状況を再現する。 */
	refuseWrites = false;

	read(stateKey: string): string {
		return this.notes.get(stateKey)?.text ?? '';
	}

	summary(stateKey: string): IParadisSpaceNoteSummary {
		return paradisSpaceNoteSummary(this.read(stateKey));
	}

	write(stateKey: string, text: string): void {
		if (this.refuseWrites) {
			return;
		}
		if (text.trim().length === 0) {
			this.notes.delete(stateKey);
			return;
		}
		this.notes.set(stateKey, { text, updatedAt: 1 });
	}

	toggleTask(stateKey: string, lineIndex: number): void {
		const toggled = paradisToggleSpaceNoteTask(this.read(stateKey), lineIndex);
		if (toggled !== undefined) {
			this.write(stateKey, toggled);
		}
	}

	removeTask(stateKey: string, lineIndex: number): void {
		const removed = paradisRemoveSpaceNoteTask(this.read(stateKey), lineIndex);
		if (removed !== undefined) {
			this.write(stateKey, removed);
		}
	}

	updateTaskText(): void { }

	remove(stateKey: string): void {
		this.notes.delete(stateKey);
	}
}

const REPOSITORY = { id: 'repo-1', name: 'para-code', uri: URI.file('/repo') };
const WORKTREE = { repositoryId: 'repo-1', name: 'feature', uri: URI.file('/repo/.worktrees/feature') };
const WORKTREE_KEY = `worktree:${WORKTREE.uri.toString()}`;
const PANE_TOKEN = 'pane-token';

function createChannel(notes: FakeSpaceNotesService, options: { paneStateKey?: string; paneScope?: ParadisBindingScope; activeStateKey?: string } = {}): ParadisAgentNotesChannel {
	return new ParadisAgentNotesChannel(
		notes,
		{ repositories: [REPOSITORY], activeStateKey: options.activeStateKey } as unknown as IParadisWorkspaceSwitchService,
		{ getWorktrees: () => [WORKTREE] } as unknown as IParadisWorktreeService,
		{
			getStateKeyForInstance: (instanceId: number) => instanceId === 7 ? options.paneStateKey : undefined,
			resolveScope: (): ParadisBindingScope => options.paneScope ?? { kind: 'unscoped' },
		} as unknown as IParadisTerminalScopeService,
		{ getInstanceForToken: (token: string) => token === PANE_TOKEN ? 7 : undefined } as unknown as IParadisPaneTokenService,
	);
}

function call(channel: ParadisAgentNotesChannel, request: IParadisAgentNoteRequest, token: string | undefined = PANE_TOKEN): Promise<IParadisAgentNoteResult> {
	return channel.call<IParadisAgentNoteResult>(undefined, PARADIS_AGENT_NOTES_METHOD, [token, request]);
}

suite('ParadisAgentNotesChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists every space and marks the one owning the pane', async () => {
		const notes = new FakeSpaceNotesService();
		notes.write(WORKTREE_KEY, '- [ ] open\n- [x] done');
		const channel = createChannel(notes, { paneStateKey: WORKTREE_KEY });

		assert.deepStrictEqual(await call(channel, { op: 'list' }), {
			ok: true,
			kind: 'spaces',
			spaces: [
				{ space: 'repo-1', name: 'para-code', kind: 'repository', open: 0, done: 0 },
				// allow-any-unicode-next-line
				{ space: WORKTREE_KEY, name: 'para-code ✦ feature', kind: 'worktree', current: true, open: 1, done: 1 },
			],
		});
	});

	test('adds, checks and deletes a checklist item of the pane space', async () => {
		const notes = new FakeSpaceNotesService();
		const channel = createChannel(notes, { paneStateKey: 'repo-1' });

		const added = await call(channel, { op: 'addTask', task: 'write the note tools' });
		assert.deepStrictEqual(added, {
			ok: true,
			kind: 'note',
			note: {
				space: 'repo-1',
				name: 'para-code',
				text: '- [ ] write the note tools',
				lines: [{ line: 0, kind: 'task', text: 'write the note tools', done: false }],
				open: 1,
				done: 0,
			},
		});

		await call(channel, { op: 'checkTask', line: 0, done: true });
		assert.strictEqual(notes.read('repo-1'), '- [x] write the note tools');

		// 既にチェック済みの行へ done: true を送っても本文は変わらない
		await call(channel, { op: 'checkTask', line: 0, done: true });
		assert.strictEqual(notes.read('repo-1'), '- [x] write the note tools');

		await call(channel, { op: 'checkTask', line: 0 });
		assert.strictEqual(notes.read('repo-1'), '- [ ] write the note tools');

		const deleted = await call(channel, { op: 'deleteTask', line: 0 });
		assert.deepStrictEqual(deleted, {
			ok: true,
			kind: 'note',
			note: { space: 'repo-1', name: 'para-code', text: '', lines: [], open: 0, done: 0 },
		});
	});

	test('falls back to the active space and reports unusable targets', async () => {
		const notes = new FakeSpaceNotesService();
		notes.write('repo-1', '# Plan\n- [ ] one');
		const withActive = createChannel(notes, { activeStateKey: 'repo-1' });

		const read = await call(withActive, { op: 'read' });
		assert.strictEqual(read.ok && read.kind === 'note' && read.note.space, 'repo-1');

		// 見出し行はチェックリストではないので、書き換えずにエラーを返す
		const heading = await call(withActive, { op: 'checkTask', line: 0 });
		assert.strictEqual(heading.ok, false);
		assert.strictEqual(notes.read('repo-1'), '# Plan\n- [ ] one');

		const outOfRange = await call(withActive, { op: 'deleteTask', line: 42 });
		assert.strictEqual(outOfRange.ok, false);

		const unknownSpace = await call(withActive, { op: 'read', space: 'worktree:file:///gone' });
		assert.strictEqual(unknownSpace.ok, false);

		const noSpace = await call(createChannel(notes), { op: 'read' }, 'other-pane');
		assert.strictEqual(noSpace.ok, false);
	});

	test('refuses a default space while the pane scope is still pending', async () => {
		const notes = new FakeSpaceNotesService();
		notes.write('repo-1', '- [ ] keep me');
		// スペース切り替え中: アクティブは新スペースへ移っているが、ペインの所属は未確定
		const channel = createChannel(notes, { paneScope: { kind: 'pending' }, activeStateKey: 'repo-1' });

		const written = await call(channel, { op: 'write', text: '- [ ] clobbered' });
		assert.strictEqual(written.ok, false);
		assert.strictEqual(notes.read('repo-1'), '- [ ] keep me');

		// スペースを明示すれば、未確定でも操作できる
		const explicit = await call(channel, { op: 'read', space: 'repo-1' });
		assert.strictEqual(explicit.ok && explicit.kind === 'note' && explicit.note.text, '- [ ] keep me');
	});

	test('replaces the whole note and hands back what it overwrote', async () => {
		const notes = new FakeSpaceNotesService();
		notes.write(WORKTREE_KEY, '- [x] old plan');
		const channel = createChannel(notes, { paneStateKey: 'repo-1' });

		// 明示したスペース (ペインのスペースではない worktree) を全文置換する
		const written = await call(channel, { op: 'write', space: WORKTREE_KEY, text: '# New\n- [ ] fresh' });
		assert.deepStrictEqual(written, {
			ok: true,
			kind: 'note',
			note: {
				space: WORKTREE_KEY,
				// allow-any-unicode-next-line
				name: 'para-code ✦ feature',
				text: '# New\n- [ ] fresh',
				lines: [
					{ line: 0, kind: 'heading', text: 'New' },
					{ line: 1, kind: 'task', text: 'fresh', done: false },
				],
				open: 1,
				done: 0,
			},
			replaced: '- [x] old plan',
		});
		assert.strictEqual(notes.read('repo-1'), '');

		const cleared = await call(channel, { op: 'write', space: WORKTREE_KEY, text: '' });
		assert.strictEqual(cleared.ok && cleared.kind === 'note' && cleared.note.text, '');
		assert.strictEqual(notes.notes.has(WORKTREE_KEY), false);
	});

	test('reports writes the notes service silently dropped', async () => {
		const notes = new FakeSpaceNotesService();
		notes.refuseWrites = true;
		const channel = createChannel(notes, { paneStateKey: 'repo-1' });

		const written = await call(channel, { op: 'write', text: '- [ ] never stored' });
		assert.strictEqual(written.ok, false);

		const added = await call(channel, { op: 'addTask', task: 'never stored' });
		assert.strictEqual(added.ok, false);
	});
});
