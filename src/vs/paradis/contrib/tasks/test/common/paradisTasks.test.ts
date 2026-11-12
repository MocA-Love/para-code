/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisTasksApplyInsteadOf, paradisTasksBuildSearchQuery, paradisTasksGithubRepositoryFromRemote, paradisTasksHasQualifier, paradisTasksSettle, paradisTasksToggleQualifier, paradisTasksTokenize } from '../../common/paradisTasks.js';

suite('ParadisTasks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// github.com の remote だけを owner/name にし、表記の大文字小文字は remote のまま残す
	test('reads owner/name from github.com remotes only', () => {
		assert.deepStrictEqual([
			'git@github.com:MocA-Love/Para-Code.git',
			'https://github.com/owner/repo',
			'ssh://git@github.com:22/owner/repo.git',
			'https://x-access-token:secret@github.com/owner/repo.git',
			'git@github.example.com:owner/repo.git',
			'https://gitlab.com/owner/repo',
			'/srv/git/repo.git',
		].map(paradisTasksGithubRepositoryFromRemote), [
			'MocA-Love/Para-Code',
			'owner/repo',
			'owner/repo',
			'owner/repo',
			undefined,
			undefined,
			undefined,
		]);
	});

	// 短縮名の origin は、同じ config の insteadOf（前方一致のいちばん長いもの）で git が使う URL に戻してから読む
	test('reads a shorthand origin through insteadOf in the same config', () => {
		const config = [
			'[remote "origin"]',
			'\turl = gh:MocA-Love/Para-Code',
			'[url "git@github.com:"]',
			'\tinsteadOf = gh:',
			'[url "https://github.com/work-org/"]',
			'\tinsteadOf = gh:work/',
			'[url "https://gitlab.com/"]',
			'\tinsteadOf = gl:',
		].join('\n');
		assert.deepStrictEqual([
			'gh:MocA-Love/Para-Code',
			'gh:work/repo',
			'gl:owner/repo',
			'git@github.com:owner/repo.git',
		].map(url => paradisTasksGithubRepositoryFromRemote(paradisTasksApplyInsteadOf(url, config))), [
			'MocA-Love/Para-Code',
			'work-org/repo',
			undefined,
			'owner/repo',
		]);
	});

	// モードとリポジトリを付け直し、人が書いた repo:・org:・is:pr の取り違えは外す
	test('builds the GitHub search query', () => {
		assert.deepStrictEqual([
			paradisTasksBuildSearchQuery('issue', 'is:issue is:open', ['a/b', 'c/d']),
			paradisTasksBuildSearchQuery('pr', 'is:issue  is:open repo:evil/x org:other label:"good first issue"', ['a/b']),
			paradisTasksBuildSearchQuery('issue', '', ['a/b', 'bad name', 'x/y repo:z/w']),
		], [
			'is:issue is:open repo:a/b repo:c/d archived:false',
			'is:pr is:open label:"good first issue" repo:a/b archived:false',
			'is:issue repo:a/b archived:false',
		]);
	});

	test('tokenizes and toggles qualifiers', () => {
		assert.deepStrictEqual({
			tokens: paradisTasksTokenize('is:open label:"needs triage" foo'),
			add: paradisTasksToggleQualifier('is:issue is:open', 'is:closed', ['is:open']),
			remove: paradisTasksToggleQualifier('is:issue is:open assignee:@me', 'assignee:@me'),
			has: paradisTasksHasQualifier('is:issue IS:OPEN', 'is:open'),
		}, {
			tokens: ['is:open', 'label:"needs triage"', 'foo'],
			add: 'is:issue is:closed',
			remove: 'is:issue is:open',
			has: true,
		});
	});

	test('turns a rejected request into a failed response', async () => {
		assert.deepStrictEqual(await paradisTasksSettle(() => Promise.reject(new Error('channel closed'))), {
			ok: false,
			error: { kind: 'failed', message: 'channel closed' },
		});
	});
});
