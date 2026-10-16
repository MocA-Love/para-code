// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { addCodexApprovals, codexConfigCandidates, CodexConfigError, codexHomesFromSettings, codexWriteRefusal, missingCodexApprovals, withCodexApprovals } from '../server/codexApproval.js';

const SERVER = '[mcp_servers.para-browser]\nurl = "http://127.0.0.1:1/"\n';

describe('codex approval', () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

	test('appends both tool tables after the server and keeps the rest of the file', () => {
		const before = `${SERVER}\n[other]\nx = 1\n`;
		const after = withCodexApprovals(before);
		expect(after).toBe(`${before}\n[mcp_servers.para-browser.tools.board_complete_step]\napproval_mode = "approve"\n\n[mcp_servers.para-browser.tools.board_ask_human]\napproval_mode = "approve"\n`);
		expect(missingCodexApprovals(after)).toEqual([]);
		expect(withCodexApprovals(after)).toBe(after);
	});

	test('replaces another approval mode inside an existing table, even when the header has a comment', () => {
		const before = `${SERVER}[mcp_servers.para-browser.tools.board_ask_human] # mine\napproval_mode = "prompt"\n# keep\n[next]\n`;
		const after = withCodexApprovals(before);
		expect(after).toContain('[mcp_servers.para-browser.tools.board_ask_human] # mine\napproval_mode = "approve"\n# keep\n[next]');
		expect(after.match(/board_ask_human\]/g)?.length).toBe(1);
		expect(missingCodexApprovals(after)).toEqual([]);
	});

	test('reads the server name in quotes and a # inside a string the same way Para Code does', () => {
		const before = `[mcp_servers."para-browser"] # mine\nurl = "http://127.0.0.1:1/#x"\n`;
		const after = withCodexApprovals(before);
		expect({ kept: after.startsWith(before), missing: missingCodexApprovals(after), again: withCodexApprovals(after) === after }).toEqual({ kept: true, missing: [], again: true });
	});

	test('replaces an approval_mode written with quoted keys instead of adding a second one, and refuses forms it cannot replace', () => {
		const before = `[mcp_servers."para-browser"]\nurl = "http://x"\n[mcp_servers."para-browser".tools."board_ask_human"]\n"approval_mode" = "prompt"\n[mcp_servers.'para-browser'.tools.board_complete_step]\n'approval_mode' = 'approve'\n`;
		const after = withCodexApprovals(before);
		const refused = (text: string) => withCodexApprovals.bind(undefined, text);
		expect({
			modes: after.split('\n').filter(l => l.includes('approval_mode')),
			missing: missingCodexApprovals(after),
		}).toEqual({ modes: ['approval_mode = "approve"', `'approval_mode' = 'approve'`], missing: [] });
		expect(refused(`${SERVER}[mcp_servers.para-browser.tools.board_ask_human]\napproval_mode.x = "prompt"\n`)).toThrow(CodexConfigError);
		expect(refused(`${SERVER}[mcp_servers.para-browser.tools.board_ask_human]\napproval_mode = \"\"\"\nprompt\n\"\"\"\n`)).toThrow(CodexConfigError);
	});

	test('ignores header-like lines inside multi-line strings', () => {
		const before = `developer_instructions = """\n[mcp_servers.para-browser]\nnot a table\n"""\n${SERVER}`;
		const after = withCodexApprovals(before);
		expect(after.startsWith(before)).toBe(true);
		expect(missingCodexApprovals(after)).toEqual([]);
	});

	test('refuses to write when the server is missing or written in a way it cannot read safely', () => {
		const refused = (text: string) => {
			try {
				withCodexApprovals(text);
				return false;
			} catch (err) {
				return err instanceof CodexConfigError;
			}
		};
		expect({
			empty: refused(''),
			quoted: refused('[mcp_servers."para-browser"]\nurl = "x"\n'),
			broken: refused('[mcp_servers."para-browser]\nurl = "x"\n'),
			dotted: refused(`${SERVER}tools.board_ask_human.approval_mode = "approve"\n`),
			inline: refused(`${SERVER}tools = { board_ask_human = { approval_mode = "approve" } }\n`),
			twice: refused(`${SERVER}${SERVER}`),
			topLevelDotted: refused('mcp_servers.para-browser.url = "x"\n'),
			toolsTable: refused(`${SERVER}[mcp_servers.para-browser.tools]\nboard_ask_human = { approval_mode = "prompt" }\n`),
			fine: refused(SERVER),
		}).toEqual({ empty: true, quoted: false, broken: true, dotted: true, inline: true, twice: true, topLevelDotted: true, toolsTable: true, fine: false });
		// 読めない書き方でも帯は出し続け、手で足す設定として理由を出す
		expect(missingCodexApprovals('[mcp_servers."para-browser]\n')).toEqual(['board_complete_step', 'board_ask_human']);
		expect({ broken: codexWriteRefusal('[mcp_servers."para-browser]\n')?.includes('見出し'), fine: codexWriteRefusal(SERVER) }).toEqual({ broken: true, fine: undefined });
	});

	test('writes a regular file with a backup, and refuses a symbolic link', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'tb-codex-'));
		dirs.push(dir);
		const file = path.join(dir, 'config.toml');
		writeFileSync(file, SERVER);
		await addCodexApprovals(file);
		const link = path.join(dir, 'linked.toml');
		symlinkSync(file, link);
		const linkRefused = await addCodexApprovals(link).then(() => false, err => err instanceof CodexConfigError);
		expect({
			approved: missingCodexApprovals(readFileSync(file, 'utf8')),
			backup: readFileSync(`${file}.taskboard.bak`, 'utf8'),
			linkRefused,
		}).toEqual({ approved: [], backup: SERVER, linkRefused: true });
	});
	test('finds the Codex homes Para Code uses: CODEX_HOME, ~/.codex, ~/.codex-<number> (also as a link) and the configured ones', async () => {
		const home = mkdtempSync(path.join(os.tmpdir(), 'tb-codex-home-'));
		const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'tb-codex-env-'));
		const configured = mkdtempSync(path.join(os.tmpdir(), 'tb-codex-conf-'));
		dirs.push(home, elsewhere, configured);
		const write = (dir: string, text: string) => {
			mkdirSync(dir, { recursive: true });
			writeFileSync(path.join(dir, 'config.toml'), text);
		};
		write(path.join(home, '.codex'), SERVER);
		write(path.join(home, '.codex-2'), `[mcp_servers."para-browser"]\ncommand = "node"\n`);
		write(path.join(home, '.codex-3'), '[mcp_servers.other]\n');
		write(path.join(home, '.codex-backup'), SERVER);
		mkdirSync(path.join(home, '.codex-4'));
		write(path.join(home, 'accounts', 'five'), SERVER);
		symlinkSync(path.join(home, 'accounts', 'five'), path.join(home, '.codex-5'));
		symlinkSync(path.join(home, '.codex'), path.join(home, '.codex-6'));
		write(elsewhere, SERVER);
		write(configured, SERVER);
		const found = await codexConfigCandidates({ CODEX_HOME: elsewhere }, home, ['relative/path', configured, '~/.codex']);
		const relative = await codexConfigCandidates({ CODEX_HOME: '.codex-backup' }, home, []);
		const settings = codexHomesFromSettings('{\n  "paradis.limitsMonitor.codexHomes": [\n    // work\n    "~/work-codex",\n  ],\n}');
		expect({
			found: found.map(f => path.relative(home, f)),
			relative: relative.map(f => path.relative(home, f)),
			settings,
		}).toEqual({
			found: [path.relative(home, path.join(elsewhere, 'config.toml')), '.codex/config.toml', '.codex-2/config.toml', '.codex-5/config.toml', path.relative(home, path.join(configured, 'config.toml'))],
			relative: ['.codex/config.toml', '.codex-2/config.toml', '.codex-5/config.toml'],
			settings: ['~/work-codex'],
		});
	});
});
