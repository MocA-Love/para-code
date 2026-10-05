/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisProcessRow, IParadisServerDirEntry, IParadisServerLayout } from '../../common/paradisStaleServers.js';
import { IParadisStaleServersHost, ParadisStaleServersService, paradisStaleServersSurface } from '../../node/paradisStaleServersService.js';

const BIN = '/home/example/.para-code-server/bin';
const CURRENT = 'c'.repeat(40);
const OLD = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);
const ME = 1000;
const OTHER = 1001;
const layout: IParadisServerLayout = { binRoot: BIN, currentCommit: CURRENT, uid: ME, selfPid: 100 };

interface IFakeProcess {
	readonly pid: number;
	readonly ppid: number;
	readonly uid: number;
	readonly startedAt: number;
	readonly args: string;
}

function row(pid: number, ppid: number, args: string, uid = ME): IFakeProcess {
	return { pid, ppid, uid, startedAt: 0, args };
}

const DATES: Record<string, string> = {
	[CURRENT]: '2026-10-01T00:00:00.000Z',
	[OLD]: '2026-09-01T00:00:00.000Z',
	[NEWER]: '2026-10-03T00:00:00.000Z',
	['d'.repeat(40)]: '2026-08-01T00:00:00.000Z',
	// 動いていないが今より新しい版（先に更新した別の PC がこれから使う）。消さない
	['e'.repeat(40)]: '2026-10-04T00:00:00.000Z',
};

const LEFTOVER = `.paradis-removing-${'f'.repeat(40)}-123`;

/** シグナルを受けたら消える（`stubborn` に入れたものは TERM を無視する）偽の機械。実物には一切触らない。 */
class FakeHost implements IParadisStaleServersHost {
	readonly signals: string[] = [];
	readonly renamed: string[] = [];
	readonly removed: string[] = [];
	private clock = 1_000_000_000;

	constructor(
		private processes: IFakeProcess[],
		private readonly entries: IParadisServerDirEntry[],
		private readonly stubborn: ReadonlySet<number>,
		/** 受け側の接続を持っている server-main。どの server-main も 40000 + pid で待ち受ける。 */
		private readonly established: Set<number> | 'unknown' = new Set(),
	) { }

	async listProcesses(): Promise<IParadisProcessRow[]> {
		return this.processes.map(process => ({ pid: process.pid, ppid: process.ppid, uid: process.uid, args: process.args, rssKb: 1024, elapsedSeconds: Math.floor((this.clock - process.startedAt) / 1000) }));
	}
	async tcpState() {
		if (this.established === 'unknown') {
			return undefined;
		}
		const servers = this.processes.filter(process => process.args.includes('/out/server-main.js'));
		return {
			listeningPorts: new Map(servers.map(process => [process.pid, new Set([40000 + process.pid])])),
			// 外へ出ていく接続はどのサーバーにもある（使用中かの判断に数えないこと）
			established: [
				...servers.map(process => ({ pid: process.pid, localPort: 50000 + process.pid })),
				...[...this.established].map(pid => ({ pid, localPort: 40000 + pid })),
			],
		};
	}
	async listExecutables() { return undefined; }
	async realpath(path: string) { return path; }
	async listBinEntries() { return this.entries; }
	async sizeOf() { return 100 * 1024 * 1024; }
	async readProduct(_binRoot: string, commit: string) { return { version: '1.0.0', date: DATES[commit] }; }
	signal(pid: number, signal: 'SIGTERM' | 'SIGKILL') {
		this.signals.push(`${signal}:${pid}`);
		if (signal === 'SIGKILL' || !this.stubborn.has(pid)) {
			this.processes = this.processes.filter(process => process.pid !== pid);
		}
	}
	async renameDir(from: string, to: string) { this.renamed.push(`${from} -> ${to}`); }
	async removeDir(path: string) { this.removed.push(path); }
	async delay(ms: number) { this.clock += ms; }
	now() { return this.clock; }
}

