/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import {
	IParadisSkillHost,
	paradisDeleteSkill,
	paradisInstallSkill,
	paradisIsSafeSkillFolderName,
	paradisListSkills,
	paradisParseSkillMetadata,
	paradisPlanSkillRoots,
	paradisReadSkillFile,
	paradisSkillDeleteBlocker,
} from '../../common/paradisSkills.js';

const LOCAL: IParadisSkillHost = { id: 'local', kind: 'local', label: 'この PC', home: URI.from({ scheme: 'mem', path: '/home/u' }) };
const REMOTE: IParadisSkillHost = { id: 'remote', kind: 'remote', label: 'SSH', home: URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+h', path: '/home/r' }) };

suite('paradisSkills', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(disposables: DisposableStore) {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('mem', disposables.add(new InMemoryFileSystemProvider())));
		disposables.add(fileService.registerProvider('vscode-remote', disposables.add(new InMemoryFileSystemProvider())));
		const write = (uri: URI, text: string) => fileService.writeFile(uri, VSBuffer.fromString(text));
		return { fileService, write };
	}

	test('parses frontmatter, headings and block scalars', () => {
		assert.deepStrictEqual([
			paradisParseSkillMetadata('---\nname: "pdf"\ndescription: Read PDFs\n---\n# Title\n'),
			paradisParseSkillMetadata('---\r\nname: x\r\ndescription: >\r\n  folded\r\n  text\r\n---\r\nbody'),
			paradisParseSkillMetadata('# Heading\n\nFirst   paragraph\nline two\n'),
			paradisParseSkillMetadata(''),
		], [
			{ name: 'pdf', description: 'Read PDFs' },
			{ name: 'x', description: 'folded text' },
			{ name: 'Heading', description: 'First paragraph line two' },
			{},
		]);
	});

	test('plans user and project roots for a host', () => {
		const roots = paradisPlanSkillRoots({
			host: LOCAL,
			codexHome: URI.from({ scheme: 'mem', path: '/custom/codex' }),
			projects: [{ name: 'repo', uri: URI.from({ scheme: 'mem', path: '/w/repo' }) }, { name: 'dup', uri: URI.from({ scheme: 'mem', path: '/w/repo' }) }],
		});
		assert.deepStrictEqual(roots.map(root => `${root.provider}:${root.scope}:${root.uri.path}`), [
			'claude:user:/home/u/.claude/skills',
			'codex:user:/custom/codex/skills',
			'agents:user:/home/u/.agents/skills',
			'claude:project:/w/repo/.claude/skills',
			'agents:project:/w/repo/.agents/skills',
		]);
	});

	test('lists skills, marks bundled Codex skills and ignores folders without SKILL.md', async () => {
		const { fileService, write } = setup(store.add(new DisposableStore()));
		const [claude, codex, agents] = paradisPlanSkillRoots({ host: LOCAL, projects: [] });
		await write(joinPath(claude.uri, 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: d\n---\n');
		await write(joinPath(claude.uri, 'notes', 'README.md'), 'no skill');
		await write(joinPath(claude.uri, '.hidden', 'SKILL.md'), '---\nname: hidden\n---\n');
		await write(joinPath(codex.uri, '.system', 'creator', 'SKILL.md'), '---\nname: skill-creator\n---\n');
		const listings = await Promise.all([claude, codex, agents].map(root => paradisListSkills(fileService, root)));
		assert.deepStrictEqual(listings.map(listing => ({ exists: listing.exists, skills: listing.skills.map(skill => `${skill.name}${skill.bundled ? ' (bundled)' : ''}`) })), [
			{ exists: true, skills: ['pdf'] },
			{ exists: true, skills: ['skill-creator (bundled)'] },
			{ exists: false, skills: [] },
		]);
		assert.ok(paradisSkillDeleteBlocker(listings[1].skills[0]));
		assert.deepStrictEqual(await paradisReadSkillFile(fileService, listings[0].skills[0]), { text: '---\nname: pdf\ndescription: d\n---\n', truncated: false });
	});

	test('installs a skill onto another host and refuses to overwrite without consent', async () => {
		const { fileService, write } = setup(store.add(new DisposableStore()));
		const [claude] = paradisPlanSkillRoots({ host: LOCAL, projects: [] });
		const [remoteClaude] = paradisPlanSkillRoots({ host: REMOTE, projects: [] });
		await write(joinPath(claude.uri, 'pdf', 'SKILL.md'), '---\nname: pdf\n---\n');
		await write(joinPath(claude.uri, 'pdf', 'scripts', 'run.sh'), 'echo hi');
		const [skill] = (await paradisListSkills(fileService, claude)).skills;
		const destination = await paradisInstallSkill(fileService, skill, remoteClaude, false);
		assert.strictEqual((await fileService.readFile(joinPath(destination, 'scripts', 'run.sh'))).value.toString(), 'echo hi');
		await assert.rejects(() => paradisInstallSkill(fileService, skill, remoteClaude, false));
		await write(joinPath(claude.uri, 'pdf', 'SKILL.md'), '---\nname: pdf2\n---\n');
		await paradisInstallSkill(fileService, skill, remoteClaude, true);
		const remote = await paradisListSkills(fileService, remoteClaude);
		assert.deepStrictEqual(remote.skills.map(entry => entry.name), ['pdf2'], 'overwritten, and no staging folder is left behind');
		await assert.rejects(() => paradisInstallSkill(fileService, skill, claude, true), 'installing onto the same root is refused');
	});

	test('puts the previous skill back when replacing it fails midway', async () => {
		const { fileService, write } = setup(store.add(new DisposableStore()));
		const [claude] = paradisPlanSkillRoots({ host: LOCAL, projects: [] });
		const [remoteClaude] = paradisPlanSkillRoots({ host: REMOTE, projects: [] });
		await write(joinPath(claude.uri, 'pdf', 'SKILL.md'), '---\nname: new\n---\n');
		await write(joinPath(remoteClaude.uri, 'pdf', 'SKILL.md'), '---\nname: old\n---\n');
		const [skill] = (await paradisListSkills(fileService, claude)).skills;
		// 写しを置く最後の入れ替えだけを失敗させる
		const failing = new Proxy(fileService, {
			get: (target, key) => key === 'move'
				? (from: URI, to: URI, overwrite?: boolean) => from.path.includes('.paradis-install-') ? Promise.reject(new Error('boom')) : target.move(from, to, overwrite)
				: Reflect.get(target, key),
		});
		await assert.rejects(() => paradisInstallSkill(failing, skill, remoteClaude, true), /boom/);
		const remote = await fileService.resolve(remoteClaude.uri);
		assert.deepStrictEqual({
			names: (await paradisListSkills(fileService, remoteClaude)).skills.map(entry => entry.name),
			leftovers: (remote.children ?? []).map(child => child.name).filter(name => name.startsWith('.')),
		}, { names: ['old'], leftovers: [] });
	});

	test('deletes only direct children of a skills root', async () => {
		const { fileService, write } = setup(store.add(new DisposableStore()));
		const [claude] = paradisPlanSkillRoots({ host: LOCAL, projects: [] });
		await write(joinPath(claude.uri, 'pdf', 'SKILL.md'), '---\nname: pdf\n---\n');
		const [skill] = (await paradisListSkills(fileService, claude)).skills;
		await assert.rejects(() => paradisDeleteSkill(fileService, { ...skill, uri: joinPath(claude.uri, '..', 'pdf') }));
		await paradisDeleteSkill(fileService, skill);
		assert.strictEqual(await fileService.exists(skill.uri), false);
		assert.deepStrictEqual(['ok', '..', '.x', 'a/b', 'a\\b', ''].map(paradisIsSafeSkillFolderName), [true, false, false, false, false, false]);
	});
});
