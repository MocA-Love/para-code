/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シンボリックリンクの扱いは実際のディスクで確かめる（一時フォルダの中だけを使う）。

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisSkillHost, paradisDedupeSkillListings, paradisDeleteSkill, paradisInstallSkill, paradisListSkills, paradisPlanSkillRoots } from '../../common/paradisSkills.js';

(isWindows ? suite.skip : suite)('paradisSkills on disk', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let home: string;

	setup(async () => {
		home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paradis-skills-')));
	});
	teardown(async () => {
		await fs.rm(home, { recursive: true, force: true });
	});

	function services(disposables: DisposableStore) {
		const logService = new NullLogService();
		const fileService = disposables.add(new FileService(logService));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(logService))));
		const host: IParadisSkillHost = { id: 'local', kind: 'local', label: 'local', home: URI.file(home) };
		const [claude, codex, agents] = paradisPlanSkillRoots({ host, projects: [] });
		return { fileService, claude, codex, agents };
	}

	async function writeSkill(dir: string, name: string) {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`);
	}

	test('shows a skills folder that links to another one only once', async () => {
		const { fileService, claude, agents } = services(store.add(new DisposableStore()));
		await writeSkill(join(home, '.agents', 'skills', 'foo'), 'foo');
		await fs.mkdir(join(home, '.claude'), { recursive: true });
		await fs.symlink(join(home, '.agents', 'skills'), join(home, '.claude', 'skills'));
		const listings = paradisDedupeSkillListings([
			await paradisListSkills(fileService, agents),
			await paradisListSkills(fileService, claude),
		]);
		assert.deepStrictEqual(listings.map(listing => [listing.root.provider, listing.skills.length, listing.aliasOf]), [['agents', 1, undefined], ['claude', 0, agents.id]]);
	});

	test('installs the contents of a linked skill, and refuses skills that contain links', async () => {
		const { fileService, claude, codex } = services(store.add(new DisposableStore()));
		await writeSkill(join(home, 'shared', 'foo'), 'foo');
		await fs.mkdir(join(home, '.claude', 'skills'), { recursive: true });
		await fs.symlink('../../shared/foo', join(home, '.claude', 'skills', 'foo'));
		await writeSkill(join(home, '.claude', 'skills', 'leaky'), 'leaky');
		await fs.mkdir(join(home, 'secret'));
		await fs.symlink(join(home, 'secret'), join(home, '.claude', 'skills', 'leaky', 'ssh'));
		const skills = (await paradisListSkills(fileService, claude)).skills;
		const linked = skills.find(skill => skill.folderName === 'foo')!;
		const leaky = skills.find(skill => skill.folderName === 'leaky')!;
		assert.strictEqual(linked.isSymbolicLink, true);
		await paradisInstallSkill(fileService, linked, codex, false);
		const installed = join(home, '.codex', 'skills', 'foo');
		assert.deepStrictEqual([(await fs.lstat(installed)).isSymbolicLink(), await fs.readFile(join(installed, 'SKILL.md'), 'utf8')], [false, '---\nname: foo\n---\n']);
		await assert.rejects(() => paradisInstallSkill(fileService, leaky, codex, false));
		assert.strictEqual(await fileService.exists(URI.file(join(home, '.codex', 'skills', 'leaky'))), false);
	});

	test('replacing an installed skill keeps no backup behind', async () => {
		const { fileService, claude, codex } = services(store.add(new DisposableStore()));
		await writeSkill(join(home, '.claude', 'skills', 'foo'), 'new');
		await writeSkill(join(home, '.codex', 'skills', 'foo'), 'old');
		const [skill] = (await paradisListSkills(fileService, claude)).skills;
		await paradisInstallSkill(fileService, skill, codex, true);
		assert.deepStrictEqual([
			await fs.readFile(join(home, '.codex', 'skills', 'foo', 'SKILL.md'), 'utf8'),
			(await fs.readdir(join(home, '.codex', 'skills'))).sort(),
		], ['---\nname: new\n---\n', ['foo']]);
	});

	test('deleting a linked skill removes only the link, and replacing a linked skill keeps no backup link behind', async () => {
		const { fileService, claude, codex } = services(store.add(new DisposableStore()));
		await writeSkill(join(home, 'shared', 'foo'), 'shared');
		await fs.mkdir(join(home, '.claude', 'skills'), { recursive: true });
		await fs.symlink('../../shared/foo', join(home, '.claude', 'skills', 'foo'));
		await writeSkill(join(home, '.claude', 'skills', 'bar'), 'new');
		await fs.mkdir(join(home, '.codex', 'skills'), { recursive: true });
		await fs.symlink('../../shared/foo', join(home, '.codex', 'skills', 'bar'));
		const skills = (await paradisListSkills(fileService, claude)).skills;
		await paradisDeleteSkill(fileService, skills.find(skill => skill.folderName === 'foo')!);
		await paradisInstallSkill(fileService, skills.find(skill => skill.folderName === 'bar')!, codex, true);
		assert.deepStrictEqual([
			(await fs.readdir(join(home, '.claude', 'skills'))).sort(),
			(await fs.readdir(join(home, '.codex', 'skills'))).sort(),
			(await fs.lstat(join(home, '.codex', 'skills', 'bar'))).isSymbolicLink(),
			await fs.readFile(join(home, 'shared', 'foo', 'SKILL.md'), 'utf8'),
		], [['bar'], ['bar'], false, '---\nname: shared\n---\n']);
	});
});
