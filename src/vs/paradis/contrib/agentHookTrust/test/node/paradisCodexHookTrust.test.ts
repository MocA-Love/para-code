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
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisCodexAppServerRpc } from '../../../../node/paradisCodexAppServerRpc.js';
import { IParadisCodexHookTrustGrantResult, IParadisCodexHookTrustStatus, paradisSelectManagedCodexHooks } from '../../common/paradisCodexHookTrust.js';
import { IParadisCodexHookTrustBackend, IParadisCodexHookTrustIO, paradisGrantCodexHookTrust, paradisInspectCodexHookTrust, ParadisCodexHookTrustService } from '../../node/paradisCodexHookTrust.js';
import { paradisWriteFileAtomic } from '../../../../node/paradisWriteFileAtomic.js';

const MANAGED = '[ -x "$HOME/.para-code/hooks/notify-v3.sh" ] && "$HOME/.para-code/hooks/notify-v3.sh" || true';
const HOME = '/home/u/.codex';
const HOOKS = `${HOME}/hooks.json`;

interface IFakeHook {
	readonly key: string;
	readonly eventName: string;
	readonly command: string;
	readonly currentHash: string;
	readonly sourcePath?: string;
	readonly source?: string;
}

type HooksState = Record<string, { trusted_hash: string }>;

/**
 * Codex の app-server の代わり。config.toml の `hooks.state` と版を持ち、
 * `expectedVersion` が今の版と違う書き込みは Codex と同じく断る。
 */
class FakeCodex {
	readonly calls: string[] = [];
	state: HooksState = {};
	version = 1;
	/** 書き込みの直後に hooks.json が書き換わり、hook のハッシュが変わる（確認の失敗を再現する）。 */
	hooksChangeAfterWrite = false;
	/** 書き込みを反映したあと、応答を返さずに失敗させる（時間切れの再現）。 */
	failAfterWrite = false;
	/** こちらの書き込みの直後に、別の誰か（Codex の TUI など）が書く。 */
	afterWrite: (() => void) | undefined;

	constructor(public hooks: IFakeHook[]) { }

	private rpcCount = 0;

	rpc(): IParadisCodexAppServerRpc {
		const id = ++this.rpcCount;
		return {
			request: async (method: string, params: unknown) => {
				this.calls.push(`${id}:${method}`);
				if (method === 'hooks/list') {
					return {
						data: [{
							cwd: HOME, warnings: [], errors: [], hooks: this.hooks.map(hook => ({
								key: hook.key, eventName: hook.eventName, handlerType: 'command', command: hook.command,
								source: hook.source ?? 'user', sourcePath: hook.sourcePath ?? HOOKS, currentHash: hook.currentHash,
								trustStatus: this.state[hook.key] === undefined ? 'untrusted' : this.state[hook.key].trusted_hash === hook.currentHash ? 'trusted' : 'modified',
							})),
						}],
					};
				}
				if (method === 'config/read') {
					return { config: {}, origins: {}, layers: [{ name: { type: 'user', file: `${HOME}/config.toml` }, version: `v${this.version}`, config: { model: 'x', hooks: { state: { ...this.state } } } }] };
				}
				if (method === 'config/batchWrite') {
					const request = params as { edits: { keyPath: string; value: HooksState; mergeStrategy: string }[]; expectedVersion?: string };
					if (request.expectedVersion !== undefined && request.expectedVersion !== `v${this.version}`) {
						throw new Error('Configuration was modified since last read.');
					}
					const edit = request.edits[0];
					this.state = edit.mergeStrategy === 'replace' ? { ...edit.value } : { ...this.state, ...edit.value };
					this.version++;
					this.calls.push(`${id}:wrote:${edit.mergeStrategy}`);
					if (edit.mergeStrategy === 'upsert') {
						if (this.hooksChangeAfterWrite) {
							this.hooks = this.hooks.map(hook => ({ ...hook, currentHash: `${hook.currentHash}-changed` }));
						}
						this.afterWrite?.();
						if (this.failAfterWrite) {
							throw new Error('codex app-server config/batchWrite timed out');
						}
					}
					return { status: 'ok', version: `v${this.version}` };
				}
				throw new Error(`unexpected ${method}`);
			},
			dispose: () => { this.calls.push(`${id}:dispose`); },
		};
	}

