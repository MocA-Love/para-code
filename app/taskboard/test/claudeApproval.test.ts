// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { addClaudeApprovals, CLAUDE_APPROVAL_TOOLS, claudeApprovalState, ClaudeConfigError, claudeSettingsCandidates, claudeWriteRefusal, missingClaudeApprovals, withClaudeApprovals } from '../server/claudeApproval.js';

const RULES = CLAUDE_APPROVAL_TOOLS.map(tool => `mcp__para-browser__${tool}`);

describe('claude approval', () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

	test('appends the missing rules to permissions.allow and keeps the other settings and rules', () => {
		const before = JSON.stringify({ model: 'x', permissions: { defaultMode: 'default', allow: ['Bash(ls)', 'mcp__para-browser__board_ask_human'], deny: ['Read(.env)'] }, hooks: { Stop: [] } }, undefined, 2);
		const after = withClaudeApprovals(before);
		expect(JSON.parse(after)).toEqual({ model: 'x', permissions: { defaultMode: 'default', allow: ['Bash(ls)', 'mcp__para-browser__board_ask_human', ...RULES.filter(r => r !== 'mcp__para-browser__board_ask_human')], deny: ['Read(.env)'] }, hooks: { Stop: [] } });
		expect({ missing: missingClaudeApprovals(after), again: withClaudeApprovals(after) === after }).toEqual({ missing: [], again: true });
	});

	test('treats an empty file as empty settings and a server-wide rule as already allowed', () => {
		expect({
			empty: JSON.parse(withClaudeApprovals('')),
			server: missingClaudeApprovals('{"permissions":{"allow":["mcp__para-browser"]}}'),
			wildcard: missingClaudeApprovals('{"permissions":{"allow":["mcp__para-browser__*"]}}'),
			otherServer: missingClaudeApprovals('{"permissions":{"allow":["mcp__other"]}}').length,
		}).toEqual({ empty: { permissions: { allow: RULES } }, server: [], wildcard: [], otherServer: RULES.length });
	});

	test('refuses settings it cannot read safely, and keeps asking for every tool', () => {
		const refused = (text: string) => withClaudeApprovals.bind(undefined, text);
		for (const text of ['{ // comment\n}', '[]', '{"permissions":[]}', '{"permissions":{"allow":"x"}}']) {
			expect(refused(text)).toThrow(ClaudeConfigError);
			expect(missingClaudeApprovals(text)).toEqual(CLAUDE_APPROVAL_TOOLS);
		}
		expect({ bad: typeof claudeWriteRefusal('{,}'), fine: claudeWriteRefusal('{}') }).toEqual({ bad: 'string', fine: undefined });
	});

	test('writes a regular file with a backup, creates a missing one, and refuses a symbolic link', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'tb-claude-'));
		dirs.push(dir);
		const file = path.join(dir, 'settings.json');
		writeFileSync(file, '{"model":"x"}');
		await addClaudeApprovals(file);
		const created = path.join(dir, 'created.json');
		await addClaudeApprovals(created);
		const link = path.join(dir, 'linked.json');
		symlinkSync(file, link);
		const linkRefused = await addClaudeApprovals(link).then(() => false, err => err instanceof ClaudeConfigError);
		const raw = path.join(dir, 'raw.json');
		writeFileSync(raw, '{}');
		const rawLink = path.join(dir, 'raw-link.json');
		symlinkSync(raw, rawLink);
		const linkState = await claudeApprovalState(rawLink);
		expect(linkState.manual).toContain('シンボリックリンク');
		expect({
			approved: missingClaudeApprovals(readFileSync(file, 'utf8')),
			model: JSON.parse(readFileSync(file, 'utf8')).model,
			backup: readFileSync(`${file}.taskboard.bak`, 'utf8'),
			created: missingClaudeApprovals(readFileSync(created, 'utf8')),
			linkRefused,
		}).toEqual({ approved: [], model: 'x', backup: '{"model":"x"}', created: [], linkRefused: true });
	});

	test('looks at $CLAUDE_CONFIG_DIR (absolute only) and ~/.claude, once per real folder and only when the folder exists', async () => {
		const home = mkdtempSync(path.join(os.tmpdir(), 'tb-claude-home-'));
		const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'tb-claude-env-'));
		dirs.push(home, elsewhere);
		const none = await claudeSettingsCandidates({}, home);
		mkdirSync(path.join(home, '.claude'));
		symlinkSync(path.join(home, '.claude'), path.join(home, 'same'));
		const found = await claudeSettingsCandidates({ CLAUDE_CONFIG_DIR: elsewhere }, home);
		const relative = await claudeSettingsCandidates({ CLAUDE_CONFIG_DIR: 'relative' }, home);
		const linked = await claudeSettingsCandidates({ CLAUDE_CONFIG_DIR: '~/same' }, home);
		expect({ none, found, relative, linked: linked.length }).toEqual({
			none: [],
			found: [path.join(elsewhere, 'settings.json'), path.join(home, '.claude', 'settings.json')],
			relative: [path.join(home, '.claude', 'settings.json')],
			linked: 1,
		});
	});
});
