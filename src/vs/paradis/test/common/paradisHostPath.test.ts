/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { paradisHostPathFor, paradisResolveHostPath } from '../../common/paradisHostPath.js';

const REMOTE_AUTHORITY = 'ssh-remote+host';

suite('paradisResolveHostPath', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const connection = { remoteAuthority: REMOTE_AUTHORITY };
	const localRepo = URI.file('/home/local/repo');
	const remoteRepo = URI.parse(`vscode-remote://${REMOTE_AUTHORITY}/home/remote/repo`);

	test('spells a file resource with fsPath and a matching vscode-remote resource with the raw POSIX path', () => {
		assert.deepStrictEqual(
			[paradisResolveHostPath(localRepo, connection), paradisResolveHostPath(remoteRepo, connection)],
			[
				{ host: 'local', path: localRepo.fsPath },
				// 接続先のパスは接続先の流儀のまま。ここで fsPath を使うと、Windows から Linux の
				// 接続先へ繋いでいるときに /home/remote/repo が \home\remote\repo に化ける。
				{ host: 'remote', path: '/home/remote/repo' },
			]);
	});

	test('a file resource still resolves to local when there is no connection', () => {
		assert.deepStrictEqual(paradisResolveHostPath(localRepo, undefined), { host: 'local', path: localRepo.fsPath });
	});

	test('matches the authority case-insensitively on both sides, so callers never have to lower-case the connection themselves', () => {
		assert.deepStrictEqual(
			[
				paradisResolveHostPath(URI.parse('vscode-remote://SSH-Remote+Host/home/remote/repo'), connection),
				// 接続側が大文字混じりのまま渡されても揃う（呼び出し元での toLowerCase は不要）。
				paradisResolveHostPath(remoteRepo, { remoteAuthority: 'SSH-Remote+Host' }),
			],
			[
				{ host: 'remote', path: '/home/remote/repo' },
				{ host: 'remote', path: '/home/remote/repo' },
			]);
	});

	test('returns undefined for anything whose machine is not confirmed — never falls back to the local spelling', () => {
		// 未接続なのに vscode-remote / 別ホストの vscode-remote / file・vscode-remote 以外のスキーム。
		// 手元へ倒すと、絶対パスが一致する構成で無関係な手元のリソースを読み書きしてしまう。
		assert.deepStrictEqual(
			[
				paradisResolveHostPath(remoteRepo, undefined),
				paradisResolveHostPath(URI.parse('vscode-remote://ssh-remote+other/home/remote/repo'), connection),
				paradisResolveHostPath(URI.parse('untitled:Untitled-1'), connection),
				paradisResolveHostPath(URI.parse('vscode-vfs://github/owner/repo'), connection),
			],
			[undefined, undefined, undefined, undefined]);
	});

	test('paradisHostPathFor spells by the destination machine, not by the scheme — a resource routed to local keeps the local spelling', () => {
		// 解決できない vscode-remote を承知で手元へ流す縮退運用（読み取り専用）の綴り。
		assert.deepStrictEqual(
			[paradisHostPathFor(remoteRepo, 'local'), paradisHostPathFor(remoteRepo, 'remote')],
			[remoteRepo.fsPath, '/home/remote/repo']);
	});
});
