/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test fixtures)

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBuildAgentCommandCatalog } from '../../node/paradisAgentCommandCatalog.js';

suite('ParadisAgentCommandCatalog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let userHome: string;
	let claudeConfigDir: string;
	let codexHome: string;
	let cwd: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-agent-commands-'));
		userHome = join(root, 'home');
		claudeConfigDir = join(userHome, '.claude');
		codexHome = join(userHome, '.codex');
		cwd = join(root, 'repo', 'packages', 'mobile');
		await Promise.all([
			fs.mkdir(join(root, 'repo', '.git'), { recursive: true }),
			fs.mkdir(cwd, { recursive: true }),
		]);
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test('combines Claude built-ins with user and project skills and legacy commands', async () => {
		await Promise.all([
			write(join(claudeConfigDir, 'skills', 'aivis', 'SKILL.md'), '---\ndescription: Aivisで音声報告\n---\n本文'),
			write(join(claudeConfigDir, 'skills', 'hidden', 'SKILL.md'), '---\ndescription: hidden\nuser-invocable: false\n---\n本文'),
			write(join(claudeConfigDir, 'commands', 'team', 'review.md'), '---\ndescription: チームレビュー\nargument-hint: "[PR]"\n---\n本文'),
			write(join(root, 'repo', '.claude', 'skills', 'project-check', 'SKILL.md'), '---\nname: project-check\ndescription: プロジェクト検査\n---\n本文'),
			write(join(root, 'repo', '.claude', 'commands', 'aivis.md'), '---\ndescription: 重複するプロジェクトコマンド\n---\n本文'),
		]);

		const catalog = await paradisBuildAgentCommandCatalog('claude', cwd, { userHome, claudeConfigDir, codexHome });
		assert.ok(catalog.some(item => item.name === 'model' && item.source === 'built-in'));
		assert.deepStrictEqual(catalog.find(item => item.name === 'aivis'), {
			name: 'aivis', insertText: '/aivis', description: 'Aivisで音声報告', kind: 'skill', source: 'user',
		});
		assert.deepStrictEqual(catalog.find(item => item.name === 'team:review'), {
			name: 'team:review', insertText: '/team:review', description: 'チームレビュー', argumentHint: '[PR]', kind: 'command', source: 'user',
		});
		assert.ok(catalog.some(item => item.name === 'project-check' && item.source === 'project'));
		assert.strictEqual(catalog.some(item => item.name === 'hidden'), false);
		assert.strictEqual(catalog.filter(item => item.name === 'aivis').length, 1);
	});

	test('exposes Codex prompts and skills through slash-facing insertion text', async () => {
		await Promise.all([
			write(join(codexHome, 'prompts', 'draft-pr.md'), '---\ndescription: Draft PRを作成\nargument-hint: FILES=\n---\n本文'),
			write(join(codexHome, 'skills', 'aivis', 'SKILL.md'), '---\nname: aivis\ndescription: 音声報告\n---\n本文'),
			write(join(userHome, '.agents', 'skills', 'global-check', 'SKILL.md'), '---\ndescription: グローバル検査\n---\n本文'),
			write(join(root, 'repo', '.agents', 'skills', 'project-check', 'SKILL.md'), '---\ndescription: プロジェクト検査\n---\n本文'),
		]);

		const catalog = await paradisBuildAgentCommandCatalog('codex', cwd, { userHome, claudeConfigDir, codexHome });
		assert.ok(catalog.some(item => item.name === 'fast' && item.source === 'built-in'));
		assert.deepStrictEqual(catalog.find(item => item.name === 'prompts:draft-pr'), {
			name: 'prompts:draft-pr', insertText: '/prompts:draft-pr', description: 'Draft PRを作成', argumentHint: 'FILES=', kind: 'prompt', source: 'user',
		});
		for (const name of ['aivis', 'global-check', 'project-check']) {
			const item = catalog.find(candidate => candidate.name === name);
			assert.strictEqual(item?.kind, 'skill');
			assert.strictEqual(item?.insertText, `/${name}`);
		}
	});

	test('bounds the returned catalog', async () => {
		const catalog = await paradisBuildAgentCommandCatalog('codex', cwd, { userHome, claudeConfigDir, codexHome, maxItems: 3 });
		assert.strictEqual(catalog.length, 3);
	});

	test('does not scan parent project directories when cwd is outside a git repository', async () => {
		const standalone = join(root, 'standalone');
		await Promise.all([
			write(join(standalone, '.agents', 'skills', 'local-check', 'SKILL.md'), '---\ndescription: ローカル検査\n---\n本文'),
			write(join(root, '.agents', 'skills', 'parent-leak', 'SKILL.md'), '---\ndescription: 親設定\n---\n本文'),
		]);

		const catalog = await paradisBuildAgentCommandCatalog('codex', standalone, { userHome, claudeConfigDir, codexHome });
		assert.ok(catalog.some(item => item.name === 'local-check' && item.source === 'project'));
		assert.strictEqual(catalog.some(item => item.name === 'parent-leak'), false);
	});
});

async function write(path: string, content: string): Promise<void> {
	await fs.mkdir(join(path, '..'), { recursive: true });
	await fs.writeFile(path, content);
}
