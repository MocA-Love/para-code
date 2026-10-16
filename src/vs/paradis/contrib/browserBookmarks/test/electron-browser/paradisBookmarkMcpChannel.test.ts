/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ParadisAgentApprovalOutcome } from '../../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { ParadisBookmarkNode } from '../../common/paradisBookmarkModel.js';
import { ParadisBookmarkToolResult } from '../../common/paradisBookmarkTools.js';
import { IParadisBookmarkNotice, ParadisBookmarkMcpChannel } from '../../electron-browser/paradisBookmarkMcpChannel.js';
import { ParadisBookmarksService } from '../../electron-browser/paradisBookmarksService.js';

/** 木を「id:題名」と入れ子の括弧で表す（並びとフォルダの中身を 1 行で比べる）。 */
function shape(nodes: readonly ParadisBookmarkNode[], ids: Map<string, string>): string {
	return nodes.map(node => `${ids.get(node.id) ?? node.id}:${node.title}${node.type === 'folder' ? `[${shape(node.children, ids)}]` : ''}`).join(',');
}

/** 題名だけで木を表す。 */
function titles(nodes: readonly ParadisBookmarkNode[]): string {
	return nodes.map(node => `${node.title}${node.type === 'folder' ? `[${titles(node.children)}]` : ''}`).join(',');
}

function data(result: ParadisBookmarkToolResult): Record<string, Record<string, unknown>> {
	assert.ok(result.ok, result.ok ? '' : result.error);
	return result.data as Record<string, Record<string, unknown>>;
}

function error(result: ParadisBookmarkToolResult): string {
	return result.ok ? 'ok' : result.error;
}

