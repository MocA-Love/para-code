/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import type * as http from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_AGENT_GATEWAY_AFTER_DISPATCH_HEADER, PARADIS_AGENT_GATEWAY_FILE_NAME, PARADIS_AGENT_GATEWAY_TIMEOUT_CODE, PARADIS_AGENT_GATEWAY_WAIT_SECONDS_HEADER } from '../../common/paradisAgentGateway.js';
import { IParadisCliCatalog, PARADIS_CLI_CATALOG_METHOD, PARADIS_CLI_META_KEY, PARADIS_CLI_PROTOCOL_VERSION, paradisBuildCliCatalog } from '../../common/paradisCliCatalog.js';
import { PARADIS_CLI_LAUNCHER_FOLDER_SEGMENTS, PARADIS_CLI_LAUNCHER_NAME, PARADIS_CLI_REMOTE_TARGET_NAME, paradisAddParaCliToPaneEnvironment, paradisCliRemoteTargetContent } from '../../common/paradisCliPaneEnvironment.js';
import { IParadisCliEndpoint, IParadisCliRuntime, PARADIS_CLI_AFTER_DISPATCH_HEADER, PARADIS_CLI_GATEWAY_WAIT_HEADER, PARADIS_CLI_PORT_FILE_ENV, PARADIS_CLI_TOKEN_ENV, ParadisCliAttempt, ParadisCliUsageError, paradisCliCallMeta, paradisCliCheckOutputPath, paradisCliClaudePermissions, paradisCliEndpoints, paradisCliParseFlags, paradisCliRpc, paradisCliVerdict, paradisRunCli } from '../../node/paradisCliCore.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

const TOOLS = [
	{ name: 'get_text', description: 'Read the text of the page. More detail here.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { selector: { type: 'string' }, max_chars: { type: 'integer', minimum: 1 }, tab_id: { type: 'string' } } } },
	{ name: 'take_screenshot', description: 'Take a screenshot.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' }, tab_id: { type: 'string' } } } },
	{ name: 'click_by', description: 'Click an element.', inputSchema: { type: 'object', properties: { role: { type: 'string' }, name: { type: 'string' }, exact: { type: 'boolean' }, texts: { type: 'array', items: { type: 'string' } }, point: { type: 'object' }, settle_seconds: { type: ['number', 'null'] } }, required: ['role'] } },
	{ name: 'export_page', description: 'A tool whose argument has the name of a CLI flag.', inputSchema: { type: 'object', properties: { out: { type: 'string' } } } },
	{ name: 'list_terminals', description: 'List the terminals.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
];

const CATALOG: IParadisCliCatalog = paradisBuildCliCatalog(TOOLS, [{ group: 'browser', parts: [{ text: 'Call set_cursor_label before your first click.' }] }]);
const command = (tool: string) => CATALOG.commands.find(candidate => candidate.tool === tool)!;

