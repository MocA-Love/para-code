/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisCodexRpc } from '../../../../node/paradisCodexAppServerSession.js';
import { IParadisCodexHookTrustGrantResult, IParadisCodexHookTrustStatus, paradisSelectManagedCodexHooks } from '../../common/paradisCodexHookTrust.js';
import { IParadisCodexHookTrustBackend, IParadisCodexHookTrustIO, paradisGrantCodexHookTrust, paradisInspectCodexHookTrust, ParadisCodexHookTrustService } from '../../node/paradisCodexHookTrust.js';
import { paradisWriteFileAtomic } from '../../../../node/paradisWriteFileAtomic.js';

const MANAGED = '[ -x "$HOME/.para-code/hooks/notify-v3.sh" ] && "$HOME/.para-code/hooks/notify-v3.sh" || true';
const HOME = '/home/u/.codex';
const HOOKS = `${HOME}/hooks.json`;
const CONFIG = `${HOME}/config.toml`;

interface IFakeHook {
	readonly key: string;
	readonly eventName: string;
	readonly command: string;
	readonly currentHash: string;
	readonly sourcePath?: string;
	readonly source?: string;
}

/** Codex の app-server の代わり。hooks.state は config.toml の中身として持つ。 */
class FakeCodex {
	readonly calls: string[] = [];
	readonly files = new Map<string, Buffer>();
	/** config/batchWrite を書いたことにして、実際には信頼を付けない（確認の失敗を再現する）。 */
	brokenWrite = false;

	constructor(readonly hooks: IFakeHook[]) { }

	private trusted(): Record<string, string> {
		const raw = this.files.get(CONFIG)?.toString('utf8') ?? '';
		const state: Record<string, string> = {};
		for (const match of raw.matchAll(/^(?<key>[^=\n]+)=(?<hash>.+)$/gm)) {
			state[match.groups!.key] = match.groups!.hash;
		}
		return state;
	}

	rpc(): IParadisCodexRpc {
		return {
			request: async (method: string, params: unknown) => {
				this.calls.push(method);
				if (method === 'hooks/list') {
					const trusted = this.trusted();
					return {
						data: [{
							cwd: HOME, warnings: [], errors: [], hooks: this.hooks.map(hook => ({
								key: hook.key, eventName: hook.eventName, handlerType: 'command', command: hook.command,
								source: hook.source ?? 'user', sourcePath: hook.sourcePath ?? HOOKS, currentHash: hook.currentHash,
								trustStatus: trusted[hook.key] === undefined ? 'untrusted' : trusted[hook.key] === hook.currentHash ? 'trusted' : 'modified',
							})),
						}],
					};
				}
				if (method === 'config/batchWrite') {
					const edits = (params as { edits: { keyPath: string; value: Record<string, { trusted_hash: string }> }[] }).edits;
					const lines = (this.files.get(CONFIG)?.toString('utf8') ?? '').split('\n');
					for (const [key, entry] of Object.entries(edits[0].value)) {
						lines.push(`${key}=${this.brokenWrite ? 'sha256:broken' : entry.trusted_hash}`);
					}
					this.files.set(CONFIG, Buffer.from(lines.filter(line => line.length > 0).join('\n') + '\n'));
					return { status: 'ok' };
				}
				throw new Error(`unexpected ${method}`);
			},
			dispose: () => { this.calls.push('dispose'); },
		};
	}

	io(): IParadisCodexHookTrustIO {
		return {
			openRpc: async () => this.rpc(),
			realpath: async path => path === HOOKS || path === HOME ? path : undefined,
			readFile: async path => this.files.get(path),
			restoreFile: async (path, content) => {
				this.calls.push('restore');
				if (content === undefined) {
					this.files.delete(path);
				} else {
					this.files.set(path, content);
				}
			},
		};
	}
}

const target = { codexHome: HOME, managedCommand: MANAGED, isWindows: false };

