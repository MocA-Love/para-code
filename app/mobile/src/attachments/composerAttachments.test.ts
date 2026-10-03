// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	appendComposerAttachments,
	composerAttachmentSendState,
	composerAttachmentsOf,
	patchComposerAttachment,
	restoreComposerAttachments,
	setComposerAttachments,
	type ComposerAttachment,
} from './composerAttachments.js';

function item(id: string, status: ComposerAttachment['status'], path?: string): ComposerAttachment {
	return { id, previewUri: `file:///tmp/${id}.jpg`, fileName: `${id}.jpg`, status, ...(path !== undefined ? { path } : {}) };
}

describe('composerAttachments', () => {
	test('送れるかは「上げている途中 → 失敗 → 送れる」の順で決め、送るパスは選んだ順', () => {
		expect([
			composerAttachmentSendState([item('a', 'ready', '/p/a'), item('b', 'uploading')]),
			composerAttachmentSendState([item('a', 'ready', '/p/a'), item('b', 'failed'), item('c', 'ready', '/p/c')]),
			composerAttachmentSendState([item('a', 'ready', '/p/a'), item('c', 'ready', '/p/c')]),
			composerAttachmentSendState([]),
		]).toEqual([
			{ kind: 'uploading', uploading: 1, total: 2 },
			{ kind: 'failed', failed: 1, paths: ['/p/a', '/p/c'] },
			{ kind: 'ok', paths: ['/p/a', '/p/c'] },
			{ kind: 'ok', paths: [] },
		]);
	});

	test('上限 5 枚を超えた分は足さない。戻すときは前へ、重複させない', () => {
		const four = ['a', 'b', 'c', 'd'].map(id => item(id, 'ready', `/p/${id}`));
		const appended = appendComposerAttachments(four, [item('e', 'uploading'), item('f', 'uploading')]);
		expect({
			next: appended.next.map(entry => entry.id),
			accepted: appended.accepted.map(entry => entry.id),
			restored: restoreComposerAttachments([item('x', 'uploading'), item('a', 'ready')], [item('a', 'ready'), item('b', 'ready')]).map(entry => entry.id),
		}).toEqual({ next: ['a', 'b', 'c', 'd', 'e'], accepted: ['e'], restored: ['b', 'x', 'a'] });
	});

	test('一覧は入力欄ごとに持ち、空にすると消える。外した後の更新は何もしない', () => {
		setComposerAttachments('draft-1', () => [item('a', 'uploading')]);
		patchComposerAttachment('draft-1', 'a', { status: 'ready', path: '/p/a' });
		const afterPatch = composerAttachmentsOf('draft-1').map(entry => [entry.id, entry.status, entry.path]);
		setComposerAttachments('draft-1', () => []);
		patchComposerAttachment('draft-1', 'a', { status: 'failed' });
		expect({ afterPatch, afterClear: composerAttachmentsOf('draft-1'), other: composerAttachmentsOf('draft-2') }).toEqual({
			afterPatch: [['a', 'ready', '/p/a']],
			afterClear: [],
			other: [],
		});
	});
});