/** 引数の名前が camelCase の道具（ほかのテストの品書きには足さない）。 */
const CAMEL_CASE_CATALOG: IParadisCliCatalog = paradisBuildCliCatalog([
	{ name: 'close_browser_tab', description: 'Close a tab.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] } },
	{ name: 'take_snapshot', description: 'Take a snapshot.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, saveTo: { type: 'string' }, path: { type: 'string' } } } },
], []);
const camelCaseCommand = (tool: string) => CAMEL_CASE_CATALOG.commands.find(candidate => candidate.tool === tool)!;

suite('paradisCliCore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	const servers: http.Server[] = [];

	setup(() => {
		root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'para-cli-test-')));
	});

	teardown(async () => {
		for (const server of servers.splice(0)) {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	function write(file: string, content: string): string {
		fs.mkdirSync(dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		return file;
	}

	/** 作業フォルダとホームと、手元の形のポートファイルを持つ実行環境。 */
	function runtime(overrides: Partial<IParadisCliRuntime> & { port?: number } = {}): IParadisCliRuntime & { readonly out: string[]; readonly err: string[] } {
		const out: string[] = [];
		const err: string[] = [];
		fs.mkdirSync(join(root, 'work'), { recursive: true });
		fs.mkdirSync(join(root, 'home'), { recursive: true });
		const portFile = write(join(root, 'user-data', 'paradis-browser-mcp.json'), JSON.stringify({ port: overrides.port ?? 1 }));
		return {
			env: { [PARADIS_CLI_TOKEN_ENV]: 'pane-token', [PARADIS_CLI_PORT_FILE_ENV]: portFile, PARA_CLI_WAIT_SECONDS: '5' },
			cwd: join(root, 'work'),
			home: join(root, 'home'),
			argv: [],
			stdout: text => { out.push(text); },
			stderr: text => { err.push(text); },
			out,
			err,
			...overrides,
		};
	}

	/** 進む時計と、決めた順に答える送信。 */
	function scripted(answers: readonly (ParadisCliAttempt | ((endpoint: IParadisCliEndpoint) => ParadisCliAttempt))[]) {
		let time = 1_000_000;
		const sent: { gateway: boolean; wait?: string }[] = [];
		return {
			sent,
			elapsed: () => time - 1_000_000,
			hooks: {
				now: () => time,
				sleep: async (ms: number) => { time += ms; },
				post: async (endpoint: IParadisCliEndpoint, _token: string, _body: string, headers: Readonly<Record<string, string>>) => {
					sent.push({ gateway: endpoint.gateway, ...(headers[PARADIS_CLI_GATEWAY_WAIT_HEADER] !== undefined ? { wait: headers[PARADIS_CLI_GATEWAY_WAIT_HEADER] } : {}) });
					const answer = answers[Math.min(sent.length - 1, answers.length - 1)];
					return typeof answer === 'function' ? answer(endpoint) : answer;
				},
			},
		};
	}

	const ok: ParadisCliAttempt = { kind: 'response', status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { done: true } }) };
	const refused: ParadisCliAttempt = { kind: 'not-sent', code: 'ECONNREFUSED' };

	async function outcome(run: Promise<unknown>): Promise<string> {
		try {
			return JSON.stringify(await run);
		} catch (error) {
			return `${(error as { exitCode?: number }).exitCode ?? 'error'}: ${(error as Error).message.split(/[.:(] /)[0]}`;
		}
	}

	test('a pane on the machine of Para Code goes straight to its port; a pane on an SSH host goes to the gateway first', async () => {
		const paraCode = join(root, 'home', '.para-code');
		write(join(paraCode, PARADIS_AGENT_GATEWAY_FILE_NAME), JSON.stringify({ protocolVersion: 1, port: 20001, pid: 1 }));
		const local = write(join(root, 'user-data', 'paradis-browser-mcp.json'), JSON.stringify({ port: 47286 }));
		const remote = write(join(paraCode, 'ports', 'pc-1.json'), JSON.stringify({ protocolVersion: 1, port: 30001 }));
		const remoteShared = write(join(paraCode, 'paradis-browser-mcp.json'), JSON.stringify({ port: 30002 }));
		const half = write(join(paraCode, 'ports', 'pc-2.json'), '{"port":');
		const before = { local: await paradisCliEndpoints(local), remote: await paradisCliEndpoints(remote), remoteShared: await paradisCliEndpoints(remoteShared), half: await paradisCliEndpoints(half), none: await paradisCliEndpoints(undefined) };
		write(join(paraCode, PARADIS_AGENT_GATEWAY_FILE_NAME), JSON.stringify({ protocolVersion: 2, port: 20001 }));
		assert.deepStrictEqual({ ...before, unknownGatewayVersion: await paradisCliEndpoints(remote) }, {
			local: [{ port: 47286, gateway: false }],
			remote: [{ port: 20001, gateway: true }, { port: 30001, gateway: false }],
			remoteShared: [{ port: 20001, gateway: true }, { port: 30002, gateway: false }],
			// 書きかけのポートファイルは「まだ」。受け口があればそちらは試す
			half: [{ port: 20001, gateway: true }],
			none: [],
			unknownGatewayVersion: [{ port: 30001, gateway: false }],
		});
	});

	test('an action is sent again only after an answer that means nothing ran', () => {
		const direct = { port: 1, gateway: false };
		const gateway = { port: 2, gateway: true };
		const response = (status: number, text = ''): ParadisCliAttempt => ({ kind: 'response', status, text });
		const verdict = (attempt: ParadisCliAttempt, endpoint: IParadisCliEndpoint) => [paradisCliVerdict(attempt, endpoint, true).action, paradisCliVerdict(attempt, endpoint, false).action].join(' / ');
		assert.deepStrictEqual({
			ok: verdict(response(200), direct),
			refused: verdict(refused, direct),
			sandbox: verdict({ kind: 'not-sent', code: 'EPERM' }, direct),
			brokenAfterConnect: verdict({ kind: 'broken', code: 'ECONNRESET' }, direct),
			gatewayGaveUp: verdict(response(503, JSON.stringify({ error: 'x', code: PARADIS_AGENT_GATEWAY_TIMEOUT_CODE })), gateway),
			gatewayBrokeAfterSending: verdict(response(502), gateway),
			unknownPane: verdict(response(404), direct),
			unknownPaneAtGateway: verdict(response(404), gateway),
			handledThenRefused: [verdict({ kind: 'response', status: 404, text: '', afterDispatch: true }, direct), verdict({ kind: 'response', status: 404, text: '', afterDispatch: true }, gateway)],
			busy: verdict(response(429), direct),
			other: verdict(response(500, 'boom'), direct),
		}, {
			ok: 'done / done',
			refused: 'retry / retry',
			sandbox: 'sandbox / sandbox',
			brokenAfterConnect: 'retry / unknown-state',
			gatewayGaveUp: 'retry / retry',
			gatewayBrokeAfterSending: 'retry / unknown-state',
			unknownPane: 'retry / retry',
			unknownPaneAtGateway: 'next-endpoint / next-endpoint',
			// 本体が処理した後の 404（窓の再読み込みなど）。道具は走ったかもしれない
			handledThenRefused: ['retry / unknown-state', 'retry / unknown-state'],
			busy: 'retry / retry',
			other: 'fail / fail',
		});
	});

	test('waits while Para Code is away and gives up inside its budget, saying whether anything was done', async () => {
		const paraCode = join(root, 'home', '.para-code');
		write(join(paraCode, PARADIS_AGENT_GATEWAY_FILE_NAME), JSON.stringify({ protocolVersion: 1, port: 20001 }));
		const remotePortFile = write(join(paraCode, 'ports', 'pc-1.json'), JSON.stringify({ port: 30001 }));
		const remoteEnv = { [PARADIS_CLI_TOKEN_ENV]: 't', [PARADIS_CLI_PORT_FILE_ENV]: remotePortFile, PARA_CLI_WAIT_SECONDS: '75' };
		const gaveUp: ParadisCliAttempt = { kind: 'response', status: 503, text: JSON.stringify({ code: PARADIS_AGENT_GATEWAY_TIMEOUT_CODE }) };
		const notFound: ParadisCliAttempt = { kind: 'response', status: 404, text: '{}' };

		const comesBack = scripted([refused, refused, ok]);
		const comesBackResult = await outcome(paradisCliRpc({ ...runtime(), ...comesBack.hooks }, 'tools/call', { name: 'click_by' }, false));
		const never = scripted([refused]);
		const neverResult = await outcome(paradisCliRpc({ ...runtime(), ...never.hooks }, 'tools/call', {}, false));
		const brokenAction = scripted([{ kind: 'broken', code: 'ECONNRESET' }, ok]);
		const brokenActionResult = await outcome(paradisCliRpc({ ...runtime(), ...brokenAction.hooks }, 'tools/call', {}, false));
		const brokenRead = scripted([{ kind: 'broken', code: 'ECONNRESET' }, ok]);
		const brokenReadResult = await outcome(paradisCliRpc({ ...runtime(), ...brokenRead.hooks }, 'tools/call', {}, true));
		const gatewayAction502 = scripted([{ kind: 'response', status: 502, text: '' }, ok]);
		const gatewayAction502Result = await outcome(paradisCliRpc({ ...runtime({ env: remoteEnv }), ...gatewayAction502.hooks }, 'tools/call', {}, false));
		const disconnected = scripted([gaveUp]);
		const disconnectedResult = await outcome(paradisCliRpc({ ...runtime({ env: remoteEnv }), ...disconnected.hooks }, 'tools/call', {}, false));
		const gatewayDoesNotKnow = scripted([endpoint => endpoint.gateway ? notFound : ok]);
		const gatewayDoesNotKnowResult = await outcome(paradisCliRpc({ ...runtime({ env: remoteEnv }), ...gatewayDoesNotKnow.hooks }, 'tools/call', {}, false));
		const unknownPane = scripted([notFound]);
		const unknownPaneResult = await outcome(paradisCliRpc({ ...runtime({ env: { ...remoteEnv, [PARADIS_CLI_PORT_FILE_ENV]: join(root, 'user-data', 'paradis-browser-mcp.json') } }), ...unknownPane.hooks }, 'tools/call', {}, false));
		const handled = scripted([{ kind: 'response', status: 404, text: '{}', afterDispatch: true }, ok]);
		const handledResult = await outcome(paradisCliRpc({ ...runtime({ env: remoteEnv }), ...handled.hooks }, 'tools/call', {}, false));
		const sandbox = scripted([{ kind: 'not-sent', code: 'EPERM' }]);
		const sandboxResult = await outcome(paradisCliRpc({ ...runtime(), ...sandbox.hooks }, 'tools/call', {}, false));

		assert.deepStrictEqual({
			comesBack: [comesBackResult, comesBack.sent.length],
			never: [neverResult, never.elapsed()],
			brokenAction: [brokenActionResult, brokenAction.sent.length],
			brokenRead: [brokenReadResult, brokenRead.sent.length],
			gatewayAction502: [gatewayAction502Result, gatewayAction502.sent.length],
			disconnected: [disconnectedResult, disconnected.elapsed(), disconnected.sent[0]],
			gatewayDoesNotKnow: [gatewayDoesNotKnowResult, gatewayDoesNotKnow.sent.map(entry => entry.gateway)],
			unknownPane: [unknownPaneResult, unknownPane.elapsed()],
			handled: [handledResult, handled.sent.length],
			sandbox: [sandboxResult, sandbox.sent.length],
		}, {
			comesBack: ['{"done":true}', 3],
			never: ['3: Para Code did not answer for 5 seconds (ECONNREFUSED)', 5000],
			// 届いたかもしれない操作は送り直さない。読むだけなら送り直す
			brokenAction: ['3: Para Code did not confirm the request after it was sent (ECONNRESET)', 1],
			brokenRead: ['{"done":true}', 2],
			gatewayAction502: ['3: Para Code did not confirm the request after it was sent (HTTP 502)', 1],
			// 受け口には残りの待ち時間を伝える（受け口の既定の 120 秒より先に答えてもらう）
			disconnected: ['3: Para Code did not answer for 75 seconds (the Para Code window is not connected)', 75_000, { gateway: true, wait: '75' }],
			gatewayDoesNotKnow: ['{"done":true}', [true, false]],
			unknownPane: ['3: Para Code does not know this terminal (waited 20 s)', 20_000],
			// 受け口ごしでも、処理した後の 404 では直結へ落として送り直さない
			handled: ['3: Para Code did not confirm the request after it was sent (the terminal changed while the request was handled)', 1],
			sandbox: ['4: Your sandbox blocked the connection to Para Code (Para Code is running; do not restart it)', 1],
		});
	});

	test('a camelCase argument takes the same flag spellings as a snake_case one, in flags and in --json', () => {
		const parse = (...argv: string[]) => paradisCliParseFlags(argv, camelCaseCommand('close_browser_tab')).args;
		assert.deepStrictEqual([
			parse('--tab-id', 'a'),
			parse('--tab_id', 'a'),
			parse('--tabId', 'a'),
			parse('--json', '{"tab_id":"a"}'),
			parse('--json', '{"tab-id":"a"}'),
			parse('--json', '{"tabId":"a","other":1}'),
		], [{ tabId: 'a' }, { tabId: 'a' }, { tabId: 'a' }, { tabId: 'a' }, { tabId: 'a' }, { tabId: 'a', other: 1 }]);
	});

	test('relative file arguments are resolved from the folder para was run in', () => {
		// Windows でも通るよう、期待する値は同じ path の関数で作る
		const cwd = join(root, 'repo');
		const parse = (...argv: string[]) => paradisCliParseFlags(argv, camelCaseCommand('take_snapshot'), cwd).args;
		assert.deepStrictEqual({
			relative: parse('--file-path', 'out/snap.txt', '--save-to', '../shot.png'),
			absolute: parse('--file-path', join(root, 'snap.txt')),
			json: parse('--json', '{"filePath":"snap.txt"}'),
			// read_download の path のように、道具が返した絶対パスだけを受ける引数は変えない
			otherArguments: parse('--path', 'sample.csv'),
			withoutCwd: paradisCliParseFlags(['--file-path', 'snap.txt'], camelCaseCommand('take_snapshot')).args,
		}, {
			relative: { filePath: join(cwd, 'out', 'snap.txt'), saveTo: join(root, 'shot.png') },
			absolute: { filePath: join(root, 'snap.txt') },
			json: { filePath: join(cwd, 'snap.txt') },
			otherArguments: { path: 'sample.csv' },
			withoutCwd: { filePath: 'snap.txt' },
		});
	});

	test('flags become the arguments of the tool; unknown flags, wrong types and missing ones are refused', () => {
		const parse = (tool: string, ...argv: string[]) => {
			try {
				return paradisCliParseFlags(argv, command(tool)).args;
			} catch (error) {
				return error instanceof ParadisCliUsageError ? `usage: ${error.message.split('. ')[0]}` : `other: ${error}`;
			}
		};
		assert.deepStrictEqual({
			kebab: parse('get_text', '--max-chars', '200', '--tab-id=tab-1'),
			underscore: parse('get_text', '--max_chars', '200', '--selector', 'h1'),
			booleans: [parse('click_by', '--role', 'button', '--exact'), parse('click_by', '--role', 'button', '--exact', 'false'), parse('click_by', '--role', 'button', '--no-exact')],
			list: parse('click_by', '--role', 'a', '--texts', 'one', '--texts', '["two","three"]'),
			object: parse('click_by', '--role', 'a', '--point', '{"x":1}'),
			numberOrNull: [parse('click_by', '--role', 'a', '--settle-seconds', '0.5'), parse('click_by', '--role', 'a', '--settle-seconds', 'null')],
			json: parse('click_by', '--json', '{"role":"button","name":"Save"}', '--name', 'Send'),
			// 道具の引数が CLI のフラグと同じ名前なら、引数が勝つ
			collision: [parse('export_page', '--out', 'x.pdf'), paradisCliParseFlags(['--out', 'x.png'], command('get_text')).out],
			unknown: parse('get_text', '--timeout', '5'),
			notANumber: parse('get_text', '--max-chars', 'many'),
			missing: parse('click_by', '--name', 'Save'),
			positional: parse('get_text', 'h1'),
			badJson: parse('get_text', '--json', '[1]'),
			noValue: parse('get_text', '--selector'),
		}, {
			kebab: { max_chars: 200, tab_id: 'tab-1' },
			underscore: { max_chars: 200, selector: 'h1' },
			booleans: [{ role: 'button', exact: true }, { role: 'button', exact: false }, { role: 'button', exact: false }],
			list: { role: 'a', texts: ['one', 'two', 'three'] },
			object: { role: 'a', point: { x: 1 } },
			numberOrNull: [{ role: 'a', settle_seconds: 0.5 }, { role: 'a', settle_seconds: null }],
			json: { role: 'button', name: 'Send' },
			collision: [{ out: 'x.pdf' }, 'x.png'],
			unknown: 'usage: Unknown flag --timeout',
			notANumber: 'usage: --max-chars takes a number, got "many".',
			missing: 'usage: Missing --role',
			positional: 'usage: Unexpected argument "h1"',
			badJson: 'usage: --json takes a JSON object with the arguments, for example --json \'{"url":"https://example.com"}\'.',
			noValue: 'usage: --selector needs a value.',
		});
	});

	test('--out only accepts a new file inside the current folder or the Para Code folder, after resolving links', async () => {
		const work = join(root, 'work');
		const home = join(root, 'home');
		const outside = join(root, 'outside');
		for (const folder of [work, home, outside, join(work, '.git'), join(work, 'sub')]) {
			fs.mkdirSync(folder, { recursive: true });
		}
		write(join(work, 'taken.png'), 'x');
		let linked = true;
		try {
			fs.symlinkSync(outside, join(work, 'escape'), 'dir');
		} catch {
			linked = false; // リンクを作れない環境（権限の無い Windows）
		}
		const check = async (out: string) => {
			try {
				return (await paradisCliCheckOutputPath(out, work, home)).slice(root.length).replace(/\\/g, '/');
			} catch (error) {
				return error instanceof ParadisCliUsageError ? 'refused' : `other: ${error}`;
			}
		};
		assert.deepStrictEqual({
			relative: await check('shot.png'),
			newFolders: await check('shots/today/a.png'),
			absoluteInside: await check(join(work, 'sub', 'b.png')),
			paraCodeFolder: await check(join(home, '.para-code', 'browser-files', 'c.png')),
			tilde: await check('~/.para-code/browser-files/d.png'),
			temporary: await check(join(tmpdir(), 'para-cli-outside.png')),
			parent: await check('../outside/e.png'),
			dotDotInside: await check('sub/../../home/f.png'),
			homeItself: await check(join(home, 'g.png')),
			otherParaCodeFolder: await check(join(home, '.para-code', 'hooks', 'h.png')),
			throughLink: linked ? await check('escape/i.png') : 'refused',
			existing: await check('taken.png'),
			git: await check('.git/j.png'),
			theFolderItself: await check('.'),
			empty: await check(''),
		}, {
			relative: '/work/shot.png',
			newFolders: '/work/shots/today/a.png',
			absoluteInside: '/work/sub/b.png',
			paraCodeFolder: '/home/.para-code/browser-files/c.png',
			tilde: '/home/.para-code/browser-files/d.png',
			temporary: 'refused',
			parent: 'refused',
			dotDotInside: 'refused',
			homeItself: 'refused',
			otherParaCodeFolder: 'refused',
			throughLink: 'refused',
			existing: 'refused',
			git: 'refused',
			theFolderItself: 'refused',
			empty: 'refused',
		});
	});

	test('the conversation key is a hash of the id the agent gives its shell, and the same for a parent and its subagents', () => {
		const claude = paradisCliCallMeta({ CLAUDE_CODE_SESSION_ID: 'session-1' });
		assert.deepStrictEqual({
			hidden: claude.conversation !== undefined && !claude.conversation.includes('session-1') && claude.conversation.length === 32,
			stable: paradisCliCallMeta({ CLAUDE_CODE_SESSION_ID: 'session-1', CLAUDE_CODE_CHILD_SESSION: '1' }).conversation === claude.conversation,
			other: paradisCliCallMeta({ CLAUDE_CODE_SESSION_ID: 'session-2' }).conversation !== claude.conversation,
			codex: paradisCliCallMeta({ CODEX_THREAD_ID: 'thread-1' }).conversation !== undefined,
			typedByAPerson: paradisCliCallMeta({}),
		}, { hidden: true, stable: true, other: true, codex: true, typedByAPerson: {} });
	});

	test('the permission rules for Claude Code hold the reading commands under every name, and the acting ones only on request', () => {
		const reading = paradisCliClaudePermissions(CATALOG, false);
		const all = paradisCliClaudePermissions(CATALOG, true);
		assert.deepStrictEqual({
			reading,
			acting: all.filter(rule => !reading.includes(rule)),
		}, {
			reading: [
				'Bash(para help:*)', 'Bash(para --help)', 'Bash(para commands:*)', 'Bash(para status)', 'Bash(para permissions:*)',
				'Bash(para browser get-text:*)', 'Bash(para browser text:*)', 'Bash(para browser get_text:*)',
				'Bash(para browser take-screenshot:*)', 'Bash(para browser screenshot:*)', 'Bash(para browser take_screenshot:*)',
				'Bash(para terminal list-terminals:*)', 'Bash(para terminal list:*)', 'Bash(para terminal list_terminals:*)',
			],
			acting: ['Bash(para browser click-by:*)', 'Bash(para browser click_by:*)', 'Bash(para browser export-page:*)', 'Bash(para browser export_page:*)'],
		});
	});

	test('reading or waiting for another terminal and switching the page of the pane are asked every time, although they only read', () => {
		const readOnly = { annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } };
		const catalog = paradisBuildCliCatalog(['list_terminals', 'read_terminal', 'wait_for_terminal', 'select_page', 'list_pages'].map(name => ({ name, description: '', ...readOnly })), []);
		const reading = paradisCliClaudePermissions(catalog, false);
		assert.deepStrictEqual({
			marks: catalog.commands.map(command => command.readOnly),
			reading: reading.slice(5),
			onRequest: paradisCliClaudePermissions(catalog, true).filter(rule => !reading.includes(rule)),
		}, {
			marks: [true, true, true, true, true],
			reading: [
				'Bash(para terminal list-terminals:*)', 'Bash(para terminal list:*)', 'Bash(para terminal list_terminals:*)',
				'Bash(para browser list-pages:*)', 'Bash(para browser list_pages:*)',
			],
			onRequest: [
				'Bash(para terminal read-terminal:*)', 'Bash(para terminal read:*)', 'Bash(para terminal read_terminal:*)',
				'Bash(para terminal wait-for-terminal:*)', 'Bash(para terminal wait:*)', 'Bash(para terminal wait_for_terminal:*)',
				'Bash(para browser select-page:*)', 'Bash(para browser select_page:*)',
			],
		});
	});

	test('runs commands against a server: help from the catalog, calls by any name, images to files, exit codes', async () => {
		const requests: { method: string; params: { name?: string; arguments?: unknown; _meta?: Record<string, { conversation?: string }> }; token: string | undefined }[] = [];
		const server = (await import('http')).createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				requests.push({ method: rpc.method, params: rpc.params ?? {}, token: req.headers.authorization });
				const tool = rpc.params?.name;
				const result = rpc.method === PARADIS_CLI_CATALOG_METHOD ? CATALOG
					: rpc.method === 'ping' ? {}
						: tool === 'take_screenshot' ? { content: [{ type: 'text', text: 'Took a screenshot.' }, { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }] }
							: tool === 'click_by' ? { isError: true, content: [{ type: 'text', text: 'No element matches.' }] }
								: { content: [{ type: 'text', text: `text of ${JSON.stringify(rpc.params?.arguments)}` }] };
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
			});
		});
		servers.push(server);
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
		const port = (server.address() as AddressInfo).port;
		const run = async (...argv: string[]) => {
			const base = runtime({ port });
			const cli = { ...base, argv, env: { ...base.env, CLAUDE_CODE_SESSION_ID: 'session-1' } };
			const code = await paradisRunCli(cli);
			return { code, out: cli.out.join(''), err: cli.err.join('') };
		};

		const top = await run();
		const group = await run('help', 'browser');
		const commandHelp = await run('help', 'browser', 'click_by');
		const byAlias = await run('browser', 'text', '--selector', 'h1');
		const byToolName = await run('browser', 'get_text', '--max-chars', '5');
		const byCall = await run('call', 'get_text', '--json', '{"selector":"p"}');
		const shot = await run('browser', 'screenshot');
		const shotOut = await run('browser', 'screenshot', '--out', 'shots/a.png');
		const shotOutside = await run('browser', 'screenshot', '--out', join(tmpdir(), 'para-cli-outside.png'));
		const toolError = await run('browser', 'click-by', '--role', 'button');
		const usage = await run('browser', 'click-by');
		const wrongGroup = await run('browser', 'list-terminals');
		const unknownGroup = await run('nothing', 'here');
		const status = await run('status');
		const savedDefault = /\[image saved: (.*)\]/.exec(shot.out)?.[1] ?? '';

		assert.deepStrictEqual({
			top: [top.code, top.out.includes('browser   The built-in browser'), top.out.includes('Exit code 3'), top.out.includes('para help <group> <command>')],
			group: [group.out.includes('Call set_cursor_label before your first click.'), group.out.includes('R text, get-text'), group.out.includes('A click-by')],
			commandHelp: [commandHelp.out.split('\n')[0], commandHelp.out.includes('--role <string>  (required)'), commandHelp.out.includes('--settle-seconds <number|null>')],
			byAlias: [byAlias.code, byAlias.out],
			byToolName: byToolName.out,
			byCall: byCall.out,
			shot: [shot.code, savedDefault.slice(root.length).replace(/\\/g, '/').replace(/shot-.*$/, 'shot-*'), fs.readFileSync(savedDefault).equals(PNG)],
			shotOut: [shotOut.code, fs.readFileSync(join(root, 'work', 'shots', 'a.png')).equals(PNG)],
			// 場所の誤りは、送る前に断る
			shotOutside: [shotOutside.code, requests.filter(request => request.params.name === 'take_screenshot').length],
			toolError: [toolError.code, toolError.out],
			usage: [usage.code, usage.err.split('. ')[0]],
			wrongGroup: [wrongGroup.code, wrongGroup.err.trim()],
			unknownGroup: [unknownGroup.code, unknownGroup.err.split('. ')[0]],
			status: [status.code, /^Para Code answers \(\d+ ms\)\.\n$/.test(status.out)],
			// 品書きはホームに控える。聞き直すのは、控えに無いコマンド・分野を探したとき（2 回）だけ。トークンは Bearer で送り、控えには入れない
			catalogRequests: requests.filter(request => request.method === PARADIS_CLI_CATALOG_METHOD).length,
			tokens: [...new Set(requests.map(request => request.token))],
			cacheHasToken: fs.readdirSync(join(root, 'home', '.para-code', 'cli-cache')).some(name => fs.readFileSync(join(root, 'home', '.para-code', 'cli-cache', name), 'utf8').includes('pane-token')),
			conversation: [...new Set(requests.map(request => request.params._meta?.[PARADIS_CLI_META_KEY]?.conversation?.length))],
			protocol: CATALOG.protocolVersion === PARADIS_CLI_PROTOCOL_VERSION,
		}, {
			top: [0, true, true, true],
			group: [true, true, true],
			commandHelp: ['para browser click-by [flags]   (acts; tool click_by)', true, true],
			byAlias: [0, 'text of {"selector":"h1"}\n'],
			byToolName: 'text of {"max_chars":5}\n',
			byCall: 'text of {"selector":"p"}\n',
			shot: [0, '/home/.para-code/browser-files/para-cli/shot-*', true],
			shotOut: [0, true],
			shotOutside: [2, 2],
			toolError: [1, 'No element matches.\n'],
			usage: [2, 'para: Missing --role'],
			wrongGroup: [2, 'para: "list-terminals" is in the group terminal: para terminal list-terminals.'],
			unknownGroup: [2, 'para: Unknown group "nothing"'],
			status: [0, true],
			catalogRequests: 3,
			tokens: ['Bearer pane-token'],
			cacheHasToken: false,
			conversation: [32],
			protocol: true,
		});
	});

	test('the pane environment puts the launcher folder first on PATH and names the executable that runs the script', () => {
		const posix = paradisAddParaCliToPaneEnvironment({ PATH: '/codex/bin:${env:PATH}', VSCODE_PATH_PREFIX: '/codex/bin:', KEEP: '1' }, { launcherDirectory: '/app/resources/paradis/cli', pathDelimiter: ':', nodeExecutablePath: '/app/para-code' });
		const windowsRuntime = { launcherDirectory: 'C:\\app\\resources\\paradis\\cli', pathDelimiter: ';', nodeExecutablePath: 'C:\\app\\Para Code.exe' };
		const windows = paradisAddParaCliToPaneEnvironment(undefined, { launcherDirectory: 'C:\\app\\resources\\paradis\\cli', pathDelimiter: ';' });
		assert.deepStrictEqual({
			// Windows の PATH の鍵は多くが `Path`。別の鍵を並べず、ある鍵に足す
			windowsPathKey: paradisAddParaCliToPaneEnvironment({ Path: 'C:\\tools', OTHER: null }, windowsRuntime),
			// 渡した環境変数だけで起動する端末では ${env:PATH} が解決されない。PATH が無ければ足さない
			strictWithoutPath: [paradisAddParaCliToPaneEnvironment({ KEEP: '1' }, windowsRuntime, true), paradisAddParaCliToPaneEnvironment({ KEEP: '1' }, { launcherDirectory: '/app/cli', pathDelimiter: ':' }, true)],
			strictWithPath: paradisAddParaCliToPaneEnvironment({ PATH: '/usr/bin' }, { launcherDirectory: '/app/cli', pathDelimiter: ':' }, true),
		}, {
			windowsPathKey: { Path: 'C:\\app\\resources\\paradis\\cli;C:\\tools', OTHER: null, PARA_CODE_CLI_NODE: 'C:\\app\\Para Code.exe' },
			strictWithoutPath: [{ KEEP: '1', PARA_CODE_CLI_NODE: 'C:\\app\\Para Code.exe' }, { KEEP: '1' }],
			strictWithPath: { PATH: '/app/cli:/usr/bin', VSCODE_PATH_PREFIX: '/app/cli:' },
		});
		assert.deepStrictEqual({ posix, windows, none: paradisAddParaCliToPaneEnvironment({ KEEP: '1' }, undefined), target: paradisCliRemoteTargetContent('/srv/node', '/srv/out/cli.js') }, {
			posix: { PATH: '/app/resources/paradis/cli:/codex/bin:${env:PATH}', VSCODE_PATH_PREFIX: '/app/resources/paradis/cli:/codex/bin:', KEEP: '1', PARA_CODE_CLI_NODE: '/app/para-code' },
			windows: { PATH: 'C:\\app\\resources\\paradis\\cli;${env:PATH}' },
			none: { KEEP: '1' },
			target: '/srv/node\n/srv/out/cli.js\n',
		});
	});

	test('the launcher runs the script named in para.target on a host, and says so when that server is gone', async function () {
		if (isWindows) {
			this.skip();
		}
		// out/ の隣がリポジトリ（配布版ではアプリ）のルート
		const appRoot = dirname(FileAccess.asFileUri('').fsPath);
		const launcher = join(root, 'bin', PARADIS_CLI_LAUNCHER_NAME);
		fs.mkdirSync(join(root, 'bin'), { recursive: true });
		fs.copyFileSync(join(appRoot, ...PARADIS_CLI_LAUNCHER_FOLDER_SEGMENTS, PARADIS_CLI_LAUNCHER_NAME), launcher);
		fs.chmodSync(launcher, 0o755);
		const script = write(join(root, 'server', 'cli.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
		const run = () => new Promise<{ code: number; out: string; err: string }>(resolve => {
			execFile(launcher, ['browser', 'text', '--selector', 'a b'], { env: { PATH: process.env.PATH ?? '' } }, (error, out, err) => resolve({ code: error ? Number((error as { code?: unknown }).code) : 0, out, err: err.split('.')[0] }));
		});
		write(join(root, 'bin', PARADIS_CLI_REMOTE_TARGET_NAME), paradisCliRemoteTargetContent(process.execPath, script));
		const works = await run();
		write(join(root, 'bin', PARADIS_CLI_REMOTE_TARGET_NAME), paradisCliRemoteTargetContent(process.execPath, join(root, 'server', 'gone.js')));
		const gone = await run();
		assert.deepStrictEqual({ works, gone }, {
			works: { code: 0, out: '["browser","text","--selector","a b"]', err: '' },
			gone: { code: 3, out: '', err: 'para: the Para Code server this command belongs to is gone from this host (it was updated or removed)' },
		});
	});

	test('the names this file shares with the gateway are the same', () => {
		assert.deepStrictEqual([PARADIS_CLI_GATEWAY_WAIT_HEADER, PARADIS_CLI_AFTER_DISPATCH_HEADER], [PARADIS_AGENT_GATEWAY_WAIT_SECONDS_HEADER, PARADIS_AGENT_GATEWAY_AFTER_DISPATCH_HEADER]);
	});
});