suite('ParadisStaleServersService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function machine(): IFakeProcess[] {
		return [
			row(100, 1, `${BIN}/${CURRENT}/node ${BIN}/${CURRENT}/out/server-main.js --start-server`),
			row(101, 100, `${BIN}/${CURRENT}/node ${BIN}/${CURRENT}/out/bootstrap-fork --type=ptyHost`),
			row(102, 101, '/bin/zsh'),
			row(200, 1, `${BIN}/${OLD}/node ${BIN}/${OLD}/out/server-main.js --start-server`),
			row(201, 200, `${BIN}/${OLD}/node ${BIN}/${OLD}/out/bootstrap-fork --type=ptyHost`),
			row(202, 201, '/bin/bash'),
			// ほかのユーザーの古い版
			row(300, 1, `${BIN}/${OLD}/node ${BIN}/${OLD}/out/server-main.js --start-server`, OTHER),
			// 別の PC が先に更新した、今より新しい版
			row(400, 1, `${BIN}/${NEWER}/node ${BIN}/${NEWER}/out/server-main.js --start-server`),
		];
	}

	const entries: IParadisServerDirEntry[] = [
		{ name: CURRENT, isDirectory: true, mtimeMs: 0 },
		{ name: OLD, isDirectory: true, mtimeMs: 0 },
		{ name: NEWER, isDirectory: true, mtimeMs: 0 },
		{ name: 'd'.repeat(40), isDirectory: true, mtimeMs: 0 },
		{ name: 'e'.repeat(40), isDirectory: true, mtimeMs: 0 },
		// 版の product.json が読めない（DATES に無い）ものは消さない
		{ name: '9'.repeat(40), isDirectory: true, mtimeMs: 0 },
		// 前の掃除で取り残された退避フォルダは消す。同じ名前のファイルは触らない
		{ name: LEFTOVER, isDirectory: true, mtimeMs: 0 },
		{ name: `.paradis-removing-${'f'.repeat(40)}-456`, isDirectory: false, mtimeMs: 0 },
	];

	test('TERM first, KILL only the ones still there; never the current build, a newer build or another user', async () => {
		const host = new FakeHost(machine(), entries, new Set([202]));
		const service = new ParadisStaleServersService(layout, new NullLogService(), host);
		const scan = await service.scan();
		const result = await service.stopAndClean(scan.servers.map(server => server.commit));
		assert.deepStrictEqual({
			shown: scan.servers.map(server => server.commit),
			signals: [...host.signals].sort(),
			result,
			// OLD はほかのユーザーのサーバー（300）がまだ使っているので消さない。消すときは退避してから
			renamed: host.renamed.map(line => line.replace(/-\d+$/, '-<time>')),
			removed: host.removed.map(line => line.replace(/-\d+$/, '-<time>')),
		}, {
			shown: [OLD],
			signals: ['SIGKILL:202', 'SIGTERM:200', 'SIGTERM:201', 'SIGTERM:202'],
			result: { stoppedServers: 1, forcedProcesses: 1, removedDirs: 1, freedBytes: 100 * 1024 * 1024, failedDirs: 0 },
			renamed: [`${BIN}/${'d'.repeat(40)} -> ${BIN}/.paradis-removing-${'d'.repeat(40)}-<time>`],
			removed: [`${BIN}/${LEFTOVER}`.replace(/-\d+$/, '-<time>'), `${BIN}/.paradis-removing-${'d'.repeat(40)}-<time>`],
		});
	});

	test('stops nothing that the notice did not show, or that someone is connected to', async () => {
		const notShown = new FakeHost(machine(), entries, new Set());
		const notShownResult = await new ParadisStaleServersService(layout, new NullLogService(), notShown).stopAndClean([NEWER]);
		const connected = new FakeHost(machine(), entries, new Set(), new Set([200]));
		const connectedResult = await new ParadisStaleServersService(layout, new NullLogService(), connected).stopAndClean([OLD]);
		const unknown = new FakeHost(machine(), entries, new Set(), 'unknown');
		const unknownScan = await new ParadisStaleServersService(layout, new NullLogService(), unknown).scan();
		assert.deepStrictEqual([notShown.signals, notShownResult.stoppedServers, connected.signals, connectedResult.stoppedServers, unknownScan.servers], [[], 0, [], 0, []]);
	});

	test('touches nothing when it cannot see its own server', async () => {
		const host = new FakeHost(machine().filter(process => process.pid !== 100), entries, new Set());
		const service = new ParadisStaleServersService(layout, new NullLogService(), host);
		const result = await service.stopAndClean([OLD]);
		assert.deepStrictEqual([result, host.signals, host.removed], [{ stoppedServers: 0, forcedProcesses: 0, removedDirs: 0, freedBytes: 0, failedDirs: 0 }, [], []]);
	});

	test('reports nothing and measures nothing when only the current build runs', async () => {
		const host = new FakeHost(machine().filter(process => process.pid < 200), entries, new Set());
		const service = new ParadisStaleServersService(layout, new NullLogService(), host);
		assert.deepStrictEqual(await service.scan(), { supported: true, servers: [], removableDirCount: 0, removableBytes: 0, removableAfterStopDirCount: 0, removableAfterStopBytes: 0 });
	});

	test('does nothing without a known build layout', async () => {
		const host = new FakeHost(machine(), entries, new Set());
		const service = new ParadisStaleServersService(undefined, new NullLogService(), host);
		const scan = await service.scan();
		const result = await service.stopAndClean([OLD]);
		assert.deepStrictEqual([scan.supported, result, host.signals, host.removed], [false, { stoppedServers: 0, forcedProcesses: 0, removedDirs: 0, freedBytes: 0, failedDirs: 0 }, [], []]);
	});

	test('the channel surface exposes only scan and stopAndClean', () => {
		const service = new ParadisStaleServersService(layout, new NullLogService(), new FakeHost([], [], new Set()));
		assert.deepStrictEqual(Object.keys(paradisStaleServersSurface(service)).sort(), ['scan', 'stopAndClean']);
	});
});