suite('ParadisCodexHookTrust', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('Para Code が置いた hook だけを選ぶ（利用者の hook・別のファイル・別の層は外す）', () => {
		const hook = (key: string, extra: Record<string, unknown>) => ({ key, eventName: 'stop', handlerType: 'command', command: MANAGED, source: 'user', sourcePath: HOOKS, currentHash: 'h', trustStatus: 'untrusted', ...extra });
		const selected = paradisSelectManagedCodexHooks({
			data: [
				{ hooks: [hook('a', {}), hook('user', { command: 'echo mine' }), hook('project', { source: 'project' }), hook('other-file', { sourcePath: '/elsewhere/hooks.json' }), hook('mcp', { handlerType: 'mcpTool' })] },
				// 同じ鍵が cwd ごとに繰り返されても1回だけ
				{ hooks: [hook('a', {})] },
			],
		}, [HOOKS], MANAGED, false);
		assert.deepStrictEqual(selected.map(listing => listing.key), ['a']);
	});

	test('信頼が要る hook にだけ Codex の答えたハッシュで信頼を付け、付いたことを確かめる', async () => {
		const codex = new FakeCodex([
			{ key: `${HOOKS}:session_start:0:0`, eventName: 'sessionStart', command: 'echo mine', currentHash: 'sha256:user' },
			{ key: `${HOOKS}:session_start:1:0`, eventName: 'sessionStart', command: MANAGED, currentHash: 'sha256:a' },
			{ key: `${HOOKS}:stop:0:0`, eventName: 'stop', command: MANAGED, currentHash: 'sha256:b' },
		]);
		codex.files.set(CONFIG, Buffer.from(`${HOOKS}:stop:0:0=sha256:old\n`));

		const before = await paradisInspectCodexHookTrust(target, codex.io());
		const result = await paradisGrantCodexHookTrust(target, codex.io());
		const again = await paradisGrantCodexHookTrust(target, codex.io());

		assert.deepStrictEqual({
			before: { pending: before.pending.map(listing => `${listing.eventName}:${listing.trustStatus}`), managedCount: before.managedCount },
			result: { outcome: result.outcome, events: result.grantedEvents },
			again: again.outcome,
			config: codex.files.get(CONFIG)?.toString('utf8'),
		}, {
			before: { pending: ['sessionStart:untrusted', 'stop:modified'], managedCount: 2 },
			result: { outcome: 'granted', events: ['sessionStart', 'stop'] },
			again: 'already-trusted',
			// 利用者の hook（session_start:0:0）の信頼は付けない
			config: `${HOOKS}:stop:0:0=sha256:old\n${HOOKS}:session_start:1:0=sha256:a\n${HOOKS}:stop:0:0=sha256:b\n`,
		});
	});

	test('書いたあとの確認が合わなければ、書く前の config.toml へ戻す', async () => {
		const codex = new FakeCodex([{ key: `${HOOKS}:stop:0:0`, eventName: 'stop', command: MANAGED, currentHash: 'sha256:b' }]);
		codex.files.set(CONFIG, Buffer.from('model = "x"\n'));
		codex.brokenWrite = true;

		const result = await paradisGrantCodexHookTrust(target, codex.io());

		assert.deepStrictEqual({ outcome: result.outcome, config: codex.files.get(CONFIG)?.toString('utf8'), calls: codex.calls }, {
			outcome: 'verify-failed',
			config: 'model = "x"\n',
			calls: ['hooks/list', 'config/batchWrite', 'hooks/list', 'restore', 'dispose'],
		});
	});

	test('hooks.json が無ければ codex を起こさない', async () => {
		const codex = new FakeCodex([]);
		const io: IParadisCodexHookTrustIO = { ...codex.io(), realpath: async () => undefined };
		const result = await paradisGrantCodexHookTrust(target, io);
		assert.deepStrictEqual({ outcome: result.outcome, calls: codex.calls }, { outcome: 'nothing-installed', calls: [] });
	});

	test('原子的な書き込みは symlink の実体側を置き換え、リンクは残す', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-hook-trust-'));
		try {
			const real = join(dir, 'real.toml');
			const link = join(dir, 'config.toml');
			await fs.writeFile(real, 'a');
			await fs.chmod(real, 0o640);
			await fs.symlink(real, link);
			await paradisWriteFileAtomic(link, Buffer.from('b'));
			assert.deepStrictEqual({
				isLink: (await fs.lstat(link)).isSymbolicLink(),
				content: await fs.readFile(real, 'utf8'),
				mode: (await fs.stat(real)).mode & 0o777,
				leftovers: (await fs.readdir(dir)).sort(),
			}, { isLink: true, content: 'b', mode: 0o640, leftovers: ['config.toml', 'real.toml'] });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	suite('service', () => {

		function setup(initialMode: string) {
			let mode = initialMode;
			const modeChanged = store.add(new Emitter<void>());
			const hooksChanged: (() => void)[] = [];
			const scheduled: (() => void)[] = [];
			const events: string[] = [];
			let fingerprint = 'fp1';
			let ledger: Record<string, string> = {};
			const backend: IParadisCodexHookTrustBackend = {
				inspect: async home => { events.push(`inspect:${home}`); return { codexHome: home, hooksPath: `${home}/hooks.json`, supported: true, pending: [], managedCount: 0 } satisfies IParadisCodexHookTrustStatus; },
				grant: async home => { events.push(`grant:${home}`); return { outcome: 'granted', codexHome: home, hooksPath: `${home}/hooks.json`, grantedEvents: ['stop'] } satisfies IParadisCodexHookTrustGrantResult; },
				fingerprint: async () => fingerprint,
				readLedger: async () => ({ ...ledger }),
				writeLedger: async value => { ledger = value; },
				watchHooks: (_home, listener) => { hooksChanged.push(listener); return Disposable.None; },
				schedule: (_delay, callback): IDisposable => { scheduled.push(callback); return toDisposable(() => { const index = scheduled.indexOf(callback); if (index >= 0) { scheduled.splice(index, 1); } }); },
			};
			const service = store.add(new ParadisCodexHookTrustService(backend, { defaultCodexHome: '/home/u/.codex', userHome: '/home/u' }, () => mode, modeChanged.event, new NullLogService()));
			return {
				service, events,
				ledger: () => ledger,
				setMode(value: string) { mode = value; modeChanged.fire(); },
				setFingerprint(value: string) { fingerprint = value; },
				fireHooksChanged() { hooksChanged.forEach(listener => listener()); },
				async flush() {
					while (scheduled.length > 0) {
						scheduled.shift()!();
					}
					await service.autoGrant().catch(() => undefined);
				},
			};
		}

		test('ask の間は自動で付けない。auto にすると付け、指紋が変わるまで codex を起こさない', async () => {
			const env = setup('ask');
			await env.flush();
			const whileAsk = [...env.events];
			env.setMode('auto');
			await env.flush();
			env.fireHooksChanged();
			await env.flush();
			const afterAuto = [...env.events];
			env.setFingerprint('fp2');
			env.fireHooksChanged();
			await env.flush();
			assert.deepStrictEqual({ whileAsk, afterAuto, final: env.events, ledger: env.ledger() }, {
				whileAsk: [],
				afterAuto: ['grant:/home/u/.codex'],
				final: ['grant:/home/u/.codex', 'grant:/home/u/.codex'],
				ledger: { '/home/u/.codex': 'fp2' },
			});
		});

		test('off なら同意の経路でも付けない。受け付ける CODEX_HOME は既定と ~/.codex-N だけ', async () => {
			const env = setup('off');
			const off = await env.service.grant();
			env.setMode('ask');
			const extra = await env.service.grant('/home/u/.codex-2');
			const rejected = await env.service.getStatus('/etc').then(() => 'accepted', () => 'rejected');
			const rejectedRelative = await env.service.grant('.codex-3').then(() => 'accepted', () => 'rejected');
			assert.deepStrictEqual({ off: off.outcome, extra: extra.outcome, rejected, rejectedRelative, events: env.events, claims: [env.service.claimPrompt(), env.service.claimPrompt()] }, {
				off: 'skipped',
				extra: 'granted',
				rejected: 'rejected',
				rejectedRelative: 'rejected',
				events: ['grant:/home/u/.codex-2'],
				claims: [true, false],
			});
		});
	});
});