suite('ParadisBookmarkMcpChannel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** `answers` は削除の確認のダイアログの答え（順に使う）。 */
	function setup(answers: ParadisAgentApprovalOutcome[] = []) {
		const service = store.add(new ParadisBookmarksService(store.add(new InMemoryStorageService())));
		const notices: IParadisBookmarkNotice[] = [];
		const dialogs: string[][] = [];
		const channel = new ParadisBookmarkMcpChannel(service, notice => notices.push(notice), token => token === 'pane-a' ? 'claude' : undefined, async (_token, request) => {
			dialogs.push([request.messageTemplate('pane'), ...request.detail]);
			return answers.shift() ?? 'cancelled';
		});
		return { service, notices, dialogs, channel };
	}

	test('adds, creates nested folders, renames by id and moves, and tells the user each time', async () => {
		const { service, notices, channel } = setup();
		const first = data(await channel.handle('pane-a', { op: 'add', url: 'https://same.example/a', title: 'Same', folderId: null })).bookmark.id as string;
		const second = data(await channel.handle('pane-a', { op: 'add', url: 'https://same.example/b', title: 'Same', folderId: null })).bookmark.id as string;
		const docs = data(await channel.handle('pane-a', { op: 'createFolder', title: 'Docs', folderId: null })).created.id as string;
		const inner = data(await channel.handle('pane-a', { op: 'createFolder', title: 'Inner', folderId: docs })).created.id as string;
		// 同じ題名の 2 つ目だけを id で変える
		data(await channel.handle('pane-a', { op: 'rename', id: second, title: 'Second' }));
		const moved = data(await channel.handle('unknown-pane', { op: 'move', id: first, folderId: inner, index: 0 }));
		const again = data(await channel.handle('pane-a', { op: 'add', url: 'https://same.example/a', title: 'Again', folderId: null }));
		const ids = new Map([[first, 'b1'], [second, 'b2'], [docs, 'docs'], [inner, 'inner']]);
		assert.deepStrictEqual({
			tree: shape(service.nodes, ids),
			moved: { ...moved, moved: { ...moved.moved, id: ids.get(moved.moved.id as string), folder_id: ids.get(moved.moved.folder_id as string) } },
			again: { added: again.added, id: ids.get(again.bookmark.id as string) },
			notices: notices.map(notice => `${notice.silent ? 'silent' : 'shown'}: ${notice.message}`),
		}, {
			tree: 'b2:Second,docs:Docs[inner:Inner[b1:Same]]',
			moved: { moved: { id: 'b1', type: 'bookmark', title: 'Same', url: 'https://same.example/a', folder_id: 'inner' }, index: 0 },
			again: { added: false, id: 'b1' },
			notices: [
				'silent: ターミナル「claude」のエージェントがブックマーク「Same」を追加しました。',
				'silent: ターミナル「claude」のエージェントがブックマーク「Same」を追加しました。',
				'silent: ターミナル「claude」のエージェントがブックマークのフォルダ「Docs」を作りました。',
				'silent: ターミナル「claude」のエージェントがブックマークのフォルダ「Inner」を作りました。',
				'silent: ターミナル「claude」のエージェントがブックマーク「Same」の名前を「Second」に変えました。',
				'silent: ターミナル「不明」のエージェントがブックマーク「Same」をフォルダ「Inner」へ移しました。',
			],
		});
	});

	test('deletes only after the user approves, needs recursive for a folder with contents, and undoes to the same place', async () => {
		const { service, notices, dialogs, channel } = setup(['denied', 'approve']);
		service.addBookmark({ url: 'https://a.example', title: 'A' });
		const folder = service.addFolder({ title: 'Docs' });
		service.addBookmark({ url: 'https://b.example', title: 'B', folderId: folder.id });
		service.addFolder({ title: 'Inner', parentFolderId: folder.id });
		service.addBookmark({ url: 'https://c.example', title: 'C' });
		const notRecursive = error(await channel.handle('pane-a', { op: 'delete', id: folder.id, recursive: false }));
		const denied = error(await channel.handle('pane-a', { op: 'delete', id: folder.id, recursive: true }));
		const approved = data(await channel.handle('pane-a', { op: 'delete', id: folder.id, recursive: true }));
		const afterDelete = titles(service.nodes);
		notices[0].undo?.();
		assert.deepStrictEqual({
			notRecursive,
			denied,
			approved: { ...approved, deleted: { ...approved.deleted, id: approved.deleted.id === folder.id } },
			afterDelete,
			restored: titles(service.nodes),
			dialogs,
			notices: notices.map(notice => `${notice.silent ? 'silent' : 'shown'}${notice.undo ? ' with undo' : ''}: ${notice.message}`),
		}, {
			notRecursive: 'That folder contains 1 bookmarks and 1 folders. Pass "recursive": true to delete it with everything inside, after checking with list_bookmarks that this is what the user wants.',
			denied: 'The user declined to delete it. Do not ask again for this; ask the user in the conversation if needed.',
			approved: { deleted: { id: true, type: 'folder', title: 'Docs', folder_id: null }, bookmarks_deleted: 1, folders_deleted: 2, note: 'The user can undo this from the notification.' },
			afterDelete: 'A,C',
			restored: 'A,Docs[B,Inner[]],C',
			dialogs: [
				['pane のエージェントが、ブックマークのフォルダ「Docs」を削除しようとしています', 'フォルダの中のブックマーク 1 件とフォルダ 1 個も一緒に削除されます。', '削除した後に出る通知の「元に戻す」で、元の場所へ戻せます。'],
				['pane のエージェントが、ブックマークのフォルダ「Docs」を削除しようとしています', 'フォルダの中のブックマーク 1 件とフォルダ 1 個も一緒に削除されます。', '削除した後に出る通知の「元に戻す」で、元の場所へ戻せます。'],
			],
			notices: ['shown with undo: ターミナル「claude」のエージェントがブックマークを 3 件削除しました（「Docs」）。'],
		});
	});

	test('refuses unknown ids, a missing folder, moving a folder into itself and malformed requests, without asking or telling the user', async () => {
		const { service, notices, dialogs, channel } = setup();
		const folder = service.addFolder({ title: 'Docs' });
		const child = service.addFolder({ title: 'Child', parentFolderId: folder.id });
		const errors = [
			await channel.handle('pane-a', { op: 'rename', id: 'nowhere', title: 'x' }),
			await channel.handle('pane-a', { op: 'move', id: folder.id, folderId: child.id }),
			await channel.handle('pane-a', { op: 'add', url: 'https://a.example', title: 'A', folderId: 'nowhere' }),
			await channel.handle('pane-a', { op: 'list', folderId: 'nowhere' }),
			await channel.handle('pane-a', { op: 'delete', id: 'nowhere', recursive: true }),
			await channel.call<ParadisBookmarkToolResult>(undefined, 'bookmarks', ['pane-a', { op: 'add', url: 'javascript:alert(1)', title: 'x', folderId: null }]),
			await channel.call<ParadisBookmarkToolResult>(undefined, 'bookmarks', ['pane-a', { op: 'delete', id: folder.id }]),
		].map(error);
		assert.deepStrictEqual({ errors, notices, dialogs, folders: service.nodes.length }, {
			errors: [
				'No bookmark or folder has that "id". Call list_bookmarks for the current ids.',
				'A folder cannot move into itself or into one of its own folders.',
				'"folder_id" is not a folder. Call list_bookmarks for the current folder ids.',
				'"folder_id" is not a folder. Call list_bookmarks for the current folder ids.',
				'No bookmark or folder has that "id". Call list_bookmarks for the current ids.',
				'"url" must be an http or https URL.',
				'Para Code received a malformed bookmark request.',
			],
			notices: [],
			dialogs: [],
			folders: 1,
		});
	});
});
