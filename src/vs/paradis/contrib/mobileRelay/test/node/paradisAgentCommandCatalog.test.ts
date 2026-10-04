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
import { paradisBuildAgentCommandCatalog, paradisBuiltInAgentCommands, paradisCodexSupportsCustomPrompts, paradisLegacyAgentCommandCatalog, paradisNormalizeModCommandList, paradisParseCommandFrontMatter } from '../../node/paradisAgentCommandCatalog.js';

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
		// 同じ名前は両方を残し、先に出した方（ユーザーの skill）が動く
		assert.deepStrictEqual(catalog.filter(item => item.name === 'aivis').map(item => item.source), ['user', 'project']);
	});

	test('puts user and project commands before the built-ins of the same name, as Claude Code runs them', async () => {
		await write(join(root, 'repo', '.claude', 'commands', 'context.md'), '---\ndescription: 自作の context\n---\n本文');
		const catalog = await paradisBuildAgentCommandCatalog('claude', cwd, { userHome, claudeConfigDir, codexHome });
		const legacy = paradisLegacyAgentCommandCatalog(catalog);
		assert.deepStrictEqual({
			full: catalog.filter(item => item.name === 'context').map(item => item.source),
			legacy: legacy.filter(item => item.name === 'context').map(item => [item.source, item.description]),
		}, {
			full: ['project', 'built-in'],
			legacy: [['project', '自作の context']],
		});
	});

	test('reads only the front matter: a long skill stays, and folded or multi-line values are read whole', async () => {
		await Promise.all([
			write(join(claudeConfigDir, 'skills', 'long', 'SKILL.md'), `---\nname: long\ndescription: >\n  a folded\n  description\nargument-hint: |\n  [file]\n---\n${'x'.repeat(40 * 1024)}`),
			write(join(claudeConfigDir, 'skills', 'plain', 'SKILL.md'), '---\ndescription: first line\n  continued here\nallowed-tools:\n  - Bash\n---\n本文'),
			write(join(claudeConfigDir, 'skills', 'nofront', 'SKILL.md'), '# 見出し\n\n最初の段落です。\n\n次の段落'),
		]);
		const catalog = await paradisBuildAgentCommandCatalog('claude', cwd, { userHome, claudeConfigDir, codexHome });
		assert.deepStrictEqual(catalog.filter(item => ['long', 'plain', 'nofront'].includes(item.name)).map(item => [item.name, item.description, item.argumentHint]), [
			['long', 'a folded description', '[file]'],
			['nofront', '最初の段落です。', undefined],
			['plain', 'first line continued here', undefined],
		]);
	});

	test('parses quoted values, comments and an unclosed front matter', () => {
		assert.deepStrictEqual({
			quoted: [...paradisParseCommandFrontMatter('---\ndescription: "Use # tags"\nname: x # comment\n---\nbody').attributes],
			unclosed: paradisParseCommandFrontMatter('---\ndescription: never closed\n').body,
		}, {
			quoted: [['description', 'Use # tags'], ['name', 'x']],
			unclosed: '',
		});
	});

	test('adds the commands and skills of enabled plugins, named after the plugin', async () => {
		const enabledPath = join(userHome, 'plugin-cache', 'tools');
		const disabledPath = join(userHome, 'plugin-cache', 'off');
		const otherProjectPath = join(userHome, 'plugin-cache', 'elsewhere');
		await Promise.all([
			write(join(claudeConfigDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
				version: 2, plugins: {
					'tools@market': [{ scope: 'user', installPath: enabledPath }],
					'off@market': [{ scope: 'user', installPath: disabledPath }],
					'elsewhere@market': [{ scope: 'project', projectPath: join(root, 'another'), installPath: otherProjectPath }],
				},
			})),
			write(join(claudeConfigDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'tools@market': true, 'off@market': true, 'elsewhere@market': true } })),
			write(join(root, 'repo', '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'off@market': false } })),
			write(join(enabledPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tools' })),
			write(join(enabledPath, 'commands', 'lint.md'), '---\ndescription: Lint\n---\n'),
			write(join(enabledPath, 'skills', 'fix', 'SKILL.md'), '---\ndescription: Fix\n---\n'),
			write(join(disabledPath, 'commands', 'nope.md'), '---\ndescription: Off\n---\n'),
			write(join(otherProjectPath, 'commands', 'far.md'), '---\ndescription: Far\n---\n'),
		]);
		const catalog = await paradisBuildAgentCommandCatalog('claude', cwd, { userHome, claudeConfigDir, codexHome });
		assert.deepStrictEqual(catalog.filter(item => item.source === 'plugin'), [
			{ name: 'tools:lint', insertText: '/tools:lint', description: 'Lint', kind: 'command', source: 'plugin', plugin: 'tools' },
			{ name: 'tools:fix', insertText: '/tools:fix', description: 'Fix', kind: 'skill', source: 'plugin', plugin: 'tools' },
		]);
	});

	test('takes the list from the mod in its order, without internal commands, and narrows it for older apps', () => {
		const listed = paradisNormalizeModCommandList([
			{ name: 'context', description: 'mine', source: 'user' },
			{ name: 'codex:rescue', description: 'Rescue', source: 'plugin', plugin: 'codex' },
			{ name: 'mcp__docs__summarize', description: 'Summarize', source: 'mcp' },
			{ name: '__remote-workflow', description: 'internal', source: 'builtin' },
			{ name: 'bad name', description: 'x', source: 'user' },
			{ name: 'context', description: 'Visualize', source: 'builtin' },
		]);
		assert.deepStrictEqual({
			listed: listed?.map(item => [item.name, item.source, item.plugin]),
			legacy: paradisLegacyAgentCommandCatalog(listed ?? []).map(item => [item.name, item.source]),
			notArray: paradisNormalizeModCommandList({}),
		}, {
			listed: [['context', 'user', undefined], ['codex:rescue', 'plugin', 'codex'], ['mcp__docs__summarize', 'mcp', undefined], ['context', 'built-in', undefined]],
			legacy: [['context', 'user'], ['codex:rescue', 'user'], ['mcp__docs__summarize', 'user']],
			notArray: undefined,
		});
	});

	test('keeps the built-ins that run when many skills overflow the limit, for new and old apps', async function () {
		// 850 個の skill をファイルに書いて読む
		this.timeout(60_000);
		const essentials = ['clear', 'model', 'compact'];
		const has = (items: readonly { name: string; source: string }[], name: string) => items.filter(item => item.name === name).map(item => item.source);
		const results: Record<string, unknown> = {};
		for (const count of [250, 600]) {
			const config = join(root, `config-${count}`);
			await Promise.all(Array.from({ length: count }, (_, index) => write(join(config, 'skills', `skill-${String(index).padStart(3, '0')}`, 'SKILL.md'), `---\ndescription: skill ${index}\n---\n`)));
			// 自作の `model` は組み込みの `model` を隠す（隠された組み込みは枠を取らない）
			await write(join(config, 'skills', 'model', 'SKILL.md'), '---\ndescription: my model\n---\n');
			const full = await paradisBuildAgentCommandCatalog('claude', cwd, { userHome, claudeConfigDir: config, codexHome });
			const legacy = paradisLegacyAgentCommandCatalog(full);
			const listed = paradisNormalizeModCommandList([
				...Array.from({ length: count }, (_, index) => ({ name: `skill-${index}`, description: '', source: 'user' })),
				{ name: 'model', description: 'my model', source: 'user' },
				...['clear', 'model', 'compact', 'context'].map(name => ({ name, description: '', source: 'builtin' })),
			]) ?? [];
			results[count] = {
				full: { size: full.length, essentials: essentials.map(name => has(full, name)) },
				legacy: { size: legacy.length, essentials: essentials.map(name => has(legacy, name)) },
				mod: { size: listed.length, essentials: essentials.map(name => has(listed, name)) },
			};
		}
		const builtIns = paradisBuiltInAgentCommands('claude').length;
		assert.deepStrictEqual(results, {
			250: {
				full: { size: 251 + builtIns, essentials: [['built-in'], ['user', 'built-in'], ['built-in']] },
				legacy: { size: 200, essentials: [['built-in'], ['user'], ['built-in']] },
				mod: { size: 255, essentials: [['built-in'], ['user', 'built-in'], ['built-in']] },
			},
			600: {
				full: { size: 500, essentials: [['built-in'], ['user'], ['built-in']] },
				legacy: { size: 200, essentials: [['built-in'], ['user'], ['built-in']] },
				// 枠は組み込みが先に取る。残りは効く順に埋めるので、後ろにある自作の `model` は入らない
				mod: { size: 500, essentials: [['built-in'], [], ['built-in']] },
			},
		});
	});

	test('leaves out Codex custom prompts from 0.160 on', async () => {
		await write(join(codexHome, 'prompts', 'draft-pr.md'), '---\ndescription: Draft\n---\n');
		const newer = await paradisBuildAgentCommandCatalog('codex', cwd, { userHome, claudeConfigDir, codexHome, codexVersion: '0.160.0' });
		assert.deepStrictEqual({
			newer: newer.some(item => item.name === 'prompts:draft-pr'),
			versions: ['0.159.2', '0.160.0', '1.0.0', undefined, 'dev'].map(version => paradisCodexSupportsCustomPrompts(version)),
		}, { newer: false, versions: [true, false, false, true, true] });
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
