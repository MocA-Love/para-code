/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisImplicitTunnelSource } from '../../../../../platform/tunnel/common/paradisTunnelRestorePolicy.js';
import { RemoteTunnel, TunnelProtocol } from '../../../../../platform/tunnel/common/tunnel.js';
import { CandidatePort, Tunnel, TunnelProperties, TunnelSource } from '../../../../../workbench/services/remote/common/tunnelModel.js';
import { ParadisAgentApprovalOutcome } from '../../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { ParadisPortReforwardProbeResult } from '../../../portReforward/common/paradisPortReforward.js';
import { IParadisReforwardConfirm } from '../../common/paradisPortReforwardConfirm.js';
import { ParadisPortToolRequest, ParadisPortToolResult } from '../../common/paradisPortTools.js';
import { paradisIsLoopbackLocalAddress } from '../../common/paradisPortSelection.js';
import { IParadisPortToolsWindow, PARADIS_REFORWARD_UNREACHABLE_MEMORY_MS, ParadisPortToolsChannel } from '../../electron-browser/paradisPortToolsChannel.js';

const PANE = 'pane-token';
const SSH = 'ssh-remote+devbox';

function tunnel(remotePort: number, localPort: number, options: { readonly source?: TunnelSource; readonly implicit?: boolean; readonly listening?: boolean; readonly name?: string; readonly closeable?: boolean; readonly remoteHost?: string } = {}): Tunnel {
	return {
		remoteHost: options.remoteHost ?? 'localhost',
		remotePort,
		localAddress: `localhost:${localPort}`,
		localUri: URI.parse(`http://localhost:${localPort}`),
		protocol: TunnelProtocol.Http,
		localPort,
		name: options.name,
		closeable: options.closeable ?? true,
		privacy: 'private',
		runningProcess: options.listening ? 'node server.js' : undefined,
		hasRunningProcess: options.listening === true,
		pid: options.listening ? 42 : undefined,
		source: options.implicit ? paradisImplicitTunnelSource(TunnelSource.Extension) : { source: options.source ?? TunnelSource.User, description: 'User Forwarded' },
	};
}

/** 台帳と、呼ばれた操作を記録する窓の代わり。 */
class FakeWindow implements IParadisPortToolsWindow {
	readonly calls: string[] = [];
	readonly ledger = new Map<number, Tunnel>();
	host: unknown = undefined;
	detection: CandidatePort[] | undefined = [];
	usedLocalPorts = new Set<number>();
	/** 張り直しが失敗するポート。 */
	readonly failingReforwards = new Set<number>();
	/** 張り直しの一瞬に手元の番号を取られ、別の番号で開き直すポート（リモート → 開き直した手元の番号）。 */
	readonly takenOnReforward = new Map<number, number>();
	/** shared process の参照の数（この窓を含む）。無ければ 1（この窓だけ）。undefined なら分からない。 */
	readonly references = new Map<number, number | undefined>();
	/** 手元から確かめた結果（手元の番号ごと）。無ければ reachable。 */
	readonly probeResults = new Map<number, ParadisPortReforwardProbeResult | undefined>();
	readonly probes: number[] = [];

	constructor(readonly remoteAuthority: string | undefined, tunnels: readonly Tunnel[] = []) {
		for (const item of tunnels) {
			this.ledger.set(item.remotePort, item);
		}
	}

