/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_AGENT_HOOK_SCHEMA_VERSION, PARADIS_CLAUDE_ACTIVITY_HOOK_EVENTS, paradisManagedAgentHookCommand } from '../../common/paradisAgentHooks.js';
import { ParadisAgentHooksReconciler, paradisMergeAgentHooksJson, paradisSupportsClaudeActivityHooks, paradisSupportsClaudeMessageDisplay } from '../../node/paradisAgentHooksSetup.js';

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
