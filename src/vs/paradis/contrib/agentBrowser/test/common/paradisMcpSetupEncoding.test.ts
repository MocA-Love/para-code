/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	encodeParadisPosixShellArgument,
	paradisUpsertCodexMcpToml,
	encodeParadisPowerShellArgument,
	encodeParadisTomlBasicString,
	inspectParadisMcpTomlSection,
} from '../../common/paradisMcpSetupEncoding.js';

suite('Para Browser MCP setup encoding', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('encodes TOML basic strings without raw control characters', () => {
		const encoded = encodeParadisTomlBasicString('C:\\Para "Code"\n\r\t\b\f\x00\x1f\x7f/😀');
		assert.strictEqual(encoded, '"C:\\\\Para \\"Code\\"\\n\\r\\t\\b\\f\\u0000\\u001f\\u007f/😀"');
		assert.strictEqual(/[\u0000-\u001f\u007f]/.test(encoded), false);
	});

	test('rejects values that TOML cannot preserve safely', () => {
		assert.throws(() => encodeParadisTomlBasicString('\ud800'), /surrogate/i);
		assert.throws(() => encodeParadisTomlBasicString('\udc00'), /surrogate/i);
	});

	test('quotes a POSIX shell argument as one literal argv value', () => {
		const value = `/tmp/Para "Code"/'single'/$(touch marker)/\`touch marker2\`/$HOME/\\path`;
		const encoded = encodeParadisPosixShellArgument(value);
		const quote = String.fromCharCode(0x27);
		assert.strictEqual(encoded, `${quote}${value.replaceAll(quote, `${quote}\\${quote}${quote}`)}${quote}`);
		assert.strictEqual(encoded.includes('"'), true);
		assert.throws(() => encodeParadisPosixShellArgument('bad\0path'), /NUL/i);
	});

	test('quotes a PowerShell argument without cmd.exe semantics', () => {
		assert.strictEqual(encodeParadisPowerShellArgument(`C:\\Para 'Code'\\$env:TEMP; x`), `'C:\\Para ''Code''\\$env:TEMP; x'`);
		assert.throws(() => encodeParadisPowerShellArgument('bad\0path'), /NUL/i);
	});

	test('recognizes equivalent existing table headers outside comments and multiline strings', () => {
		for (const source of [
			'[mcp_servers.para-browser]\n',
			'[ mcp_servers . "para-browser" ] # existing\n',
			`[mcp_servers.'para-browser']\n`,
			'["mcp_servers"."para\\u002dbrowser"]\n',
		]) {
			assert.strictEqual(inspectParadisMcpTomlSection(source), 'present');
		}
		assert.strictEqual(inspectParadisMcpTomlSection([
			'# [mcp_servers.para-browser]',
			'note = """',
			'[mcp_servers.para-browser]',
			'"""',
		].join('\n')), 'absent');
	});

	test('fails closed for ambiguous definitions that could be overwritten or duplicated', () => {
		for (const source of [
			'[mcp_servers]\npara-browser = { command = "node" }\n',
			'mcp_servers.para-browser.command = "node"\n',
			'"mcp_servers"."para-browser".command = "node"\n',
			'[[mcp_servers.para-browser]]\n',
			'[["mcp_servers"."para-browser"]]\n',
			'[mcp_servers."para-browser]\n',
			'["mcp_servers"."para-browser]\n',
			`['mcp_servers'.'para-browser]\n`,
			'note = """unterminated\n',
			'note = """escaped \\"""\n[mcp_servers.para-browser]\n',
		]) {
			assert.strictEqual(inspectParadisMcpTomlSection(source), 'ambiguous');
		}
	});
	test('registers para-browser for Codex over HTTP, replacing whatever was there', () => {
		// 設定を別のマシンから移すと、手元のシムの絶対パスを指した節がそのまま残る。
		// 接続先にそのファイルは無いので、中身を見て直すのではなく節ごと書き替える
		const existing = [
			'model = "gpt-5"',
			'',
			'[mcp_servers.para-browser]',
			'command = "node"',
			'args = [ "/Applications/Para Code.app/Contents/Resources/app/out/shim.js" ]',
			'env_vars = [ "PARA_CODE_TERMINAL_PANE_ID" ]',
			'',
			'[mcp_servers.other]',
			'command = "keep"',
			'',
		].join('\n');

		const updated = paradisUpsertCodexMcpToml(existing, 47286);

		assert.strictEqual(updated, [
			'model = "gpt-5"',
			'',
			'[mcp_servers.para-browser]',
			'url = "http://127.0.0.1:47286/"',
			'bearer_token_env_var = "PARA_CODE_TERMINAL_PANE_ID"',
			'',
			'[mcp_servers.other]',
			'command = "keep"',
			'',
		].join('\n'));
		// 2回当てても増えない
		assert.strictEqual(paradisUpsertCodexMcpToml(updated, 47286), updated);
	});

	test('appends the Codex section when there is none, keeping a blank line before it', () => {
		assert.strictEqual(paradisUpsertCodexMcpToml('', 4100), [
			'[mcp_servers.para-browser]',
			'url = "http://127.0.0.1:4100/"',
			'bearer_token_env_var = "PARA_CODE_TERMINAL_PANE_ID"',
			'',
		].join('\n'));
		assert.strictEqual(paradisUpsertCodexMcpToml('model = "gpt-5"\n', 4100), [
			'model = "gpt-5"',
			'',
			'[mcp_servers.para-browser]',
			'url = "http://127.0.0.1:4100/"',
			'bearer_token_env_var = "PARA_CODE_TERMINAL_PANE_ID"',
			'',
		].join('\n'));
	});
});