	localPortHost(): unknown {
		return this.host;
	}
	forwarded(): readonly Tunnel[] {
		return [...this.ledger.values()];
	}
	candidates(): readonly CandidatePort[] | undefined {
		return this.detection;
	}
	async forward(properties: TunnelProperties): Promise<RemoteTunnel | string | undefined> {
		const local = properties.local ?? properties.remote.port;
		this.calls.push(`forward ${properties.remote.host}:${properties.remote.port} -> ${local}`);
		this.ledger.set(properties.remote.port, tunnel(properties.remote.port, local));
		return { tunnelRemotePort: properties.remote.port, tunnelRemoteHost: properties.remote.host, tunnelLocalPort: local, localAddress: `127.0.0.1:${local}`, privacy: 'private', dispose: async () => { } };
	}
	async close(remote: { host: string; port: number }): Promise<void> {
		this.calls.push(`close ${remote.port}`);
		this.ledger.delete(remote.port);
	}
	async reforward(item: Tunnel, localPort?: number): Promise<string | undefined> {
		const local = localPort ?? item.localPort!;
		this.calls.push(`reforward ${item.remotePort} -> ${local}`);
		if (this.failingReforwards.has(item.remotePort)) {
			return 'the SSH connection refused it';
		}
		this.ledger.set(item.remotePort, tunnel(item.remotePort, this.takenOnReforward.get(item.remotePort) ?? local, { remoteHost: item.remoteHost }));
		return undefined;
	}
	async referenceCounts(tunnels: readonly Tunnel[]): Promise<readonly (number | undefined)[]> {
		return tunnels.map(item => this.references.has(item.remotePort) ? this.references.get(item.remotePort) : 1);
	}
	async probe(localPort: number, _remotePort: number): Promise<ParadisPortReforwardProbeResult | undefined> {
		this.probes.push(localPort);
		return this.probeResults.has(localPort) ? this.probeResults.get(localPort) : 'reachable';
	}
	async isLocalPortFree(port: number): Promise<boolean> {
		return !this.usedLocalPorts.has(port);
	}
	snapshot(): string[] {
		return this.forwarded().map(item => `${item.remotePort}->${item.localPort}`);
	}
}

function setup(window: FakeWindow, answer: ParadisAgentApprovalOutcome | 'timedOut', now?: () => number) {
	const dialogs: string[][] = [];
	const confirms: IParadisReforwardConfirm[] = [];
	const channel = new ParadisPortToolsChannel(window, token => token === PANE, async (_token, request) => {
		dialogs.push([request.messageTemplate('pane'), ...request.detail, `[${request.approveLabel}]`]);
		if (request.reforward) {
			confirms.push(request.reforward);
		}
		return answer;
	}, now);
	return { channel, dialogs, confirms };
}

function summary(result: ParadisPortToolResult): unknown {
	return result.ok ? result.data : `error: ${result.error}`;
}

const CHANGES: readonly ParadisPortToolRequest[] = [
	{ op: 'forward', items: [{ remotePort: 21040, localPort: 21040 }], batch: false },
	{ op: 'stop', remotePorts: [21004, 33355] },
	{ op: 'reforward', items: [{ remotePort: 21004, alignLocalPort: true }], batch: false },
	{ op: 'forward', items: [{ remotePort: 21040, localPort: 21040 }, { remotePort: 21041, localPort: 21041 }], batch: true },
	{ op: 'reforward', items: [{ remotePort: 21004, alignLocalPort: true }, { remotePort: 21021, alignLocalPort: true }], batch: true },
	{ op: 'cleanUp', mode: 'not_listening', dryRun: false },
	{ op: 'cleanUp', mode: 'mismatched', dryRun: false },
];

