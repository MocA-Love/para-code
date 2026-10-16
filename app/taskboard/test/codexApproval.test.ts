// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { addCodexApprovals, CodexConfigError, missingCodexApprovals, withCodexApprovals } from '../server/codexApproval.js';

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
			dotted: refused(`${SERVER}tools.board_ask_human.approval_mode = "approve"\n`),
			inline: refused(`${SERVER}tools = { board_ask_human = { approval_mode = "approve" } }\n`),
			twice: refused(`${SERVER}${SERVER}`),
			topLevelDotted: refused('mcp_servers.para-browser.url = "x"\n'),
			toolsTable: refused(`${SERVER}[mcp_servers.para-browser.tools]\nboard_ask_human = { approval_mode = "prompt" }\n`),
			fine: refused(SERVER),
		}).toEqual({ empty: true, quoted: true, dotted: true, inline: true, twice: true, topLevelDotted: true, toolsTable: true, fine: false });
		// 読めない書き方でも帯は出し続ける（押すと理由を出す）
		expect(missingCodexApprovals('[mcp_servers."para-browser"]\n')).toEqual(['board_complete_step', 'board_ask_human']);
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
});
