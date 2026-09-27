/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { join } from '../../../../../base/common/path.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_MCP_PORT_FILE_ENV_VAR, PARADIS_PANE_TOKEN_ENV_VAR } from '../../common/paradisAgentBrowser.js';
import { PARADIS_AGENT_HOOK_SCHEMA_VERSION, PARADIS_CLAUDE_ACTIVITY_HOOK_EVENTS, PARADIS_CODEX_HOOK_EVENTS, paradisManagedAgentHookCommand, paradisManagedHookDefinition } from '../../common/paradisAgentHooks.js';
import { ParadisAgentHooksReconciler, paradisGetNotifyScriptContent, paradisGetNotifyScriptContentPs1, paradisMergeAgentHooksFile, paradisMergeAgentHooksJson, paradisRemoveAgentHooks, paradisRemoveAgentHooksJson, paradisSupportsClaudeActivityHooks, paradisSupportsClaudeMessageDisplay, paradisWriteFileAtomicallySync } from '../../node/paradisAgentHooksSetup.js';

const execFileAsync = promisify(execFile);

async function writeNotifyFixture(root: string): Promise<string> {
	const scriptPath = join(root, 'notify.sh');
	await fs.writeFile(scriptPath, paradisGetNotifyScriptContent(), { mode: 0o755 });
	await fs.chmod(scriptPath, 0o755);
	return scriptPath;
}

async function runPipedNotifyScript(scriptPath: string, payloadPath: string, env: NodeJS.ProcessEnv): Promise<void> {
	await execFileAsync('/bin/bash', ['-o', 'pipefail', '-c', 'cat "$PAYLOAD_FILE" | "$HOOK_SCRIPT"'], {
		env: { PATH: process.env['PATH'], HOOK_SCRIPT: scriptPath, PAYLOAD_FILE: payloadPath, ...env },
		timeout: 10_000,
	});
}

