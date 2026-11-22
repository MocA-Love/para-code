/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { Emitter } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { PARADIS_AGENT_CLI_CODEX_RULES_CONTENT, PARADIS_AGENT_CLI_MANAGED_MARK, PARADIS_AGENT_CLI_SKILL_CONTENT, PARADIS_CURSOR_LABEL_INSTRUCTION, PARADIS_SHARED_PAGE_ACTION_INSTRUCTION, paradisAgentCliEnabled, paradisAgentCliFileAction } from '../../common/paradisAgentCliSkill.js';
import { ParadisAgentCliAutoInstall, paradisAgentCliFiles, paradisSyncAgentCliFiles } from '../../node/paradisAgentCliInstall.js';

suite('paradisAgentCliInstall', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let home: string;

	setup(() => {
		home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'para-cli-install-')));
	});

	teardown(async () => {
		await fs.promises.rm(home, { recursive: true, force: true });
	});

	const read = (...segments: string[]) => {
		try {
			return fs.readFileSync(join(home, ...segments), 'utf8');
		} catch {
			return undefined;
		}
	};
	const claudeSkill = ['.claude', 'skills', 'para-cli', 'SKILL.md'];
	const codexSkill = ['.agents', 'skills', 'para-cli', 'SKILL.md'];
	const codexRules = ['.codex', 'rules', 'para-code.rules'];
	const secondCodexRules = ['.codex-2', 'rules', 'para-code.rules'];
	const files = () => paradisAgentCliFiles({}, [join(home, '.codex'), join(home, '.codex-2'), join(home, '.codex-gone')], home);

	test('the skill is a short entry that carries the promises of the MCP instructions, and both files carry the mark', () => {
		assert.deepStrictEqual({
			short: Buffer.byteLength(PARADIS_AGENT_CLI_SKILL_CONTENT) < 3500,
			frontmatter: PARADIS_AGENT_CLI_SKILL_CONTENT.startsWith('---\nname: para-cli\ndescription: >-\n'),
			promises: [PARADIS_CURSOR_LABEL_INSTRUCTION, PARADIS_SHARED_PAGE_ACTION_INSTRUCTION, 'write_site_note', 'para help browser', 'Never print the environment'].filter(text => !PARADIS_AGENT_CLI_SKILL_CONTENT.includes(text)),
			// 1 段目では MCP も並んでいる。「MCP は無い」とは書かない
			mcp: /no MCP|only way/i.test(PARADIS_AGENT_CLI_SKILL_CONTENT),
			marks: [PARADIS_AGENT_CLI_SKILL_CONTENT, PARADIS_AGENT_CLI_CODEX_RULES_CONTENT].map(content => content.includes(PARADIS_AGENT_CLI_MANAGED_MARK)),
			rule: PARADIS_AGENT_CLI_CODEX_RULES_CONTENT.split('\n').filter(line => !line.startsWith('#') && line.length > 0),
			enabled: [paradisAgentCliEnabled(true), paradisAgentCliEnabled(undefined), paradisAgentCliEnabled('true')],
		}, {
			short: true,
			frontmatter: true,
			promises: [],
			mcp: false,
			marks: [true, true],
			rule: ['prefix_rule(pattern=["para"], decision="allow")'],
			enabled: [true, false, false],
		});
	});

	test('a file without the mark belongs to the user: it is never written over and never removed', () => {
		const managed = `old\n# ${PARADIS_AGENT_CLI_MANAGED_MARK}\n`;
		assert.deepStrictEqual({
			missing: [paradisAgentCliFileAction(undefined, 'new'), paradisAgentCliFileAction(undefined, undefined)],
			same: paradisAgentCliFileAction('new', 'new'),
			managedOld: [paradisAgentCliFileAction(managed, 'new'), paradisAgentCliFileAction(managed, undefined)],
			users: [paradisAgentCliFileAction('mine', 'new'), paradisAgentCliFileAction('mine', undefined)],
		}, {
			missing: ['write', 'keep'],
			same: 'keep',
			managedOld: ['write', 'remove'],
			users: ['keep', 'keep'],
		});
	});

	test('puts the files only where an agent is set up, and takes away only its own', async () => {
		const nothing = await paradisSyncAgentCliFiles(await files(), true);
		const created = fs.readdirSync(home);
		for (const folder of ['.claude', '.codex', '.codex-2']) {
			fs.mkdirSync(join(home, folder));
		}
		// 2 つ目のホームには利用者の規則がある
		fs.mkdirSync(join(home, '.codex-2', 'rules'));
		fs.writeFileSync(join(home, ...secondCodexRules), 'prefix_rule(pattern=["para"], decision="prompt")\n');
		// 前の版の Para Code が置いた手引き
		fs.mkdirSync(join(home, '.claude', 'skills', 'para-cli'), { recursive: true });
		fs.writeFileSync(join(home, ...claudeSkill), `old text\n<!-- ${PARADIS_AGENT_CLI_MANAGED_MARK} -->\n`);
		fs.writeFileSync(join(home, '.claude', 'skills', 'para-cli', 'notes.md'), 'kept');

		const installed = await paradisSyncAgentCliFiles(await files(), true);
		const afterInstall = { claude: read(...claudeSkill) === PARADIS_AGENT_CLI_SKILL_CONTENT, codex: read(...codexSkill) === PARADIS_AGENT_CLI_SKILL_CONTENT, rules: read(...codexRules) === PARADIS_AGENT_CLI_CODEX_RULES_CONTENT, usersRules: read(...secondCodexRules) };
		const again = await paradisSyncAgentCliFiles(await files(), true);
		const removed = await paradisSyncAgentCliFiles(await files(), false);

		assert.deepStrictEqual({
			nothing, created,
			installed: installed.map(result => `${result.kind} ${result.outcome}`),
			afterInstall,
			again: again.map(result => result.outcome),
			removed: removed.map(result => `${result.kind} ${result.outcome}`),
			afterRemove: { claude: read(...claudeSkill), otherFile: read('.claude', 'skills', 'para-cli', 'notes.md'), codexSkillFolder: fs.existsSync(join(home, '.agents', 'skills', 'para-cli')), rules: read(...codexRules), usersRules: read(...secondCodexRules) },
		}, {
			nothing: [], created: [],
			installed: ['claude-skill written', 'codex-skill written', 'codex-rules written', 'codex-rules skipped'],
			afterInstall: { claude: true, codex: true, rules: true, usersRules: 'prefix_rule(pattern=["para"], decision="prompt")\n' },
			again: ['unchanged', 'unchanged', 'unchanged', 'skipped'],
			removed: ['claude-skill removed', 'codex-skill removed', 'codex-rules removed', 'codex-rules unchanged'],
			afterRemove: { claude: undefined, otherFile: 'kept', codexSkillFolder: false, rules: undefined, usersRules: 'prefix_rule(pattern=["para"], decision="prompt")\n' },
		});
	});

	test('does not write through a symbolic link', async function () {
		if (isWindows) {
			this.skip();
		}
		fs.mkdirSync(join(home, '.claude'));
		fs.mkdirSync(join(home, 'dotfiles', 'skills'), { recursive: true });
		fs.symlinkSync(join(home, 'dotfiles', 'skills'), join(home, '.claude', 'skills'), 'dir');
		fs.mkdirSync(join(home, '.codex', 'rules'), { recursive: true });
		fs.writeFileSync(join(home, 'dotfiles', 'para.rules'), `# ${PARADIS_AGENT_CLI_MANAGED_MARK}\n`);
		fs.symlinkSync(join(home, 'dotfiles', 'para.rules'), join(home, ...codexRules));

		const results = await paradisSyncAgentCliFiles(await files(), true);
		const removal = await paradisSyncAgentCliFiles(await files(), false);

		assert.deepStrictEqual({
			results: results.map(result => `${result.kind} ${result.outcome}`),
			removal: removal.map(result => `${result.kind} ${result.outcome}`),
			behindTheLink: fs.readdirSync(join(home, 'dotfiles', 'skills')),
			linkedFile: read('dotfiles', 'para.rules'),
		}, {
			results: ['claude-skill skipped', 'codex-skill written', 'codex-rules skipped'],
			removal: ['claude-skill skipped', 'codex-skill removed', 'codex-rules skipped'],
			behindTheLink: [],
			linkedFile: `# ${PARADIS_AGENT_CLI_MANAGED_MARK}\n`,
		});
	});

	test('does nothing while the setting is off at start, installs when it is turned on and removes when it is turned off', async () => {
		fs.mkdirSync(join(home, '.claude'));
		// 別の Para Code が置いたもの。起動時にオフのこの Para Code は消さない
		fs.mkdirSync(join(home, '.claude', 'skills', 'para-cli'), { recursive: true });
		fs.writeFileSync(join(home, ...claudeSkill), PARADIS_AGENT_CLI_SKILL_CONTENT);
		let enabled = false;
		const asked: boolean[] = [];
		const onDidChangeEnabled = store.add(new Emitter<void>());
		const onDidChangeTargets = store.add(new Emitter<void>());
		const installer = store.add(new ParadisAgentCliAutoInstall({ isEnabled: () => enabled, onDidChangeEnabled: onDidChangeEnabled.event, onDidChangeTargets: onDidChangeTargets.event, files: async forRemoval => { asked.push(forRemoval); return files(); }, logService: new NullLogService() }));
		await installer.whenIdle();
		const atStart = read(...claudeSkill) !== undefined;
		onDidChangeEnabled.fire();
		await installer.whenIdle();
		const unchangedSetting = read(...claudeSkill) !== undefined;
		enabled = true;
		onDidChangeEnabled.fire();
		await installer.whenIdle();
		// 後から Codex のホームができた
		fs.mkdirSync(join(home, '.codex'));
		const beforeTargets = read(...codexRules);
		onDidChangeTargets.fire();
		await installer.whenIdle();
		const afterTargets = read(...codexRules) === PARADIS_AGENT_CLI_CODEX_RULES_CONTENT;
		enabled = false;
		onDidChangeEnabled.fire();
		await installer.whenIdle();
		// 外すときだけ、置き場所を広く見る（ログアウトした Codex のホームに残った規則も消す）
		assert.deepStrictEqual({ atStart, unchangedSetting, beforeTargets, afterTargets, afterOff: [read(...claudeSkill), read(...codexSkill), read(...codexRules)], asked }, { atStart: true, unchangedSetting: true, beforeTargets: undefined, afterTargets: true, afterOff: [undefined, undefined, undefined], asked: [false, false, true] });
	});
});
