/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCloneOverallPercent, paradisParseCloneProgressLine, paradisParseGitUrl } from '../../common/paradisRepositoryClone.js';

suite('ParadisRepositoryClone', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses repository names from https/ssh/git/scp-like URLs', () => {
		assert.deepStrictEqual(
			[
				'https://github.com/yusukebe/ax',
				'https://github.com/yusukebe/ax.git',
				'https://github.com/yusukebe/ax/',
				'  https://github.com/yusukebe/ax.git  ',
				'ssh://git@github.com/yusukebe/ax.git',
				'git://github.com/yusukebe/ax.git',
				'git@github.com:yusukebe/ax.git',
				'git@github.com:yusukebe/ax',
				'org-123@ssh.dev.azure.com:v3/org/project/repo',
			].map(url => paradisParseGitUrl(url)?.name),
			['ax', 'ax', 'ax', 'ax', 'ax', 'ax', 'ax', 'ax', 'repo']
		);
	});

	test('does not throw on malformed percent-encoding and falls back to the raw path', () => {
		assert.strictEqual(paradisParseGitUrl('https://github.com/foo%zz/bar')?.name, 'bar');
		assert.strictEqual(paradisParseGitUrl('https://github.com/%'), undefined);
	});

	test('rejects values that are not remote Git URLs', () => {
		for (const value of [
			'',
			'   ',
			'ax',
			'/tmp/repo',
			'C:\\Users\\example\\repo',
			'github.com/yusukebe/ax',
			'https://',
			'https://github.com/',
			'https://github.com/..',
			'https://github.com/...',
			'git@github.com:',
			'https://github.com/user/re po',
			`https://github.com/u/${'x'.repeat(3000)}`,
		]) {
			assert.strictEqual(paradisParseGitUrl(value), undefined, JSON.stringify(value));
		}
	});

	test('parses git clone --progress stderr lines', () => {
		assert.deepStrictEqual(
			[
				'Receiving objects:  62% (1204/1943), 5.02 MiB | 2.11 MiB/s',
				'remote: Counting objects: 100% (1943/1943), done.',
				'Resolving deltas:   0% (0/812)',
				'Cloning into \'/tmp/ax\'...',
				'fatal: repository not found',
			].map(line => paradisParseCloneProgressLine(line)),
			[
				{ stage: 'Receiving objects', percent: 62 },
				{ stage: 'Counting objects', percent: 100 },
				{ stage: 'Resolving deltas', percent: 0 },
				undefined,
				undefined,
			]
		);
	});

	test('maps stage percentages onto a monotonic overall percent', () => {
		assert.deepStrictEqual(
			[
				paradisCloneOverallPercent('Counting objects', 0),
				paradisCloneOverallPercent('Receiving objects', 0),
				paradisCloneOverallPercent('Receiving objects', 50),
				paradisCloneOverallPercent('Receiving objects', 100),
				paradisCloneOverallPercent('Resolving deltas', 100),
				paradisCloneOverallPercent('Updating files', 100),
				paradisCloneOverallPercent('unknown stage', 50),
			],
			[3, 10, 48, 85, 95, 100, undefined]
		);
	});
});
