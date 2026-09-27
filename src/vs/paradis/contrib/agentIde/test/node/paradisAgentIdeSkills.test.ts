/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_AGENT_IDE_SKILL_CONTENT } from '../../common/paradisAgentIdeGuide.js';
import { paradisAgentIdeSkillTargets, paradisInspectAgentIdeSkills, paradisInstallAgentIdeSkills } from '../../node/paradisAgentIdeSkills.js';

suite('paradisAgentIdeSkills', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-agent-ide-skills-'));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function targets() {
		return paradisAgentIdeSkillTargets({ claudeConfigDir: join(root, '.claude'), userHome: root });
	}

	test('targets are the Claude config dir and the ~/.agents skills dir', () => {
		assert.deepStrictEqual(targets().map(target => target.path.slice(root.length)), [
			join('/', '.claude', 'skills', 'para-code', 'SKILL.md'),
			join('/', '.agents', 'skills', 'para-code', 'SKILL.md'),
		]);
	});

	test('installs missing files and leaves identical ones alone', async () => {
		const first = await paradisInstallAgentIdeSkills(targets(), [{ agent: 'claude', overwrite: false }, { agent: 'codex', overwrite: false }]);
		const second = await paradisInstallAgentIdeSkills(targets(), [{ agent: 'claude', overwrite: false }]);
		const written = await fs.readFile(targets()[1].path, 'utf8');
		assert.deepStrictEqual(
			{ first: first.map(result => result.outcome), second: second.map(result => result.outcome), written: written === PARADIS_AGENT_IDE_SKILL_CONTENT },
			{ first: ['installed', 'installed'], second: ['unchanged'], written: true },
		);
	});

	test('a different existing file is only overwritten when allowed', async () => {
		const path = targets()[0].path;
		await fs.mkdir(join(path, '..'), { recursive: true });
		await fs.writeFile(path, 'my own skill');
		const inspected = await paradisInspectAgentIdeSkills(targets());
		const kept = await paradisInstallAgentIdeSkills(targets(), [{ agent: 'claude', overwrite: false }]);
		const keptContent = await fs.readFile(path, 'utf8');
		const overwritten = await paradisInstallAgentIdeSkills(targets(), [{ agent: 'claude', overwrite: true }]);
		assert.deepStrictEqual({
			states: inspected.map(inspection => inspection.state),
			kept: kept[0].outcome,
			keptContent,
			overwritten: overwritten[0].outcome,
		}, { states: ['different', 'missing'], kept: 'skipped', keptContent: 'my own skill', overwritten: 'overwritten' });
	});

	test('symlinks are never written through', async () => {
		const path = targets()[0].path;
		const real = join(root, 'dotfiles-skill.md');
		await fs.writeFile(real, 'managed elsewhere');
		await fs.mkdir(join(path, '..'), { recursive: true });
		await fs.symlink(real, path);
		const result = await paradisInstallAgentIdeSkills(targets(), [{ agent: 'claude', overwrite: true }]);
		assert.deepStrictEqual({ outcome: result[0].outcome, real: await fs.readFile(real, 'utf8') }, { outcome: 'skipped', real: 'managed elsewhere' });
	});
});