suite('ParadisPortToolsChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function sshWindow(): FakeWindow {
		return new FakeWindow(SSH, [
			tunnel(21002, 21002, { listening: true, name: 'vite' }),
			tunnel(21004, 65459),
			tunnel(33355, 33355),
			tunnel(21021, 65481, { source: TunnelSource.Auto, listening: true }),
		]);
	}

	test('changes nothing when the user declines or does not answer', async () => {
		for (const answer of ['denied', 'timedOut', 'cancelled', 'unanswered', 'busy', 'recentlyDenied'] as const) {
			const window = sshWindow();
			const before = window.snapshot();
			const { channel, dialogs } = setup(window, answer);
			const results: boolean[] = [];
			for (const request of CHANGES) {
				results.push((await channel.handle(PANE, request)).ok);
			}
			assert.deepStrictEqual({ answer, results, calls: window.calls, ledger: window.snapshot(), dialogs: dialogs.length }, { answer, results: CHANGES.map(() => false), calls: [], ledger: before, dialogs: CHANGES.length });
		}
	});

	test('refuses every tool in a window that is not connected over SSH, without a dialog', async () => {
		for (const authority of [undefined, 'wsl+Ubuntu', 'dev-container+abc']) {
			const window = new FakeWindow(authority, [tunnel(21004, 65459)]);
			const { channel, dialogs } = setup(window, 'approve');
			const results = [];
			for (const request of [{ op: 'list', includeDetected: true } as const, ...CHANGES]) {
				const result = await channel.handle(PANE, request);
				results.push(result.ok ? 'ok' : result.error.startsWith('This terminal pane belongs to a Para Code window that is not connected over SSH') ? 'not ssh' : result.error);
			}
			assert.deepStrictEqual({ results, calls: window.calls, dialogs }, { results: results.map(() => 'not ssh'), calls: [], dialogs: [] });
		}
	});

	test('lists the forwards with mismatch, source and listening, and the detected ports on request', async () => {
		const window = sshWindow();
		window.detection = [{ host: 'localhost', port: 21002, detail: 'vite', pid: 42 }, { host: '127.0.0.1', port: 5173, detail: 'node dev', pid: 7 }];
		const { channel, dialogs } = setup(window, 'approve');
		const result = summary(await channel.handle(PANE, { op: 'list', includeDetected: true })) as { forwards: Record<string, unknown>[] };
		assert.deepStrictEqual(result.forwards.map(row => [row.remote_port, row.local_port, row.local_matches_remote, row.source, row.listening, row.forwarded]), [
			[21002, 21002, true, 'user', true, true],
			[21004, 65459, false, 'user', false, true],
			[33355, 33355, true, 'user', false, true],
			[21021, 65481, false, 'auto', true, true],
			[5173, undefined, undefined, undefined, true, false],
		]);
		window.detection = undefined;
		const unknown = summary(await channel.handle(PANE, { op: 'list', includeDetected: false })) as { detection_known: boolean; forwards: { listening: unknown }[] };
		assert.deepStrictEqual({ known: unknown.detection_known, listening: unknown.forwards.map(row => row.listening), dialogs }, { known: false, listening: [null, null, null, null], dialogs: [] });
	});

	test('shows what changes and how many, then changes only what was shown', async () => {
		const window = sshWindow();
		const { channel, dialogs } = setup(window, 'approve');
		const dryRun = summary(await channel.handle(PANE, { op: 'cleanUp', mode: 'not_listening', dryRun: true })) as { count: number };
		assert.strictEqual(dryRun.count, 1);
		assert.strictEqual(dialogs.length, 0);
		const cleaned = summary(await channel.handle(PANE, { op: 'cleanUp', mode: 'not_listening', dryRun: false }));
		const forwarded = summary(await channel.handle(PANE, { op: 'forward', items: [{ remotePort: 21040, localPort: 21040, label: 'api' }], batch: false }));
		assert.deepStrictEqual({ cleaned, forwarded, calls: window.calls, dialogs }, {
			cleaned: { mode: 'not_listening', stopped: [33355] },
			forwarded: { forwarded: true, remote_port: 21040, local_address: '127.0.0.1:21040', local_port: 21040, local_port_taken: false },
			calls: ['close 33355', 'forward localhost:21040 -> 21040'],
			dialogs: [
				['pane のエージェントが、SSH 先で listen していないエフェメラル帯の転送を 1 件停止しようとしています', '33355 → localhost:33355', 'どれも 32768 以上のエフェメラル帯の番号で、利用者（プレビューやリンクを含む）が張り、今は SSH 先のプロセスが listen していない転送です。32768 より下の決まった番号は対象にしていません。', '[1 件を停止]'],
				['pane のエージェントが、SSH 先のポートの転送を 1 件追加しようとしています', 'SSH 先の localhost:21040 → この PC の 127.0.0.1:21040（api）', '手元の番号が使用中なら、別の番号で転送します。転送はポートパネルからいつでも停止できます。', '[1 件を転送]'],
			],
		});
	});

	test('cleans up only unused user and preview forwards in the ephemeral range; fixed ports are stopped only by name', async () => {
		const window = new FakeWindow(SSH, [
			tunnel(21004, 65459),
			tunnel(32767, 32767),
			tunnel(32768, 32768),
			tunnel(60605, 60605),
			tunnel(40000, 40000, { listening: true }),
			tunnel(45000, 45000, { source: TunnelSource.Auto }),
			tunnel(50000, 50000, { source: TunnelSource.Extension }),
			tunnel(55000, 55000, { implicit: true }),
			tunnel(56000, 56000, { implicit: true, listening: true }),
		]);
		const { channel } = setup(window, 'approve');
		const dryRun = summary(await channel.handle(PANE, { op: 'cleanUp', mode: 'not_listening', dryRun: true })) as { targets: { remote_port: number }[] };
		const cleaned = summary(await channel.handle(PANE, { op: 'cleanUp', mode: 'not_listening', dryRun: false }));
		const stopped = summary(await channel.handle(PANE, { op: 'stop', remotePorts: [21004] }));
		assert.deepStrictEqual({ targets: dryRun.targets.map(row => row.remote_port), cleaned, stopped, ledger: window.snapshot() }, {
			targets: [32768, 60605, 55000],
			cleaned: { mode: 'not_listening', stopped: [32768, 60605, 55000] },
			stopped: { results: [{ remote_port: 21004, ok: true, stopped: true }] },
			ledger: ['32767->32767', '40000->40000', '45000->45000', '50000->50000', '56000->56000'],
		});
	});

	test('aligns the local port only when it is free, and checks before asking', async () => {
		const window = sshWindow();
		window.usedLocalPorts.add(21021);
		const { channel, dialogs } = setup(window, 'approve');
		const inUse = await channel.handle(PANE, { op: 'reforward', items: [{ remotePort: 21021, alignLocalPort: true }], batch: false });
		const aligned = summary(await channel.handle(PANE, { op: 'reforward', items: [{ remotePort: 21004, alignLocalPort: true }], batch: false }));
		assert.deepStrictEqual({ inUse: inUse.ok, aligned, calls: window.calls, dialogs }, {
			inUse: false,
			aligned: { reforwarded: true, remote_port: 21004, local_address: 'localhost:21004', local_port: 21004, local_port_taken: false, reachable: true },
			calls: ['reforward 21004 -> 21004'],
			dialogs: [[
				'エージェントが転送 1 件のつなぎ直しを求めています',
				'エージェントは理由を書いていません',
				'SSH 先のポート 1 件の転送を一度閉じて開き直します。1 件はこの PC で開くアドレスが変わります。',
				'21004 → localhost:65459 を localhost:21004 に変える',
				'この窓: 開いている通信が一度切れます。アドレスが変わるポートは、元のアドレスのタブが繋がらなくなります。',
				'ほかの窓: ほかの窓では、このポートを使っていません。影響はありません。',
				'拒否すると何も変わりません。このターミナルからのポートの変更は 3 分間、自動で断ります。',
				'[1 件をつなぎ直す]',
			]],
		});
	});

	test('does not clean up unused forwards before the window has detected processes', async () => {
		const window = sshWindow();
		window.detection = undefined;
		const { channel, dialogs } = setup(window, 'approve');
		const result = await channel.handle(PANE, { op: 'cleanUp', mode: 'not_listening', dryRun: false });
		assert.deepStrictEqual({ ok: result.ok, calls: window.calls, dialogs: dialogs.length }, { ok: false, calls: [], dialogs: 0 });
	});

	test('does not open forwards when the window listens on all interfaces, and refuses unknown panes', async () => {
		const window = sshWindow();
		window.host = 'allInterfaces';
		const { channel, dialogs } = setup(window, 'approve');
		const results = [
			await channel.handle(PANE, { op: 'forward', items: [{ remotePort: 21040, localPort: 21040 }], batch: false }),
			await channel.handle(PANE, { op: 'reforward', items: [{ remotePort: 21004, alignLocalPort: false }], batch: false }),
			await channel.handle('someone-else', { op: 'list', includeDetected: false }),
		].map(result => result.ok);
		assert.deepStrictEqual({ results, calls: window.calls, dialogs: dialogs.length }, { results: [false, false, false], calls: [], dialogs: 0 });
	});

	test('asks once for several forwards, lists them in the dialog, and returns one result per port', async () => {
		const window = sshWindow();
		const { channel, dialogs } = setup(window, 'approve');
		const forwarded = summary(await channel.handle(PANE, { op: 'forward', items: [{ remotePort: 21040, localPort: 21040 }, { remotePort: 21002, localPort: 21002 }, { remotePort: 21041, localPort: 31041, label: 'api' }], batch: true }));
		const stopped = summary(await channel.handle(PANE, { op: 'stop', remotePorts: [21040, 21041, 40404] }));
		assert.deepStrictEqual({ forwarded, stopped, calls: window.calls, dialogs }, {
			forwarded: {
				results: [
					{ remote_port: 21040, ok: true, forwarded: true, local_address: '127.0.0.1:21040', local_port: 21040, local_port_taken: false },
					{ remote_port: 21002, ok: true, already_forwarded: true, forward: { forwarded: true, remote_host: 'localhost', remote_port: 21002, local_address: 'localhost:21002', local_port: 21002, local_matches_remote: true, source: 'user', listening: true, process: 'node server.js', pid: 42, label: 'vite', protocol: 'http' }, hint: 'Nothing was changed. Use reforward_port with align_local_port to change its local port.' },
					{ remote_port: 21041, ok: true, forwarded: true, local_address: '127.0.0.1:31041', local_port: 31041, local_port_taken: false },
				],
			},
			stopped: {
				results: [
					{ remote_port: 21040, ok: true, stopped: true },
					{ remote_port: 21041, ok: true, stopped: true },
					{ remote_port: 40404, ok: false, error: 'not_forwarded' },
				],
			},
			calls: ['forward localhost:21040 -> 21040', 'forward localhost:21041 -> 31041', 'close 21040', 'close 21041'],
			dialogs: [
				['pane のエージェントが、SSH 先のポートの転送を 2 件追加しようとしています', 'SSH 先の localhost:21040 → この PC の 127.0.0.1:21040', 'SSH 先の localhost:21041 → この PC の 127.0.0.1:31041（api）', '手元の番号が使用中なら、別の番号で転送します。転送はポートパネルからいつでも停止できます。', '[2 件を転送]'],
				['pane のエージェントが、ポートの転送を 2 件停止しようとしています', '21040 → localhost:21040', '21041 → localhost:31041', '停止すると、その手元のアドレスを開いているブラウザのタブは繋がらなくなります。', '[2 件を停止]'],
			],
		});
	});

	test('reforwards several forwards after one dialog and reports each, including the ones that failed', async () => {
		const window = new FakeWindow(SSH, Array.from({ length: 23 }, (_, index) => tunnel(21100 + index, 65400 + index)));
		window.usedLocalPorts.add(21101);
		window.failingReforwards.add(21102);
		const { channel, dialogs } = setup(window, 'approve');
		const items = [...Array.from({ length: 23 }, (_, index) => ({ remotePort: 21100 + index, alignLocalPort: true })), { remotePort: 9999, alignLocalPort: false }];
		const result = summary(await channel.handle(PANE, { op: 'reforward', items, batch: true })) as { results: { remote_port: number; ok: boolean; error?: string; local_port?: number }[] };
		assert.deepStrictEqual({
			results: result.results.slice(0, 4).map(row => [row.remote_port, row.ok, row.ok ? row.local_port : row.error?.slice(0, 30)]),
			count: result.results.length,
			last: [result.results[23].remote_port, result.results[23].ok],
			aligned: result.results.filter(row => row.ok).length,
			dialogs: dialogs.length,
			title: dialogs[0][0],
			more: dialogs[0][23],
			inUse: dialogs[0][24],
			approve: dialogs[0].at(-1),
			localPortInUse: (result as { local_port_in_use?: number[] }).local_port_in_use,
		}, {
			results: [
				[21100, true, 21100],
				[21101, false, 'Local port 21101 on the user\'s'],
				[21102, false, 'Para Code could not forward po'],
				[21103, true, 21103],
			],
			count: 24,
			last: [9999, false],
			aligned: 21,
			dialogs: 1,
			title: 'エージェントが転送 22 件のつなぎ直しを求めています',
			more: 'ほか 2 件: 21121, 21122',
			inUse: '手元の番号が使用中のため変えないもの: 21101（この PC でほかのアプリがその番号を使っています。今のアドレスのまま残します）',
			approve: '[22 件をつなぎ直す]',
			localPortInUse: [21101],
		});
	});

	test('runs changes one at a time, so a second request asks only after the first dialog is answered', async () => {
		const window = sshWindow();
		const events: string[] = [];
		let release: (() => void) | undefined;
		const channel = new ParadisPortToolsChannel(window, token => token === PANE, async (_token, request) => {
			events.push(`ask ${request.messageTemplate('pane')}`);
			if (!release) {
				await new Promise<void>(resolve => release = resolve);
			}
			events.push('answered');
			return 'approve';
		});
		const first = channel.handle(PANE, { op: 'reforward', items: [{ remotePort: 21004, alignLocalPort: true }], batch: false });
		const second = channel.handle(PANE, { op: 'forward', items: [{ remotePort: 21040, localPort: 21040 }], batch: false });
		const read = await channel.handle(PANE, { op: 'list', includeDetected: false });
		await new Promise(resolve => setTimeout(resolve, 0));
		const beforeRelease = [...events];
		release!();
		const results = [(await first).ok, (await second).ok, read.ok];
		assert.deepStrictEqual({ beforeRelease, events, results }, {
			beforeRelease: ['ask エージェントが転送 1 件のつなぎ直しを求めています'],
			events: ['ask エージェントが転送 1 件のつなぎ直しを求めています', 'answered', 'ask pane のエージェントが、SSH 先のポートの転送を 1 件追加しようとしています', 'answered'],
			results: [true, true, true],
		});
	});

	test('tells the agent why it was turned down without a dialog, and to ask once for all ports', async () => {
		const window = sshWindow();
		const { channel } = setup(window, 'recentlyDenied');
		const result = await channel.handle(PANE, { op: 'reforward', items: [{ remotePort: 21004, alignLocalPort: true }], batch: false });
		assert.deepStrictEqual(result.ok ? undefined : [result.error.includes('clicked "Deny"'), result.error.includes('"ports"'), result.error.includes('mode "mismatched"')], [true, true, true]);
	});

	test('lists a forwarded port once even when the server listens on all interfaces', async () => {
		const window = sshWindow();
		window.detection = [
			{ host: '0.0.0.0', port: 21002, detail: 'vite', pid: 42 },
			{ host: '::', port: 21002, detail: 'vite', pid: 42 },
			{ host: '0.0.0.0', port: 5432, detail: 'docker-proxy', pid: 9 },
			{ host: '0:0:0:0:0:0:0:0', port: 5432, detail: 'docker-proxy', pid: 9 },
		];
		const { channel } = setup(window, 'approve');
		const result = summary(await channel.handle(PANE, { op: 'list', includeDetected: true })) as { forwards: Record<string, unknown>[] };
		assert.deepStrictEqual(result.forwards.map(row => [row.remote_host, row.remote_port, row.forwarded]), [
			['localhost', 21002, true],
			['localhost', 21004, true],
			['localhost', 33355, true],
			['localhost', 21021, true],
			['0.0.0.0', 5432, false],
		]);
	});

	test('reforwards and stops forwards whose remote host is 0.0.0.0', async () => {
		const window = new FakeWindow(SSH, [tunnel(4545, 4545, { remoteHost: '0.0.0.0' }), tunnel(4546, 4546, { remoteHost: '::' })]);
		const { channel } = setup(window, 'approve');
		const reforwarded = summary(await channel.handle(PANE, { op: 'reforward', items: [{ remotePort: 4545, alignLocalPort: false }], batch: false }));
		const stopped = summary(await channel.handle(PANE, { op: 'stop', remotePorts: [4546] }));
		assert.deepStrictEqual({ reforwarded, stopped, calls: window.calls }, {
			reforwarded: { remote_port: 4545, reforwarded: true, local_address: 'localhost:4545', local_port: 4545, local_port_taken: false, reachable: true },
			stopped: { results: [{ remote_port: 4546, ok: true, stopped: true }] },
			calls: ['reforward 4545 -> 4545', 'close 4546'],
		});
	});

	test('says so when another app takes the local port while a forward keeps its number', async () => {
		const window = sshWindow();
		window.takenOnReforward.set(21002, 65500);
		const { channel } = setup(window, 'approve');
		const result = summary(await channel.handle(PANE, { op: 'reforward', items: [{ remotePort: 21002, alignLocalPort: false }], batch: false }));
		assert.deepStrictEqual(result, { remote_port: 21002, reforwarded: true, local_address: 'localhost:65500', local_port: 65500, local_port_taken: true, reachable: true });
	});

	test('tests each reopened forward from this computer, and does not ask again for 5 minutes when it did not connect', async () => {
		const window = sshWindow();
		window.probeResults.set(21002, 'reset');
		window.probeResults.set(33355, undefined);
		let now = 1_000_000;
		const { channel, dialogs } = setup(window, 'approve', () => now);
		const ports = (remotePorts: number[]) => ({ op: 'reforward', items: remotePorts.map(remotePort => ({ remotePort, alignLocalPort: false })), batch: true } as const);
		const first = summary(await channel.handle(PANE, ports([21002, 21004, 33355]))) as { results: Record<string, unknown>[] };
		now += 2 * 60_000;
		const again = summary(await channel.handle(PANE, ports([21002]))) as { results: { ok: boolean; error: string }[] };
		const mixed = summary(await channel.handle(PANE, ports([21002, 21004]))) as { results: { ok: boolean }[] };
		now += PARADIS_REFORWARD_UNREACHABLE_MEMORY_MS;
		const later = summary(await channel.handle(PANE, ports([21002]))) as { results: { ok: boolean }[] };
		channel.forgetUnreachable();
		const afterReconnect = summary(await channel.handle(PANE, ports([21002]))) as { results: { ok: boolean }[] };
		assert.deepStrictEqual({
			first: first.results.map(row => [row.remote_port, row.reachable, typeof row.hint === 'string' ? (row.hint as string).slice(0, 40) : undefined]),
			again: [again.results[0].ok, again.results[0].error.slice(0, 60), again.results[0].error.includes('Reload Window')],
			mixed: mixed.results.map(row => row.ok),
			later: later.results.map(row => row.ok),
			afterReconnect: afterReconnect.results.map(row => row.ok),
			dialogs: dialogs.length,
			probes: window.probes,
		}, {
			first: [
				[21002, false, 'The forward was opened again, but a test'],
				[21004, true, undefined],
				[33355, null, 'Para Code could not test the forward fro'],
			],
			again: [false, 'Port 21002 was forwarded again 2 minutes ago, and a test con', true],
			mixed: [false, true],
			later: [true],
			afterReconnect: [true],
			// 2 回目は確認を出さない。3 回目は 21004 だけを聞く
			dialogs: 4,
			probes: [21002, 65459, 33355, 65459, 21002, 21002],
		});
	});

	test('tells whether other windows use the forwards, and does not claim none when it cannot tell', async () => {
		const window = sshWindow();
		const { channel, confirms } = setup(window, 'denied');
		const ask = () => channel.handle(PANE, { op: 'reforward', items: [{ remotePort: 21002, alignLocalPort: false }, { remotePort: 21004, alignLocalPort: false }], batch: true, reason: 'The page on localhost:21002 does not load' });
		await ask();
		window.references.set(21004, 3);
		await ask();
		window.references.set(21004, undefined);
		await ask();
		assert.deepStrictEqual(confirms.map(confirm => [confirm.reason, confirm.otherWindows.tone, confirm.otherWindows.text]), [
			['エージェントが書いた理由: The page on localhost:21002 does not load', 'success', 'ほかの窓では、このポートを使っていません。影響はありません。'],
			['エージェントが書いた理由: The page on localhost:21002 does not load', 'warning', '同じ SSH 先のほかの窓（2 つ）でも、同じポートの通信が一度切れます。転送そのものは残ります。'],
			['エージェントが書いた理由: The page on localhost:21002 does not load', 'info', '同じ SSH 先のほかの窓で同じポートを使っていれば、そちらの通信も一度切れます。'],
		]);
	});

	test('recognizes loopback local addresses', () => {
		assert.deepStrictEqual(['127.0.0.1:21004', 'localhost:65459', '[::1]:3000', 'http://127.0.0.1:8080/', '0.0.0.0:21004', '192.168.1.5:21004', '[::]:80'].map(paradisIsLoopbackLocalAddress), [true, true, true, true, false, false, false]);
	});
});