	io(): IParadisCodexHookTrustIO {
		return {
			openRpc: async () => this.rpc(),
			realpath: async path => path === HOOKS || path === HOME ? path : undefined,
		};
	}
}

const target = { codexHome: HOME, managedCommand: MANAGED, isWindows: false };
const managedStop = { key: `${HOOKS}:stop:0:0`, eventName: 'stop', command: MANAGED, currentHash: 'sha256:b' };

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

	test('信頼が要る hook にだけ Codex の答えたハッシュで信頼を付け、読んだ版を添えて書く', async () => {
		const codex = new FakeCodex([
			{ key: `${HOOKS}:session_start:0:0`, eventName: 'sessionStart', command: 'echo mine', currentHash: 'sha256:user' },
			{ key: `${HOOKS}:session_start:1:0`, eventName: 'sessionStart', command: MANAGED, currentHash: 'sha256:a' },
			managedStop,
		]);
		codex.state = { [managedStop.key]: { trusted_hash: 'sha256:old' } };

		const before = await paradisInspectCodexHookTrust(target, codex.io());
		const result = await paradisGrantCodexHookTrust(target, codex.io());
		const again = await paradisGrantCodexHookTrust(target, codex.io());

		assert.deepStrictEqual({
			before: { pending: before.pending.map(listing => `${listing.eventName}:${listing.trustStatus}`), managedCount: before.managedCount },
			result: { outcome: result.outcome, events: result.grantedEvents },
			again: again.outcome,
			// 利用者の hook（session_start:0:0）の信頼は付けない
			state: codex.state,
		}, {
			before: { pending: ['sessionStart:untrusted', 'stop:modified'], managedCount: 2 },
			result: { outcome: 'granted', events: ['sessionStart', 'stop'] },
			again: 'already-trusted',
			state: { [managedStop.key]: { trusted_hash: 'sha256:b' }, [`${HOOKS}:session_start:1:0`]: { trusted_hash: 'sha256:a' } },
		});
	});

	test('確認が合わなければ、こちらが書いた鍵だけを元へ戻し、その間に他が書いた値は残す', async () => {
		const codex = new FakeCodex([managedStop, { key: `${HOOKS}:pre_tool_use:0:0`, eventName: 'preToolUse', command: MANAGED, currentHash: 'sha256:c' }]);
		codex.state = { [managedStop.key]: { trusted_hash: 'sha256:old' }, '/other:stop:0:0': { trusted_hash: 'sha256:user' } };
		codex.hooksChangeAfterWrite = true;
		codex.afterWrite = () => {
			codex.state = { ...codex.state, '/tui:stop:0:0': { trusted_hash: 'sha256:tui' } };
			codex.version++;
		};

		const result = await paradisGrantCodexHookTrust(target, codex.io());

		assert.deepStrictEqual({ outcome: result.outcome, state: codex.state }, {
			outcome: 'verify-failed',
			state: {
				[managedStop.key]: { trusted_hash: 'sha256:old' },
				'/other:stop:0:0': { trusted_hash: 'sha256:user' },
				'/tui:stop:0:0': { trusted_hash: 'sha256:tui' },
			},
		});
	});

	test('書き込みが途中で失敗したら、その app-server を止めてから新しい app-server で戻す', async () => {
		const codex = new FakeCodex([managedStop]);
		codex.failAfterWrite = true;

		const result = await paradisGrantCodexHookTrust(target, codex.io());

		assert.deepStrictEqual({ outcome: result.outcome, state: codex.state, calls: codex.calls }, {
			outcome: 'failed',
			state: {},
			calls: ['1:hooks/list', '1:config/read', '1:config/batchWrite', '1:wrote:upsert', '1:dispose', '2:config/read', '2:config/batchWrite', '2:wrote:replace', '2:dispose'],
		});
	});

	test('読んでから書くまでに config.toml が変わっていたら書かない', async () => {
		const codex = new FakeCodex([managedStop]);
		const io = codex.io();
		const inner = codex.rpc.bind(codex);
		codex.rpc = () => {
			const rpc = inner();
			return {
				request: async (method: string, params: unknown) => {
					const response = await rpc.request(method, params);
					if (method === 'config/read') {
						codex.version++; // 読んだ直後に誰かが書いた
					}
					return response;
				},
				dispose: () => rpc.dispose(),
			};
		};

		const result = await paradisGrantCodexHookTrust(target, io);

		assert.deepStrictEqual({ outcome: result.outcome, state: codex.state }, { outcome: 'failed', state: {} });
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

		function setup(initialMode: string, initialHomes: readonly string[] = ['/home/u/.codex']) {
			let mode = initialMode;
			let homes = initialHomes;
			const modeChanged = store.add(new Emitter<void>());
			const homesChanged = store.add(new Emitter<void>());
			const hooksChanged: (() => void)[] = [];
			const watched: string[] = [];
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
				watchHooks: (home, listener) => { hooksChanged.push(listener); watched.push(home); return toDisposable(() => watched.splice(watched.indexOf(home), 1)); },
				schedule: (_delay, callback): IDisposable => { scheduled.push(callback); return toDisposable(() => { const index = scheduled.indexOf(callback); if (index >= 0) { scheduled.splice(index, 1); } }); },
			};
			const clock = { now: 0 };
			const service = store.add(new ParadisCodexHookTrustService(backend, { listHomes: () => homes, onDidChangeHomes: homesChanged.event, now: () => clock.now }, () => mode, modeChanged.event, new NullLogService()));
			return {
				service, events, clock, watched,
				setHomes(value: readonly string[]) { homes = value; homesChanged.fire(); },
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

		test('off なら同意の経路でも付けない。受け付ける CODEX_HOME は hook を置くホームの一覧にあるものだけ', async () => {
			const env = setup('off', ['/home/u/.codex', '/home/u/.codex-2']);
			const off = await env.service.grant();
			env.setMode('ask');
			const extra = await env.service.grant('/home/u/.codex-2');
			const rejected = await env.service.getStatus('/etc').then(() => 'accepted', () => 'rejected');
			const rejectedRelative = await env.service.grant('.codex-3').then(() => 'accepted', () => 'rejected');
			// 手で作った ~/.codex-backup や、ログインしていない ~/.codex-3 は一覧に無いので受け付けない
			const rejectedBackup = await env.service.grant('/home/u/.codex-backup').then(() => 'accepted', () => 'rejected');
			const rejectedUnlisted = await env.service.grant('/home/u/.codex-3').then(() => 'accepted', () => 'rejected');
			assert.deepStrictEqual({ off: off.outcome, extra: extra.outcome, rejected, rejectedRelative, rejectedBackup, rejectedUnlisted, events: env.events }, {
				off: 'skipped',
				extra: 'granted',
				rejected: 'rejected',
				rejectedRelative: 'rejected',
				rejectedBackup: 'rejected',
				rejectedUnlisted: 'rejected',
				events: ['grant:/home/u/.codex-2'],
			});
		});

		test('auto では一覧の全ホームに付け、全ホームの hooks.json を見る。ホームが増えたら監視と確認を足す', async () => {
			const env = setup('auto', ['/home/u/.codex', '/home/u/.codex-2']);
			await env.flush();
			await env.service.autoGrant('/home/u/.codex-2');
			const first = { events: [...env.events], watched: [...env.watched] };
			env.setHomes(['/home/u/.codex', '/home/u/.codex-3']);
			await env.flush();
			await env.service.autoGrant('/home/u/.codex-3');
			assert.deepStrictEqual({ first, events: env.events, watched: env.watched, ledger: Object.keys(env.ledger()).sort() }, {
				first: { events: ['grant:/home/u/.codex', 'grant:/home/u/.codex-2'], watched: ['/home/u/.codex', '/home/u/.codex-2'] },
				events: ['grant:/home/u/.codex', 'grant:/home/u/.codex-2', 'grant:/home/u/.codex-3'],
				watched: ['/home/u/.codex', '/home/u/.codex-3'],
				ledger: ['/home/u/.codex', '/home/u/.codex-2', '/home/u/.codex-3'],
			});
		});

		test('確かめる札は1つの窓だけが持ち、通知を出さずに返したら次の窓が持てる。出したら以後は誰も持てない', () => {
			const env = setup('ask');
			const claims: boolean[] = [];
			claims.push(env.service.claimPrompt(), env.service.claimPrompt());
			env.service.releasePrompt(false);
			claims.push(env.service.claimPrompt());
			// 返さずに窓が消えても、2分で取り返せる
			env.clock.now += 2 * 60_000;
			claims.push(env.service.claimPrompt());
			env.service.releasePrompt(true);
			claims.push(env.service.claimPrompt());
			assert.deepStrictEqual(claims, [true, false, true, true, false]);
		});
	});
});
