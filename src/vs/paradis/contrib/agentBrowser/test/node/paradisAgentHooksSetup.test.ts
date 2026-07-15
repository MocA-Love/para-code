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
import { PARADIS_AGENT_HOOK_SCHEMA_VERSION, PARADIS_CLAUDE_ACTIVITY_HOOK_EVENTS, paradisManagedAgentHookCommand } from '../../common/paradisAgentHooks.js';
import { ParadisAgentHooksReconciler, paradisGetNotifyScriptContent, paradisGetNotifyScriptContentPs1, paradisMergeAgentHooksFile, paradisMergeAgentHooksJson, paradisSupportsClaudeActivityHooks, paradisSupportsClaudeMessageDisplay } from '../../node/paradisAgentHooksSetup.js';

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

	test('migrates schema 1 managed hooks to schema 2 without removing user hooks', () => {
		const schema1Command = '[ -x "$HOME/.para-code/hooks/notify-v1.sh" ] && "$HOME/.para-code/hooks/notify-v1.sh" || true';
		const userHook = { type: 'command', command: '/tmp/user-hook.sh' };
		const existing = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: schema1Command }, userHook] }] } });
		const merged = paradisMergeAgentHooksJson(existing, [{ eventName: 'Stop' }]);

		assert.strictEqual(PARADIS_AGENT_HOOK_SCHEMA_VERSION, 2);
		assert.ok(merged !== undefined);
		const parsed = JSON.parse(merged) as { hooks: Record<string, readonly { hooks: readonly { command: string }[] }[]> };
		assert.deepStrictEqual(parsed.hooks['Stop'].flatMap(definition => definition.hooks.map(hook => hook.command)), [
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
		let received: { method: string | undefined; body: string } | undefined;
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on('data', chunk => chunks.push(Buffer.from(chunk)));
			request.on('end', () => {
				received = { method: request.method, body: Buffer.concat(chunks).toString('utf8') };
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

			assert.deepStrictEqual(received, { method: 'POST', body: payload });
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
		assert.match(script, /Invoke-RestMethod -Method Get/);
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
		assert.deepStrictEqual(parsed.hooks['Stop'], [{ hooks: [userHook] }]);
		assert.ok(parsed.hooks['SubagentStart'][0].hooks[0].command.includes(`notify-v${PARADIS_AGENT_HOOK_SCHEMA_VERSION}.sh`));
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
		assert.deepStrictEqual(parsed.hooks['Stop'][0].hooks.map(hook => hook.command), [
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
			assert.deepStrictEqual(parsed.hooks['Stop'][0], { matcher: 'custom', hooks: [userHook] });
			assert.ok(parsed.hooks['SubagentStart'].some(definition => definition.hooks.some(hook => hook.command.includes(`notify-v${PARADIS_AGENT_HOOK_SCHEMA_VERSION}.sh`))));
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
			assert.ok(parsed.hooks['Stop']);
			assert.strictEqual(parsed.hooks['SubagentStart'], undefined);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
