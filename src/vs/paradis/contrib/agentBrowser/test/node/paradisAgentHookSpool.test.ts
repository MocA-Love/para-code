/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// hook の控え（W2-20）。本物の notify.sh を受け口の無い状態・404 を返す状態で動かして控えの中身を
// 確かめ、読み取り側（取り出し・掃除）がそれを読めることを確かめる。

import assert from 'assert';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_MCP_PORT_FILE_ENV_VAR, PARADIS_PANE_TOKEN_ENV_VAR } from '../../common/paradisAgentBrowser.js';
import { PARADIS_AGENT_HOOK_SPOOL_DIR_NAME, PARADIS_AGENT_HOOK_SPOOL_MAX_AGE_MS } from '../../common/paradisAgentHookSpool.js';
import { paradisGetNotifyScriptContent } from '../../node/paradisAgentHooksSetup.js';
import { paradisAgentHookSpoolHash, paradisPruneAgentHookSpool, paradisTakeAgentHookSpool } from '../../node/paradisAgentHookSpoolStore.js';

const execFileAsync = promisify(execFile);
const TOKEN = 'pane-token-for-spool';

async function listen(status: number): Promise<{ server: Server; port: number; hits: string[] }> {
	const hits: string[] = [];
	const { createServer } = await import('http');
	const server = createServer((request, response) => {
		request.resume();
		request.on('end', () => {
			hits.push(request.url ?? '');
			response.writeHead(status, { 'Content-Type': 'application/json' });
			response.end('{}');
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	return { server, port: (server.address() as AddressInfo).port, hits };
}

async function close(server: Server): Promise<void> {
	if (server.listening) {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}

suite('paradisAgentHookSpool (node)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-hook-spool-'));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	/** 標準エラーに出たもの（控えのたびに何も出ないこと）。 */
	const stderrs: string[] = [];

	async function runHook(payload: string, portFilePath: string): Promise<void> {
		const scriptPath = join(root, 'notify.sh');
		await fs.writeFile(scriptPath, paradisGetNotifyScriptContent(), { mode: 0o755 });
		await fs.chmod(scriptPath, 0o755);
		const payloadPath = join(root, 'payload.json');
		await fs.writeFile(payloadPath, payload);
		const { stderr } = await execFileAsync('/bin/sh', ['-c', 'cat "$PAYLOAD_FILE" | "$HOOK_SCRIPT"'], {
			env: { PATH: process.env['PATH'], HOOK_SCRIPT: scriptPath, PAYLOAD_FILE: payloadPath, [PARADIS_PANE_TOKEN_ENV_VAR]: TOKEN, [PARADIS_MCP_PORT_FILE_ENV_VAR]: portFilePath },
			timeout: 15_000,
		});
		if (stderr.length > 0) {
			stderrs.push(stderr);
		}
	}

	test('keeps only unreachable and not-yet-synced hooks, privately, under a hash of the pane token, with only the fields that tell the state', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		this.timeout(30_000);
		const spoolDir = join(root, PARADIS_AGENT_HOOK_SPOOL_DIR_NAME);
		// 1) ポートファイルが無い（Para Code が止まっている）。依頼の文面は控えに残さない。
		const portFilePath = join(root, 'mcp-port.json');
		await runHook('{"session_id":"s1",\n"cwd":"/repo","hook_event_name":"UserPromptSubmit","prompt":"secret plan"}', portFilePath);
		// 2) ポートファイルはあるが誰も聞いていない。ツールの開始は控えない。
		const closed = await listen(200);
		await close(closed.server);
		await fs.writeFile(portFilePath, JSON.stringify({ port: closed.port }));
		await runHook('{"hook_event_name":"PreToolUse","tool_name":"Bash"}', portFilePath);
		await runHook('{"hook_event_name":"Stop","session_id":"s1","transcript_path":"/Users/example/.claude/projects/x \\"q\\".jsonl"}', portFilePath);
		// 3) ペインがまだ同期されていない（503）。ツールの入力は控えに残さない。
		const notYet = await listen(503);
		try {
			await fs.writeFile(portFilePath, JSON.stringify({ port: notYet.port }));
			await runHook('{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -rf secret"}}', portFilePath);
		} finally {
			await close(notYet.server);
		}
		// 4) 知らない・終わったペイン（404）と、届いた hook は控えない。
		for (const status of [404, 200]) {
			const server = await listen(status);
			try {
				await fs.writeFile(portFilePath, JSON.stringify({ port: server.port }));
				await runHook('{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}', portFilePath);
			} finally {
				await close(server.server);
			}
		}

		const fileName = `pane-${paradisAgentHookSpoolHash(TOKEN)}.jsonl`;
		const dirMode = (await fs.stat(spoolDir)).mode & 0o777;
		const fileMode = (await fs.stat(join(spoolDir, fileName))).mode & 0o777;
		const raw = await fs.readFile(join(spoolDir, fileName), 'utf8');
		const records = await paradisTakeAgentHookSpool(spoolDir, TOKEN);
		assert.deepStrictEqual({
			files: [fileName],
			dirMode: dirMode.toString(8),
			fileMode: fileMode.toString(8),
			secretsOnDisk: [TOKEN, 'secret plan', 'rm -rf'].filter(secret => raw.includes(secret)),
			events: records.map(record => record.event),
			payloads: records.map(record => record.payload),
			idsDistinct: new Set(records.map(record => record.id)).size === records.length && records.every(record => typeof record.id === 'string'),
			afterTake: await fs.readdir(spoolDir),
			stderrs,
		}, {
			files: [fileName],
			dirMode: '700',
			fileMode: '600',
			secretsOnDisk: [],
			events: ['UserPromptSubmit', 'Stop', 'PermissionRequest'],
			payloads: [
				{ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/repo' },
				{ hook_event_name: 'Stop', session_id: 's1', transcript_path: '/Users/example/.claude/projects/x "q".jsonl' },
				{ hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
			],
			idsDistinct: true,
			afterTake: [],
			// 最初の控え（まだファイルが無い）でも、何も標準エラーへ出さない。
			stderrs: [],
		});
	});

	test('pruning removes old and half-read spools only', async () => {
		const dir = join(root, PARADIS_AGENT_HOOK_SPOOL_DIR_NAME);
		await fs.mkdir(dir);
		const fresh = `pane-${paradisAgentHookSpoolHash('fresh')}.jsonl`;
		const old = `pane-${paradisAgentHookSpoolHash('old')}.jsonl`;
		const halfRead = `pane-${paradisAgentHookSpoolHash('half')}.jsonl.replaying-abcd`;
		for (const name of [fresh, old, halfRead, 'unrelated.txt']) {
			await fs.writeFile(join(dir, name), '');
		}
		const oldTime = new Date(Date.now() - PARADIS_AGENT_HOOK_SPOOL_MAX_AGE_MS - 60_000);
		await fs.utimes(join(dir, old), oldTime, oldTime);
		assert.deepStrictEqual({ removed: await paradisPruneAgentHookSpool(dir), left: (await fs.readdir(dir)).sort() }, { removed: 2, left: [fresh, 'unrelated.txt'].sort() });
	});
});
