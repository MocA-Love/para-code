/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains a PARA-CODE comment)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_WORKTREE_IMAGE_MAX_BYTES, paradisAgentImageMode, paradisCheckWorktreeImages, paradisWorktreeImageFileName, paradisWorktreeImageMime } from '../../common/paradisWorktreeImageAttach.js';

suite('paradisWorktreeImageAttach', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts up to 8 images of at most 10 MB in PNG, JPEG, GIF and WebP only', () => {
		const png = (name: string, size = 1000) => ({ name, type: 'image/png', size });
		const check = paradisCheckWorktreeImages(6, [
			{ name: 'spec.pdf', type: 'application/pdf', size: 10 },
			png('a.png'),
			{ name: 'raw.png', type: 'image/png', size: PARADIS_WORKTREE_IMAGE_MAX_BYTES + 1 },
			{ name: 'b.jpg', type: 'image/jpeg', size: PARADIS_WORKTREE_IMAGE_MAX_BYTES },
			png('c.png'),
			{ name: 'd.svg', type: 'image/svg+xml', size: 10 },
		]);
		assert.deepStrictEqual(check, {
			accepted: [{ index: 1, mime: 'image/png' }, { index: 3, mime: 'image/jpeg' }],
			rejected: [{ index: 0, reason: 'type' }, { index: 2, reason: 'size' }, { index: 4, reason: 'count' }, { index: 5, reason: 'type' }],
		});
	});

	test('reads the format from the extension only when the file has no type', () => {
		assert.deepStrictEqual([
			paradisWorktreeImageMime('', 'Shot.JPEG'),
			paradisWorktreeImageMime('', 'anim.gif'),
			paradisWorktreeImageMime('', 'noext'),
			paradisWorktreeImageMime('text/plain', 'looks.png'),
			paradisWorktreeImageMime('IMAGE/WEBP', 'x'),
		], ['image/jpeg', 'image/gif', undefined, undefined, 'image/webp']);
	});

	test('names the files <time>-<order>.<extension of the content>', () => {
		assert.deepStrictEqual([
			paradisWorktreeImageFileName(1762876411000, 0, 'image/png'),
			paradisWorktreeImageFileName(1762876411000.7, 1, 'image/jpeg'),
			paradisWorktreeImageFileName(1762876411000, 7, 'image/webp'),
		], ['1762876411000-1.png', '1762876411000-2.jpg', '1762876411000-8.webp']);
	});

	test('passes images as @ mentions to Claude Code and added agents, by flag to Codex, and not to Gemini CLI or no agent', () => {
		assert.deepStrictEqual(
			['claude', 'codex', 'gemini', 'none', undefined, 'my-agent'].map(paradisAgentImageMode),
			['mention', 'flag', 'unsupported', 'unsupported', 'unsupported', 'mention'],
		);
	});
});