suite('ParadisAgentHooksSetup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers only the activity events consumed by the mobile UI', () => {
		assert.deepStrictEqual(PARADIS_CLAUDE_ACTIVITY_HOOK_EVENTS.map(event => event.eventName), [
			'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle', 'PreCompact', 'PostCompact',
		]);
	});

	test('gates activity hooks on the verified Claude Code version', () => {
		assert.deepStrictEqual([
			paradisSupportsClaudeActivityHooks('2.1.206 (Claude Code)'),
			paradisSupportsClaudeActivityHooks('2.1.207 (Claude Code)'),
			paradisSupportsClaudeActivityHooks('2.2.0'),
			paradisSupportsClaudeActivityHooks('not-a-version'),
		], [false, true, true, false]);
	});

	test('keeps the existing MessageDisplay minimum version', () => {
		assert.deepStrictEqual([
			paradisSupportsClaudeMessageDisplay('2.1.204'),
			paradisSupportsClaudeMessageDisplay('2.1.205'),
			paradisSupportsClaudeMessageDisplay('2.1.206'),
		], [false, true, true]);
	});

	test('marks managed commands with the current schema', () => {
		assert.ok(paradisManagedAgentHookCommand().includes(`notify-v${PARADIS_AGENT_HOOK_SCHEMA_VERSION}.sh`));
	});

	test('bakes the port file location in for the SSH host, where the env var points at this machine', () => {
		const remote = paradisGetNotifyScriptContent('/home/user/.para-code/paradis-browser-mcp.json');
		const local = paradisGetNotifyScriptContent();

		assert.deepStrictEqual(
			{
				// 接続先版はその場所を直接見る。env を経由しない（手元のパスが渡ってくるため）
				remoteReadsBakedPath: remote.includes('"/home/user/.para-code/paradis-browser-mcp.json"'),
				remoteIgnoresEnvVar: !remote.includes('PARA_CODE_MCP_PORT_FILE'),
				// ペイントークンの判定は接続先でも要る（Para Code の外では素通りさせる）
				remoteStillChecksPaneToken: remote.includes('PARA_CODE_TERMINAL_PANE_ID'),
				// 手元版は今までどおり env を見る
				localReadsEnvVar: local.includes('"$PARA_CODE_MCP_PORT_FILE"')
			},
			{
				remoteReadsBakedPath: true,
				remoteIgnoresEnvVar: true,
				remoteStillChecksPaneToken: true,
				localReadsEnvVar: true
			}
		);
	});

	test('marks the hooks it installs on an SSH host as coming from that host', () => {
		// 受け手はこの印だけで「手元では開けない記録」と判断する。綴りで見分けると、
		// 接続先とユーザー名が同じ機械では手元のホーム配下と区別が付かない
		const remote = paradisGetNotifyScriptContent('/home/example/.para-code/paradis-browser-mcp.json', 'ssh-remote-server');
		const local = paradisGetNotifyScriptContent();

		assert.deepStrictEqual(
			{
				remoteNamesItsHost: remote.includes('&host=ssh-remote-server"'),
				localNamesNoHost: !local.includes('&host='),
				// 印を付けずに置いた接続先版は、これまでどおり印無しで届く（旧版が残っていても壊れない）
				unmarkedRemoteNamesNoHost: !paradisGetNotifyScriptContent('/home/example/.para-code/paradis-browser-mcp.json').includes('&host='),
			},
			{ remoteNamesItsHost: true, localNamesNoHost: true, unmarkedRemoteNamesNoHost: true }
		);
	});

	test('migrates older-schema managed hooks to the current schema without removing user hooks', () => {
		const schema1Command = '[ -x "$HOME/.para-code/hooks/notify-v1.sh" ] && "$HOME/.para-code/hooks/notify-v1.sh" || true';
		const userHook = { type: 'command', command: '/tmp/user-hook.sh' };
		const existing = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: schema1Command }, userHook] }] } });
		const merged = paradisMergeAgentHooksJson(existing, [{ eventName: 'Stop' }]);

		assert.strictEqual(PARADIS_AGENT_HOOK_SCHEMA_VERSION, 3);
		assert.ok(merged !== undefined);
		const parsed = JSON.parse(merged) as { hooks: Record<string, readonly { hooks: readonly { command: string }[] }[]> };
		assert.deepStrictEqual(parsed.hooks.Stop.flatMap(definition => definition.hooks.map(hook => hook.command)), [
			'/tmp/user-hook.sh',
			paradisManagedAgentHookCommand(),
		]);
		assert.ok(!merged.includes('notify-v1.sh'));
	});

	test('drains a large stdin payload before exiting outside Para Code', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		this.timeout(15_000);
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-agent-hook-drain-'));
		try {
			const scriptPath = await writeNotifyFixture(root);
			const payloadPath = join(root, 'large-hook.json');
			await fs.writeFile(payloadPath, Buffer.alloc(8 * 1024 * 1024, 0x78));

			await runPipedNotifyScript(scriptPath, payloadPath, {});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('falls back to a bodyless request after draining an oversized active payload', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		this.timeout(15_000);
		const { createServer } = await import('http');
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-agent-hook-oversize-'));
		const requests: { method: string | undefined; bodyBytes: number }[] = [];
		const server = createServer((request, response) => {
			let bodyBytes = 0;
			request.on('data', chunk => bodyBytes += Buffer.byteLength(chunk));
			request.on('end', () => {
				requests.push({ method: request.method, bodyBytes });
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.end('{"ok":true}');
			});
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, '127.0.0.1', resolve);
			});
			const port = (server.address() as AddressInfo).port;
			const portFilePath = join(root, 'mcp-port.json');
			await fs.writeFile(portFilePath, JSON.stringify({ port }));
			const scriptPath = await writeNotifyFixture(root);
			const payloadPath = join(root, 'oversized-hook.json');
			const tempDirectory = join(root, 'tmp');
			const binDirectory = join(root, 'bin');
			const capturedSpoolSizePath = join(root, 'captured-spool-size.txt');
			await fs.mkdir(tempDirectory);
			await fs.mkdir(binDirectory);
			const wcPath = join(binDirectory, 'wc');
			await fs.writeFile(wcPath, [
				'#!/bin/sh',
				'BYTES=$(/usr/bin/wc -c)',
				'printf \'%s\' "$BYTES" >"$CAPTURED_SPOOL_SIZE"',
				'printf \'%s\' "$BYTES"',
				'',
			].join('\n'), { mode: 0o755 });
			await fs.chmod(wcPath, 0o755);
			const prefix = '{"hook_event_name":"PostToolUse","padding":"';
			await fs.writeFile(payloadPath, `${prefix}${'x'.repeat(4 * 1024 * 1024)}"}`);

			await runPipedNotifyScript(scriptPath, payloadPath, {
				[PARADIS_PANE_TOKEN_ENV_VAR]: 'pane-token',
				[PARADIS_MCP_PORT_FILE_ENV_VAR]: portFilePath,
				TMPDIR: tempDirectory,
				PATH: `${binDirectory}:${process.env['PATH']}`,
				CAPTURED_SPOOL_SIZE: capturedSpoolSizePath,
			});

			assert.deepStrictEqual(requests, [{ method: 'GET', bodyBytes: 0 }]);
			assert.strictEqual(Number(await fs.readFile(capturedSpoolSizePath, 'utf8')), 4 * 1024 * 1024 + 1, 'the spool must retain only enough bytes to detect overflow');
			assert.deepStrictEqual(await fs.readdir(tempDirectory), [], 'the private spool file must be removed on exit');
		} finally {
			if (server.listening) {
				await new Promise<void>(resolve => server.close(() => resolve()));
			}
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('preserves a small active payload as an exact POST body', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		this.timeout(15_000);
		const { createServer } = await import('http');
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-agent-hook-post-'));
		let received: { method: string | undefined; body: string; authorization: string | undefined; tokenInUrl: boolean } | undefined;
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on('data', chunk => chunks.push(Buffer.from(chunk)));
			request.on('end', () => {
				received = { method: request.method, body: Buffer.concat(chunks).toString('utf8'), authorization: request.headers.authorization, tokenInUrl: (request.url ?? '').includes('pane-token') };
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.end('{"ok":true}');
			});
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, '127.0.0.1', resolve);
			});
			const portFilePath = join(root, 'mcp-port.json');
			await fs.writeFile(portFilePath, JSON.stringify({ port: (server.address() as AddressInfo).port }));
			const scriptPath = await writeNotifyFixture(root);
			const payloadPath = join(root, 'small-hook.json');
			const payload = '{"hook_event_name":"Stop","message":"完了"}';
			await fs.writeFile(payloadPath, payload);

			await runPipedNotifyScript(scriptPath, payloadPath, {
				[PARADIS_PANE_TOKEN_ENV_VAR]: 'pane-token',
				[PARADIS_MCP_PORT_FILE_ENV_VAR]: portFilePath,
			});

			// The token travels in a header read from stdin, never in the URL or curl's argv.
			assert.deepStrictEqual(received, { method: 'POST', body: payload, authorization: 'Bearer pane-token', tokenInUrl: false });
		} finally {
			if (server.listening) {
				await new Promise<void>(resolve => server.close(() => resolve()));
			}
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('PowerShell hook drains stdin on inactive exits and uses the oversized fallback', () => {
		const script = paradisGetNotifyScriptContentPs1();
		assert.match(script, /function Drain-StandardInput/);
		assert.match(script, /Drain-StandardInput\r\n\s*exit 0/);
		assert.match(script, /function Read-BoundedStandardInput/);
		assert.match(script, /\$captureLimit = 4194305/);
		assert.match(script, /if \(\$bodyBytes\.Length -gt 4194304\)/);
		assert.match(script, /Invoke-RestMethod -Method Get -Uri \$hookUri -Headers \$hookHeaders/);
		assert.doesNotMatch(script, /pane=/);
	});

	test('reinstalling leaves its hooks where they are, so Codex trust keyed by position stays valid', () => {
		// Codex は hook の信頼を `<path>:<event>:<定義の位置>:<hookの位置>` で覚えている。
		// 自hookの後ろにユーザーの hook があっても、設置し直しで位置が動いてはいけない
		const userEarlier = { hooks: [{ type: 'command', command: '/tmp/user-earlier.sh' }] };
		const userLater = { hooks: [{ type: 'command', command: '/tmp/user-later.sh' }] };
		const hooks: Record<string, unknown[]> = {};
		for (const event of PARADIS_CODEX_HOOK_EVENTS) {
			hooks[event.eventName] = [paradisManagedHookDefinition(event)];
		}
		hooks.Stop = [userEarlier, paradisManagedHookDefinition({ eventName: 'Stop' }), userLater];
		hooks.SessionStart = [paradisManagedHookDefinition({ eventName: 'SessionStart' }), userLater];
		const existing = JSON.stringify({ hooks }, undefined, 2);

		assert.strictEqual(paradisMergeAgentHooksJson(existing, PARADIS_CODEX_HOOK_EVENTS), existing);
	});

	test('upgrades an older-schema hook in the same position and drops duplicates after it', () => {
		const schema1Command = '[ -x "$HOME/.para-code/hooks/notify-v1.sh" ] && "$HOME/.para-code/hooks/notify-v1.sh" || true';
		const userHook = { hooks: [{ type: 'command', command: '/tmp/user-hook.sh' }] };
		const existing = JSON.stringify({
			hooks: {
				Stop: [
					{ hooks: [{ type: 'command', command: schema1Command }] },
					userHook,
					{ hooks: [{ type: 'command', command: paradisManagedAgentHookCommand() }] },
				],
			},
		});
		const merged = paradisMergeAgentHooksJson(existing, [{ eventName: 'Stop' }]);
		assert.ok(merged !== undefined);
		assert.deepStrictEqual(JSON.parse(merged), {
			hooks: { Stop: [paradisManagedHookDefinition({ eventName: 'Stop' }), userHook] },
		});
	});

	test('removing takes out only Para Code hooks, keeps user hooks and other settings, and is a no-op when none are there', () => {
		const userHook = { type: 'command', command: '/tmp/user-hook.sh' };
		const existing = JSON.stringify({
			model: 'opus',
			hooks: {
				Stop: [paradisManagedHookDefinition({ eventName: 'Stop' }), { hooks: [userHook] }],
				SessionStart: [paradisManagedHookDefinition({ eventName: 'SessionStart' })],
				PreToolUse: [{ matcher: '*', hooks: [userHook, { type: 'command', command: paradisManagedAgentHookCommand() }] }],
			},
		}, undefined, 2);
		const removed = paradisRemoveAgentHooksJson(existing);
		assert.ok(removed !== undefined);
		const userOnly = JSON.stringify({ hooks: { Stop: [{ hooks: [userHook] }] } }, undefined, 2);
		assert.deepStrictEqual({
			removed: JSON.parse(removed),
			again: paradisRemoveAgentHooksJson(removed) === removed,
			userOnlyUntouched: paradisRemoveAgentHooksJson(userOnly) === userOnly,
			unparseable: paradisRemoveAgentHooksJson('{ broken'),
		}, {
			removed: {
				model: 'opus',
				hooks: {
					Stop: [{ hooks: [userHook] }],
					PreToolUse: [{ matcher: '*', hooks: [userHook] }],
				},
			},
			again: true,
			userOnlyUntouched: true,
			unparseable: undefined,
		});
	});

	test('removing from the hook files leaves a missing file missing', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-agent-hooks-remove-'));
		try {
			const claudeSettingsPath = join(root, '.claude', 'settings.json');
			const codexHooksPath = join(root, '.codex', 'hooks.json');
			await fs.mkdir(join(root, '.codex'), { recursive: true });
			await fs.writeFile(codexHooksPath, JSON.stringify({ hooks: { Stop: [paradisManagedHookDefinition({ eventName: 'Stop' })] } }, undefined, 2) + '\n');

			await paradisRemoveAgentHooks(undefined, { claudeSettingsPath, codexHooksPath });

			const claudeExists = await fs.stat(claudeSettingsPath).then(() => true, () => false);
			assert.deepStrictEqual({ claudeExists, codex: await fs.readFile(codexHooksPath, 'utf8') }, {
				claudeExists: false,
				codex: JSON.stringify({ hooks: {} }, undefined, 2) + '\n',
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('writes the settings file through a temp file, keeping a symlink and the original mode', async function () {
		if (process.platform === 'win32') {
			this.skip(); // symlink と mode の扱いが違う
		}
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-agent-hooks-atomic-'));
		try {
			const realDir = join(root, 'dotfiles');
			const linkDir = join(root, 'home');
			await fs.mkdir(realDir);
			await fs.mkdir(linkDir);
			const realFile = join(realDir, 'settings.json');
			const link = join(linkDir, 'settings.json');
			await fs.writeFile(realFile, '{"old":true}\n');
			await fs.chmod(realFile, 0o600);
			await fs.symlink(realFile, link);
			const newFile = join(linkDir, 'new.json');

			paradisWriteFileAtomicallySync(link, '{"new":true}\n');
			paradisWriteFileAtomicallySync(newFile, '{"created":true}\n');

			assert.deepStrictEqual({
				linkIsSymlink: (await fs.lstat(link)).isSymbolicLink(),
				content: await fs.readFile(link, 'utf8'),
				mode: (await fs.stat(realFile)).mode & 0o777,
				created: await fs.readFile(newFile, 'utf8'),
				leftovers: [...await fs.readdir(realDir), ...await fs.readdir(linkDir)].filter(name => name.endsWith('.tmp')),
			}, {
				linkIsSymlink: true,
				content: '{"new":true}\n',
				mode: 0o600,
				created: '{"created":true}\n',
				leftovers: [],
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('leaves a read-only settings file alone instead of replacing it', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-agent-hooks-readonly-'));
		try {
			const file = join(root, 'settings.json');
			await fs.writeFile(file, '{"locked":true}\n');
			await fs.chmod(file, 0o444);

			let code: string | undefined;
			try {
				paradisWriteFileAtomicallySync(file, '{"new":true}\n');
			} catch (error) {
				code = (error as NodeJS.ErrnoException).code;
			}

			assert.deepStrictEqual({
				code,
				content: await fs.readFile(file, 'utf8'),
				mode: (await fs.stat(file)).mode & 0o777,
				leftovers: (await fs.readdir(root)).filter(name => name.endsWith('.tmp')),
			}, {
				code: 'EACCES',
				content: '{"locked":true}\n',
				mode: 0o444,
				leftovers: [],
			});
		} finally {
			await fs.chmod(join(root, 'settings.json'), 0o644).catch(() => undefined);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('writes in place for hard links, for a directory it cannot add files to, and follows a dangling symlink chain', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-agent-hooks-inplace-'));
		const lockedDir = join(root, 'locked');
		try {
			// ハードリンク: 差し替えると片方だけ新しくなる
			const original = join(root, 'settings.json');
			const hardLink = join(root, 'settings-link.json');
			await fs.writeFile(original, 'old');
			await fs.link(original, hardLink);
			const inodeBefore = (await fs.stat(original)).ino;
			paradisWriteFileAtomicallySync(original, 'hard');

			// 一時ファイルを作れないディレクトリ（ファイル自体には書ける）
			await fs.mkdir(lockedDir);
			const lockedFile = join(lockedDir, 'hooks.json');
			await fs.writeFile(lockedFile, 'old');
			await fs.chmod(lockedDir, 0o555);
			paradisWriteFileAtomicallySync(lockedFile, 'locked');
			await fs.chmod(lockedDir, 0o755);

			// 多段の symlink で、最後のリンク先がまだ無い
			const first = join(root, 'first.json');
			const second = join(root, 'second.json');
			const finalTarget = join(root, 'final.json');
			await fs.symlink(second, first);
			await fs.symlink(finalTarget, second);
			paradisWriteFileAtomicallySync(first, 'chain');

			assert.deepStrictEqual({
				hardLinkContent: await fs.readFile(hardLink, 'utf8'),
				sameInode: (await fs.stat(original)).ino === inodeBefore,
				lockedContent: await fs.readFile(lockedFile, 'utf8'),
				firstIsSymlink: (await fs.lstat(first)).isSymbolicLink(),
				secondIsSymlink: (await fs.lstat(second)).isSymbolicLink(),
				finalContent: await fs.readFile(finalTarget, 'utf8'),
				leftovers: [...await fs.readdir(root), ...await fs.readdir(lockedDir)].filter(name => name.endsWith('.tmp')),
			}, {
				hardLinkContent: 'hard',
				sameInode: true,
				lockedContent: 'locked',
				firstIsSymlink: true,
				secondIsSymlink: true,
				finalContent: 'chain',
				leftovers: [],
			});
		} finally {
			await fs.chmod(lockedDir, 0o755).catch(() => undefined);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('does not let an older process replace newer managed hooks', () => {
		const newerCommand = paradisManagedAgentHookCommand().replace(
			`notify-v${PARADIS_AGENT_HOOK_SCHEMA_VERSION}.sh`,
			`notify-v${PARADIS_AGENT_HOOK_SCHEMA_VERSION + 1}.sh`,
		);
		const existing = JSON.stringify({ hooks: { FutureEvent: [{ hooks: [{ type: 'command', command: newerCommand }] }] } }, undefined, 2);
		assert.strictEqual(paradisMergeAgentHooksJson(existing, PARADIS_CLAUDE_ACTIVITY_HOOK_EVENTS), existing);
	});

	test('migrates legacy managed hooks and preserves user hooks idempotently', () => {
		const userHook = { type: 'command', command: '/tmp/user-hook.sh' };
		const legacyHook = { type: 'command', command: '[ -x "$HOME/.para-code/hooks/notify.sh" ] && "$HOME/.para-code/hooks/notify.sh" || true' };
		const existing = JSON.stringify({ hooks: { Stop: [{ hooks: [userHook, legacyHook] }] } });
		const first = paradisMergeAgentHooksJson(existing, PARADIS_CLAUDE_ACTIVITY_HOOK_EVENTS);
		assert.ok(first !== undefined);
		const second = paradisMergeAgentHooksJson(first, PARADIS_CLAUDE_ACTIVITY_HOOK_EVENTS);
		assert.strictEqual(second, first);
		const parsed = JSON.parse(first) as { hooks: Record<string, readonly { hooks: readonly { command: string }[] }[]> };
		assert.deepStrictEqual(parsed.hooks.Stop, [{ hooks: [userHook] }]);
		assert.ok(parsed.hooks.SubagentStart[0].hooks[0].command.includes(`notify-v${PARADIS_AGENT_HOOK_SCHEMA_VERSION}.sh`));
	});

	test('retries from the latest settings when another writer changes them before write', async () => {
		const initial = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/tmp/first-user-hook.sh' }] }] } });
		const concurrentlyUpdated = JSON.stringify({
			hooks: {
				Stop: [{
					hooks: [
						{ type: 'command', command: '/tmp/first-user-hook.sh' },
						{ type: 'command', command: '/tmp/concurrent-user-hook.sh' },
					]
				}]
			}, concurrentSetting: true
		});
		const reads = [initial, concurrentlyUpdated];
		let written: string | undefined;
		let compareAttempts = 0;

		await paradisMergeAgentHooksFile('/tmp/settings.json', PARADIS_CLAUDE_ACTIVITY_HOOK_EVENTS, undefined, undefined, {
			readFile: async () => reads.shift(),
			writeFileIfUnchanged: (_path, expected, content) => {
				compareAttempts++;
				if (expected === initial) {
					return false; // 最初のread後に外部更新が入ったことを再現
				}
				written = content;
				return true;
			},
			mkdir: async () => undefined,
		});

		assert.ok(written !== undefined);
		assert.strictEqual(compareAttempts, 2);
		const parsed = JSON.parse(written) as { concurrentSetting: boolean; hooks: Record<string, readonly { hooks: readonly { command: string }[] }[]> };
		assert.strictEqual(parsed.concurrentSetting, true);
		assert.deepStrictEqual(parsed.hooks.Stop[0].hooks.map(hook => hook.command), [
			'/tmp/first-user-hook.sh',
			'/tmp/concurrent-user-hook.sh',
		]);
	});

	test('reconciles externally replaced settings without removing user hooks', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-agent-hooks-'));
		try {
			const claudeSettingsPath = join(root, '.claude', 'settings.json');
			const codexHooksPath = join(root, '.codex', 'hooks.json');
			const userHook = { type: 'command', command: '/tmp/my-custom-hook.sh' };
			await fs.mkdir(join(root, '.claude'), { recursive: true });
			await fs.writeFile(claudeSettingsPath, JSON.stringify({ hooks: { Stop: [{ matcher: 'custom', hooks: [userHook] }] }, customSetting: true }));

			const reconciler = new ParadisAgentHooksReconciler(undefined, {
				claudeSettingsPath,
				codexHooksPath,
				claudeVersionOutput: '2.1.207',
				installNotifyScript: false,
			});
			await reconciler.reconcile();
			reconciler.dispose();

			const parsed = JSON.parse(await fs.readFile(claudeSettingsPath, 'utf8')) as { customSetting: boolean; hooks: Record<string, readonly { matcher?: string; hooks: readonly { command: string }[] }[]> };
			assert.strictEqual(parsed.customSetting, true);
			assert.deepStrictEqual(parsed.hooks.Stop[0], { matcher: 'custom', hooks: [userHook] });
			assert.ok(parsed.hooks.SubagentStart.some(definition => definition.hooks.some(hook => hook.command.includes(`notify-v${PARADIS_AGENT_HOOK_SCHEMA_VERSION}.sh`))));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('debounces watched changes, audits missed changes, and stops after dispose', async () => {
		let watchListener: ((fileName: string | null) => void) | undefined;
		let auditListener: (() => void) | undefined;
		let watchDisposed = false;
		let auditDisposed = false;
		let reconcileCount = 0;
		const scheduled: (() => void)[] = [];
		const disposable = (dispose: () => void): IDisposable => ({ dispose });
		const reconciler = new ParadisAgentHooksReconciler(undefined, {
			claudeVersionOutput: '2.1.207',
			installNotifyScript: false,
			watchDirectory: (_path, listener) => {
				watchListener = listener;
				return disposable(() => watchDisposed = true);
			},
			scheduleAudit: listener => {
				auditListener = listener;
				return disposable(() => auditDisposed = true);
			},
			scheduleReconcile: listener => {
				scheduled.push(listener);
				return disposable(() => undefined);
			},
			reconcileFiles: async () => { reconcileCount++; },
		});

		await reconciler.start();
		assert.strictEqual(reconcileCount, 1);
		watchListener?.('settings.json');
		watchListener?.('settings.json');
		assert.strictEqual(scheduled.length, 1);
		scheduled.shift()?.();
		await reconciler.whenIdle();
		assert.strictEqual(reconcileCount, 2);
		auditListener?.();
		await reconciler.whenIdle();
		assert.strictEqual(reconcileCount, 3);

		reconciler.dispose();
		assert.strictEqual(watchDisposed, true);
		assert.strictEqual(auditDisposed, true);
		watchListener?.('settings.json');
		auditListener?.();
		assert.strictEqual(scheduled.length, 0);
		assert.strictEqual(reconcileCount, 3);
	});

	test('keeps base hook reconciliation available when Claude version detection fails', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-agent-hooks-version-'));
		try {
			const claudeSettingsPath = join(root, '.claude', 'settings.json');
			const reconciler = new ParadisAgentHooksReconciler(undefined, {
				claudeSettingsPath,
				codexHooksPath: join(root, '.codex', 'hooks.json'),
				installNotifyScript: false,
			}, async () => { throw new Error('shell environment unavailable'); });

			await reconciler.reconcile();
			reconciler.dispose();

			const parsed = JSON.parse(await fs.readFile(claudeSettingsPath, 'utf8')) as { hooks: Record<string, unknown> };
			assert.ok(parsed.hooks.Stop);
			assert.strictEqual(parsed.hooks.SubagentStart, undefined);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
