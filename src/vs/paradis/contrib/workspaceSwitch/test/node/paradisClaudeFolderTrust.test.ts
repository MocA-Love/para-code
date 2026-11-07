/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as cp from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisClaudeTrustTiming, paradisApplyClaudeFolderTrust, paradisGrantClaudeWorktreeTrust, paradisIsTooBroadToTrust, paradisReadClaudeTrustMarker, paradisResolveClaudeGlobalConfigFile, paradisRevokeClaudeFolderTrust, paradisRevokeClaudeWorktreeTrust, PARADIS_CLAUDE_TRUST_MARKER_FILE } from '../../node/paradisClaudeFolderTrust.js';
import { ParadisWorktreeGitService } from '../../node/paradisWorktreeGitChannel.js';

/** 待たずに取り直す（ロックが取れない場合を速く試す）。 */
const NO_WAIT: IParadisClaudeTrustTiming = { retryDelaysMs: [0, 0], sleep: async () => { } };

/**
 * 一時フォルダーに、Claude の設定置き場（CLAUDE_CONFIG_DIR）と git のワークツリーの形（`.git` の `gitdir:` と管理フォルダー）を
 * 作る。本物の HOME には触らない。
 */
async function withSandbox(run: (sandbox: { readonly root: string; readonly configDir: string; readonly configFile: string; readonly worktree: (name: string) => Promise<string> }) => Promise<void>): Promise<void> {
	const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paradis-claude-trust-')));
	const configDir = join(root, 'claude-config');
	await fs.mkdir(configDir, { recursive: true });
	const worktree = async (name: string) => {
		const path = join(root, 'repo-worktrees', name);
		const admin = join(root, 'repo', '.git', 'worktrees', name);
		await fs.mkdir(path, { recursive: true });
		await fs.mkdir(admin, { recursive: true });
		await fs.writeFile(join(path, '.git'), `gitdir: ${admin}\n`);
		return path;
	};
	try {
		await run({ root, configDir, configFile: join(configDir, '.claude.json'), worktree });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function readJson(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(path, 'utf8'));
}

suite('paradisClaudeFolderTrust', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('picks the config file Claude Code reads', () => {
		const exists = (legacy: boolean) => (path: string) => legacy && path.endsWith('.config.json');
		assert.deepStrictEqual([
			paradisResolveClaudeGlobalConfigFile({}, '/home/me', exists(false), 'posix'),
			paradisResolveClaudeGlobalConfigFile({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/me', exists(false), 'posix'),
			paradisResolveClaudeGlobalConfigFile({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/me', exists(true), 'posix'),
			paradisResolveClaudeGlobalConfigFile({}, '/home/me', exists(true), 'posix'),
			paradisResolveClaudeGlobalConfigFile({ CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://example.com' }, '/home/me', exists(false), 'posix'),
			paradisResolveClaudeGlobalConfigFile({ CLAUDE_CONFIG_DIR: '~/cfg' }, '/home/me', exists(false), 'posix'),
		], [
			'/home/me/.claude.json',
			'/cfg/.claude.json',
			'/cfg/.config.json',
			'/home/me/.claude/.config.json',
			'/home/me/.claude-custom-oauth.json',
			undefined,
		]);
	});

	test('writes trust to every key unless one is already trusted, and revokes only what it wrote', () => {
		const config = { numStartups: 3, projects: { '/w/a': { allowedTools: ['Bash'] } } };
		const granted = paradisApplyClaudeFolderTrust(config, ['/w/a', '/real/a']);
		const already = paradisApplyClaudeFolderTrust({ projects: { '/real/a': { hasTrustDialogAccepted: true } } }, ['/w/a', '/real/a']);
		const refused = paradisApplyClaudeFolderTrust({ projects: [] }, ['/w/a']);
		const revoked = granted.kind === 'changed' ? paradisRevokeClaudeFolderTrust(granted.config, ['/w/a', '/real/a', '/w/other']) : undefined;
		assert.deepStrictEqual({ granted, already: already.kind, refused: refused.kind, revoked }, {
			granted: { kind: 'changed', keys: ['/w/a', '/real/a'], config: { numStartups: 3, projects: { '/w/a': { allowedTools: ['Bash'], hasTrustDialogAccepted: true }, '/real/a': { hasTrustDialogAccepted: true } } } },
			already: 'unchanged',
			refused: 'refuse',
			revoked: { kind: 'changed', keys: ['/w/a', '/real/a'], config: { numStartups: 3, projects: { '/w/a': { allowedTools: ['Bash'] } } } },
		});
	});

	test('never pre-trusts the home folder, a folder that contains it, or the root', () => {
		assert.deepStrictEqual([
			paradisIsTooBroadToTrust(['/home/me'], '/home/me'),
			paradisIsTooBroadToTrust(['/home'], '/home/me'),
			paradisIsTooBroadToTrust(['/'], '/home/me'),
			paradisIsTooBroadToTrust(['/home/me/repo-worktrees/a'], '/home/me'),
		], [true, true, true, false]);
	});

	test('grants trust for a new worktree, keeps the other settings and the file mode, and revokes it on removal', () => withSandbox(async ({ root, configDir, configFile, worktree }) => {
		const path = await worktree('fix-a');
		await fs.writeFile(configFile, JSON.stringify({ userID: 'x', projects: { '/elsewhere': { hasTrustDialogAccepted: true } } }));
		await fs.chmod(configFile, 0o600);
		const outcome = await paradisGrantClaudeWorktreeTrust(path, { CLAUDE_CONFIG_DIR: configDir }, join(root, 'home'), NO_WAIT);
		const afterGrant = await readJson(configFile);
		const mode = (await fs.stat(configFile)).mode & 0o777;
		const marker = await paradisReadClaudeTrustMarker(path);
		// Claude Code が使っている間に増えた項目は、取り消しでも残す
		await fs.writeFile(configFile, JSON.stringify({ ...afterGrant, projects: { ...(afterGrant.projects as object), [path]: { hasTrustDialogAccepted: true, history: ['hi'] } } }));
		const revoked = marker !== undefined ? await paradisRevokeClaudeWorktreeTrust(marker, NO_WAIT) : undefined;
		assert.deepStrictEqual({
			outcome, mode: isWindows ? 0o600 : mode, afterGrant, marker, revoked,
			afterRevoke: await readJson(configFile),
			leftovers: (await fs.readdir(configDir)).sort(),
		}, {
			outcome: 'granted',
			mode: 0o600,
			afterGrant: { userID: 'x', projects: { '/elsewhere': { hasTrustDialogAccepted: true }, [path]: { hasTrustDialogAccepted: true } } },
			marker: { configFile, keys: [path] },
			revoked: 'granted',
			afterRevoke: { userID: 'x', projects: { '/elsewhere': { hasTrustDialogAccepted: true }, [path]: { history: ['hi'] } } },
			leftovers: ['.claude.json'],
		});
	}));

	test('writes nothing when the config is missing, already trusted, or locked by Claude Code', () => withSandbox(async ({ root, configDir, configFile, worktree }) => {
		const home = join(root, 'home');
		const missing = await paradisGrantClaudeWorktreeTrust(await worktree('missing'), { CLAUDE_CONFIG_DIR: configDir }, home, NO_WAIT);
		const missingCreated = await fs.stat(configFile).then(() => true, () => false);

		const trustedPath = await worktree('trusted');
		await fs.writeFile(configFile, JSON.stringify({ projects: { [trustedPath]: { hasTrustDialogAccepted: true } } }));
		const trusted = await paradisGrantClaudeWorktreeTrust(trustedPath, { CLAUDE_CONFIG_DIR: configDir }, home, NO_WAIT);
		const trustedMarker = await paradisReadClaudeTrustMarker(trustedPath);

		const lockedPath = await worktree('locked');
		const before = await fs.readFile(configFile, 'utf8');
		await fs.mkdir(`${configFile}.lock`);
		const locked = await paradisGrantClaudeWorktreeTrust(lockedPath, { CLAUDE_CONFIG_DIR: configDir }, home, NO_WAIT);
		const lockKept = await fs.stat(`${configFile}.lock`).then(() => true, () => false);
		assert.deepStrictEqual({
			missing, missingCreated, trusted, trustedMarker, locked, lockKept,
			unchanged: await fs.readFile(configFile, 'utf8') === before,
			leftovers: (await fs.readdir(configDir)).sort(),
		}, {
			missing: 'missing-config', missingCreated: false,
			trusted: 'unchanged', trustedMarker: undefined,
			locked: 'locked', lockKept: true, unchanged: true,
			leftovers: ['.claude.json', '.claude.json.lock'],
		});
	}));

	test('replaces the file a symlinked config points to and keeps the link', () => withSandbox(async ({ root, configDir, configFile, worktree }) => {
		if (isWindows) {
			return; // シンボリックリンクに権限が要る
		}
		const real = join(root, 'dotfiles', 'claude.json');
		await fs.mkdir(join(root, 'dotfiles'));
		await fs.writeFile(real, JSON.stringify({ projects: {} }));
		await fs.symlink(real, configFile);
		const path = await worktree('linked');
		const outcome = await paradisGrantClaudeWorktreeTrust(path, { CLAUDE_CONFIG_DIR: configDir }, join(root, 'home'), NO_WAIT);
		assert.deepStrictEqual({ outcome, isLink: (await fs.lstat(configFile)).isSymbolicLink(), real: await readJson(real) }, {
			outcome: 'granted', isLink: true, real: { projects: { [path]: { hasTrustDialogAccepted: true } } },
		});
	}));

	test('two worktrees created at the same time are both trusted', () => withSandbox(async ({ root, configDir, configFile, worktree }) => {
		await fs.writeFile(configFile, JSON.stringify({ projects: {} }));
		const [a, b] = await Promise.all([worktree('a'), worktree('b')]);
		const outcomes = await Promise.all([a, b].map(path => paradisGrantClaudeWorktreeTrust(path, { CLAUDE_CONFIG_DIR: configDir }, join(root, 'home'), NO_WAIT)));
		assert.deepStrictEqual({ outcomes, projects: Object.keys((await readJson(configFile)).projects as object).sort() }, { outcomes: ['granted', 'granted'], projects: [a, b].sort() });
	}));

	test('the git service trusts a worktree it created only when asked, and revokes it after git removes the worktree', () => withSandbox(async ({ root, configDir, configFile, worktree }) => {
		await fs.writeFile(configFile, JSON.stringify({ projects: {} }));
		const calls: string[] = [];
		const execFile = ((_command: string, args: readonly string[], _options: cp.ExecFileOptions, callback: (error: cp.ExecFileException | null, stdout: string, stderr: string) => void) => {
			calls.push(args.slice(2).join(' '));
			queueMicrotask(() => callback(null, '', ''));
			return {} as cp.ChildProcess;
		}) as typeof cp.execFile;
		const service = new ParadisWorktreeGitService(new NullLogService(), undefined, undefined, execFile, async () => ({ CLAUDE_CONFIG_DIR: configDir }));
		try {
			const asked = await worktree('asked');
			const notAsked = await worktree('not-asked');
			await service.addWorktree({ repoPath: join(root, 'repo'), worktreePath: asked, newBranch: 'asked', baseRef: 'main', trustClaudeFolder: true });
			await service.addWorktree({ repoPath: join(root, 'repo'), worktreePath: notAsked, newBranch: 'not-asked', baseRef: 'main' });
			const afterAdd = Object.keys((await readJson(configFile)).projects as object);
			const hasMarker = await fs.stat(join(root, 'repo', '.git', 'worktrees', 'asked', PARADIS_CLAUDE_TRUST_MARKER_FILE)).then(() => true, () => false);
			await service.removeWorktree({ repoPath: join(root, 'repo'), worktreePath: asked, force: false });
			assert.deepStrictEqual({ afterAdd, hasMarker, afterRemove: (await readJson(configFile)).projects, removed: calls.filter(call => call.startsWith('worktree remove')) }, {
				afterAdd: [asked], hasMarker: true, afterRemove: {}, removed: [`worktree remove ${asked}`],
			});
		} finally {
			service.dispose();
		}
	}));
});
