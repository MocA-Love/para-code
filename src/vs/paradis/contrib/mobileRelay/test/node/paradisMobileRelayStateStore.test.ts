/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { Event } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/runWithFakedTimers.js';
import { IEncryptionService } from '../../../../../platform/encryption/common/encryptionService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisMobileStatus } from '../../common/paradisMobileRelay.js';
import { generatePersistableIdentity } from '../../common/paradisMobileCrypto.js';
import { toBase64Url } from '../../common/paradisMobileProtocol.js';
import { paradisParseRelayState, paradisRelayStateAsidePath, paradisWriteRelayState } from '../../node/paradisMobileRelayStateFile.js';
import { IParadisMobileRelayServiceTestSeams, ParadisMobileRelayService } from '../../node/paradisMobileRelayService.js';
import { PARADIS_RELAY_RETRY_CEILING_MS, PARADIS_RELAY_RETRY_MIN_MS, paradisRelayJitteredDelayMs, paradisRelayReconnectDelayMs } from '../../common/paradisRelayReconnectDelay.js';

/** 復号の可否を切り替えられる safeStorage の代わり（キーチェーンの一時的な拒否を再現する）。 */
class FakeEncryptionService {
	failDecrypt = false;
	async encrypt(value: string): Promise<string> {
		return `enc:${value}`;
	}
	async decrypt(value: string): Promise<string> {
		if (this.failDecrypt) {
			throw new Error('keychain denied');
		}
		return value.slice('enc:'.length);
	}
}

interface IServiceInternals {
	save(): Promise<void>;
	ensureIdentity(): Promise<unknown>;
	identity: unknown;
}

suite('ParadisMobileRelayService pairing state store', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let userData: string;
	let statePath: string;

	setup(async () => {
		userData = join(tmpdir(), `paradis-relay-state-${generateUuid()}`);
		await fs.mkdir(userData, { recursive: true });
		statePath = join(userData, 'paradis-mobile-relay.json');
	});

	teardown(async () => {
		await fs.rm(userData, { recursive: true, force: true });
	});

	function createService(encryption: FakeEncryptionService, writeRelayState?: IParadisMobileRelayServiceTestSeams['writeRelayState']): ParadisMobileRelayService {
		return new ParadisMobileRelayService(
			userData,
			encryption as unknown as IEncryptionService,
			undefined,
			undefined,
			{ onDidChangeManifest: Event.None } as never,
			new NullLogService(),
			undefined,
			undefined,
			undefined,
			{ disableHostResourceSampling: true, readMachineIdHash: async () => undefined, writeRelayState },
		);
	}

	async function writeStoredIdentity(): Promise<string> {
		const { identity, pkcs8 } = await generatePersistableIdentity();
		const content = JSON.stringify({
			identity: { pubKey: toBase64Url(identity.publicKey), encSecret: `enc:${toBase64Url(pkcs8)}` },
			device: { deviceId: 'device-1', pcToken: 'token-1' },
			mobiles: [{ mobileId: 'm1', name: 'iPhone', pubKey: 'AAAA' }],
		});
		await fs.writeFile(statePath, content);
		return content;
	}

	async function asideFiles(): Promise<string[]> {
		return (await fs.readdir(userData)).filter(name => name.startsWith('paradis-mobile-relay.json.')).map(name => name.replace(/-\d{4}-.*$/, '-<time>')).sort();
	}

	function statusOf(status: IParadisMobileStatus): object {
		return { state: status.state, pairedDevices: status.pairedDevices, storeProblem: status.storeProblem };
	}

	test('treats a missing file as the first run and creates a new key there', async () => {
		const service = createService(new FakeEncryptionService());
		try {
			await service.initialize(false, undefined);
			await (service as unknown as IServiceInternals).ensureIdentity();
			const saved = paradisParseRelayState(await fs.readFile(statePath, 'utf8'));
			assert.deepStrictEqual({ status: statusOf(await service.getStatus()), hasIdentity: saved?.identity?.encSecret?.startsWith('enc:') }, {
				status: { state: 'disabled', pairedDevices: [], storeProblem: undefined },
				hasIdentity: true,
			});
		} finally {
			service.dispose();
		}
	});

	test('keeps an undecryptable file untouched, refuses to overwrite it and recovers on retry', async () => {
		const original = await writeStoredIdentity();
		const encryption = new FakeEncryptionService();
		encryption.failDecrypt = true;
		const service = createService(encryption);
		try {
			await service.initialize(false, undefined);
			const internals = service as unknown as IServiceInternals;
			const blocked = statusOf(await service.getStatus());
			const saveError = await internals.save().then(() => undefined, (error: Error) => error.message);
			const identityError = await internals.ensureIdentity().then(() => undefined, (error: Error) => error.message);
			const untouched = await fs.readFile(statePath, 'utf8') === original;

			encryption.failDecrypt = false;
			await service.retryLoadState();

			assert.deepStrictEqual({
				blocked,
				refusedSave: saveError !== undefined,
				refusedNewKey: identityError !== undefined,
				untouched,
				recovered: statusOf(await service.getStatus()),
				hasIdentity: internals.identity !== undefined,
				aside: await asideFiles(),
			}, {
				blocked: { state: 'disabled', pairedDevices: ['iPhone'], storeProblem: 'undecryptable' },
				refusedSave: true,
				refusedNewKey: true,
				untouched: true,
				recovered: { state: 'disabled', pairedDevices: ['iPhone'], storeProblem: undefined },
				hasIdentity: true,
				aside: [],
			});
		} finally {
			service.dispose();
		}
	});

	test('moves an undecryptable file aside only when the user discards it, then starts empty', async () => {
		await writeStoredIdentity();
		const encryption = new FakeEncryptionService();
		encryption.failDecrypt = true;
		const service = createService(encryption);
		try {
			await service.initialize(false, undefined);
			await service.discardUnreadableState();
			assert.deepStrictEqual({ status: statusOf(await service.getStatus()), aside: await asideFiles(), original: await fs.access(statePath).then(() => true, () => false) }, {
				status: { state: 'disabled', pairedDevices: [], storeProblem: undefined },
				aside: ['paradis-mobile-relay.json.undecryptable-<time>'],
				original: false,
			});
		} finally {
			service.dispose();
		}
	});

	test('moves a corrupt file aside, reports it, and clears the report once a new state is saved', async () => {
		await fs.writeFile(statePath, '{"mobiles": [');
		const service = createService(new FakeEncryptionService());
		try {
			await service.initialize(false, undefined);
			const corrupt = statusOf(await service.getStatus());
			const aside = await asideFiles();
			// 2つ目のウィンドウの initialize でも「初回」に戻らず案内が残る
			await service.initialize(false, undefined);
			const afterSecondWindow = statusOf(await service.getStatus());
			await (service as unknown as IServiceInternals).ensureIdentity();
			assert.deepStrictEqual({ corrupt, aside, afterSecondWindow, afterSave: statusOf(await service.getStatus()) }, {
				corrupt: { state: 'disabled', pairedDevices: [], storeProblem: 'corrupt' },
				aside: ['paradis-mobile-relay.json.corrupt-<time>'],
				afterSecondWindow: { state: 'disabled', pairedDevices: [], storeProblem: 'corrupt' },
				afterSave: { state: 'disabled', pairedDevices: [], storeProblem: undefined },
			});
		} finally {
			service.dispose();
		}
	});

	test('reads the ledger once: a later window neither reloads nor rolls back a pairing, and a transient read failure does not stop it', async () => {
		await writeStoredIdentity();
		const service = createService(new FakeEncryptionService());
		try {
			await service.initialize(false, undefined);
			const internals = service as unknown as { state: { mobiles: { name: string }[] }; save(): Promise<void> };
			internals.state.mobiles.push({ name: 'iPad' } as never);
			// 別のウィンドウの initialize の時点でファイルが読めなくなっていても、止めない・巻き戻さない
			await fs.chmod(statePath, 0o000);
			await service.initialize(false, undefined);
			await fs.chmod(statePath, 0o600);
			assert.deepStrictEqual(statusOf(await service.getStatus()), { state: 'disabled', pairedDevices: ['iPhone', 'iPad'], storeProblem: undefined });
		} finally {
			await fs.chmod(statePath, 0o600).catch(() => undefined);
			service.dispose();
		}
	});

	test('serializes saves and writes the latest ledger, even when saves are fired and forgotten', async () => {
		const service = createService(new FakeEncryptionService());
		try {
			await service.initialize(false, undefined);
			const internals = service as unknown as { state: { mobiles: { mobileId: string; name: string; pubKey: string }[] }; save(): Promise<void> };
			const saves: Promise<void>[] = [];
			for (let index = 0; index < 5; index++) {
				internals.state.mobiles.push({ mobileId: `m${index}`, name: `phone ${index}`, pubKey: 'AAAA' });
				saves.push(internals.save());
			}
			await Promise.all(saves);
			const saved = paradisParseRelayState(await fs.readFile(statePath, 'utf8'));
			assert.deepStrictEqual({ names: saved?.mobiles.map(mobile => mobile.name), leftovers: (await fs.readdir(userData)).filter(name => name.endsWith('.tmp')) }, {
				names: ['phone 0', 'phone 1', 'phone 2', 'phone 3', 'phone 4'],
				leftovers: [],
			});
		} finally {
			service.dispose();
		}
	});

	test('keeps only the newest three set-aside files and removes leftover temporary files', async () => {
		for (const [index, time] of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'].entries()) {
			await fs.writeFile(`${statePath}.${index % 2 === 0 ? 'corrupt' : 'undecryptable'}-${time}T00-00-00-000Z`, 'old');
		}
		await fs.writeFile(join(userData, '.paradis-mobile-relay.json.paradis-crashed.tmp'), 'half');
		await fs.writeFile(join(userData, 'unrelated.json.corrupt-2026-01-01T00-00-00-000Z'), 'keep');
		await fs.writeFile(statePath, 'not json');
		const service = createService(new FakeEncryptionService());
		try {
			await service.initialize(false, undefined);
			const entries = (await fs.readdir(userData)).filter(name => name.includes('.json')).sort()
				.map(name => name.replace(/^(paradis-mobile-relay\.json\.corrupt-)(?!2026-09-0[1-4]T).*$/, '$1<now>'));
			assert.deepStrictEqual(entries, [
				'paradis-mobile-relay.json.corrupt-2026-09-03T00-00-00-000Z',
				'paradis-mobile-relay.json.corrupt-<now>',
				'paradis-mobile-relay.json.undecryptable-2026-09-04T00-00-00-000Z',
				'unrelated.json.corrupt-2026-01-01T00-00-00-000Z',
			]);
		} finally {
			service.dispose();
		}
	});

	test('hands the unreadable-key notice to one window only, and again after the problem changes', async () => {
		await writeStoredIdentity();
		const encryption = new FakeEncryptionService();
		encryption.failDecrypt = true;
		const service = createService(encryption);
		try {
			await service.initialize(false, undefined);
			const first = [await service.claimStoreProblemNotice('undecryptable'), await service.claimStoreProblemNotice('undecryptable'), await service.claimStoreProblemNotice('unreadable')];
			encryption.failDecrypt = false;
			await service.retryLoadState();
			encryption.failDecrypt = true;
			(service as unknown as { stateLoaded: boolean }).stateLoaded = false;
			await service.initialize(false, undefined);
			const again = await service.claimStoreProblemNotice('undecryptable');
			assert.deepStrictEqual({ first, again }, { first: [true, false, false], again: true });
		} finally {
			service.dispose();
		}
	});

	test('revokes only the picked phone when two share a name, and drops its connection even when the ledger cannot be written', async () => {
		// 端末（device）は持たせない: リレーへの取り消しを送らない（テストからネットワークへ出ない）
		await fs.writeFile(statePath, JSON.stringify({
			mobiles: [{ mobileId: 'm1', name: 'iPhone', pubKey: 'AAAA' }, { mobileId: 'm2', name: 'iPhone', pubKey: 'AAAA' }, { mobileId: 'm3', name: 'iPad', pubKey: 'AAAA' }],
		}));
		// 台帳の書き込みを失敗させられるようにする（ENOSPC・権限などの代わり）
		let failWrites = false;
		const service = createService(new FakeEncryptionService(), async (filePath, state) => {
			if (failWrites) {
				throw new Error('ENOSPC');
			}
			await paradisWriteRelayState(filePath, state);
		});
		try {
			await service.initialize(false, undefined);
			const sessions = (service as unknown as { sessions: Map<string, unknown> }).sessions;
			await service.revokeDevice('iPhone', 'm2');
			const afterId = (await service.getStatus()).pairedMobiles;
			const savedAfterId = paradisParseRelayState(await fs.readFile(statePath, 'utf8'))?.mobiles.map(mobile => mobile.mobileId);
			sessions.set('m3', { close: () => { } });
			failWrites = true;
			const failed = await service.revokeDevice('iPad', 'm3').then(() => 'saved', () => 'rejected');
			assert.deepStrictEqual({
				afterId,
				savedAfterId,
				failed,
				sessions: [...sessions.keys()],
				status: (await service.getStatus()).pairedDevices,
			}, {
				afterId: [{ mobileId: 'm1', name: 'iPhone' }, { mobileId: 'm3', name: 'iPad' }],
				savedAfterId: ['m1', 'm3'],
				failed: 'rejected',
				sessions: [],
				status: ['iPhone'],
			});
		} finally {
			service.dispose();
		}
	});

	test('validates the shape of the stored state', () => {
		assert.deepStrictEqual([
			paradisParseRelayState('{}')?.mobiles,
			paradisParseRelayState('[]'),
			paradisParseRelayState('{"mobiles":[{"mobileId":1}]}'),
			paradisParseRelayState('{"mobiles":[],"device":{"deviceId":"d"}}'),
			paradisParseRelayState('{"mobiles":[],"identity":{"pubKey":"p","encSecret":1}}'),
			paradisParseRelayState('{"mobiles":[],"future":1}'),
			paradisRelayStateAsidePath('/x/state.json', 'corrupt', new Date(Date.UTC(2026, 8, 28, 1, 2, 3, 4))),
		], [
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			{ mobiles: [], future: 1, device: undefined, identity: undefined },
			'/x/state.json.corrupt-2026-09-28T01-02-03-004Z',
		]);
	});
});

suite('ParadisMobileRelayService reconnect pacing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses full jitter below a doubling cap with a floor', () => {
		const at = (random: number) => [1, 2, 3, 7, 20].map(attempt => paradisRelayReconnectDelayMs(attempt, () => random));
		assert.deepStrictEqual({
			low: at(0),
			high: at(0.999999),
			unauthorized: [0, 0.5, 0.999999].map(random => paradisRelayJitteredDelayMs(300_000, () => random)),
		}, {
			low: [PARADIS_RELAY_RETRY_MIN_MS, PARADIS_RELAY_RETRY_MIN_MS, PARADIS_RELAY_RETRY_MIN_MS, PARADIS_RELAY_RETRY_MIN_MS, PARADIS_RELAY_RETRY_MIN_MS],
			high: [499, 999, 1999, 29_999, PARADIS_RELAY_RETRY_CEILING_MS - 1],
			unauthorized: [225_000, 300_000, 374_999],
		});
	});

	interface IFakeSocket {
		readyState: number;
		sent: unknown[];
		closed: Array<[number | undefined, string | undefined]>;
		send(data: unknown): void;
		close(code?: number, reason?: string): void;
	}

	function fakeSocket(): IFakeSocket {
		return {
			readyState: WebSocket.OPEN,
			sent: [],
			closed: [],
			send(data) { this.sent.push(data); },
			close(code, reason) { this.closed.push([code, reason]); },
		};
	}

	/** 接続まわりだけを持つ最小の見本（本物の WebSocket やリレーには繋がない）。 */
	function resumeFixture(socket: IFakeSocket | undefined, keepaliveAcknowledged: boolean) {
		const events: string[] = [];
		const fixture = Object.assign(Object.create(ParadisMobileRelayService.prototype) as object, {
			enabled: true,
			storeProblem: undefined,
			state: { mobiles: [], device: { deviceId: 'd', pcToken: 't' } },
			socket,
			keepaliveAcknowledged,
			awaitingPong: false,
			reconnectAttempt: 6,
			reconnectTimer: undefined,
			resumeProbeTimer: undefined,
			keepaliveTimer: undefined,
			connectTimer: undefined,
			connect: () => events.push('connect'),
			onKeepaliveTimeout: () => events.push('keepalive-timeout'),
			handleDisconnected: (operation: string) => events.push(`disconnected:${operation}`),
		}) as unknown as { handleSystemResume(): Promise<void>; reconnectAttempt: number; awaitingPong: boolean; socket: unknown; reconnectTimer: unknown };
		return { fixture, events };
	}

	test('probes a live connection right after the system resumes and drops it when no pong arrives', () => runWithFakedTimers({}, async () => {
		const socket = fakeSocket();
		const { fixture, events } = resumeFixture(socket, true);
		await fixture.handleSystemResume();
		const sentPing = socket.sent.length === 1;
		await new Promise(resolve => setTimeout(resolve, 6_000));
		assert.deepStrictEqual({ sentPing, events, attempt: fixture.reconnectAttempt }, { sentPing: true, events: ['keepalive-timeout'], attempt: 0 });
	}));

	test('keeps the connection when the pong comes back after resume', () => runWithFakedTimers({}, async () => {
		const socket = fakeSocket();
		const { fixture, events } = resumeFixture(socket, true);
		await fixture.handleSystemResume();
		fixture.awaitingPong = false;
		await new Promise(resolve => setTimeout(resolve, 6_000));
		assert.deepStrictEqual(events, []);
	}));

	test('the periodic keepalive check does not close a healthy connection while the resume probe waits, and the probe does not count toward giving up', () => runWithFakedTimers({}, async () => {
		const socket = fakeSocket();
		const service = Object.assign(Object.create(ParadisMobileRelayService.prototype) as object, {
			socket,
			keepaliveAcknowledged: true,
			awaitingPong: false,
			consecutiveKeepaliveTimeouts: 0,
			lastPingSentAt: 0,
			keepaliveTimer: undefined,
			resumeProbeTimer: undefined,
			stableConnectionTimer: undefined,
			enabled: true,
			storeProblem: undefined,
			state: { mobiles: [], device: { deviceId: 'd', pcToken: 't' } },
			reconnectAttempt: 0,
			handleDisconnected: () => undefined,
		}) as unknown as {
			startKeepalive(socket: unknown): void;
			stopKeepalive(): void;
			handleSystemResume(): Promise<void>;
			awaitingPong: boolean;
			consecutiveKeepaliveTimeouts: number;
			socket: unknown;
		};
		service.startKeepalive(socket);
		service.awaitingPong = false; // 接続直後の ping に pong が返った
		await new Promise(resolve => setTimeout(resolve, 44_000));
		await service.handleSystemResume(); // 定期チェックの 1 秒前に復帰の ping
		await new Promise(resolve => setTimeout(resolve, 2_000)); // 定期チェックが来る（まだ返事待ち）
		const afterTick = { closed: socket.closed.length, socket: service.socket === socket };
		service.awaitingPong = false; // 復帰の ping に返事が来た
		await new Promise(resolve => setTimeout(resolve, 4_000));
		const healthy = { closed: socket.closed.length, socket: service.socket === socket };
		// 次は復帰のプローブが見切る
		await service.handleSystemResume();
		await new Promise(resolve => setTimeout(resolve, 6_000));
		service.stopKeepalive();
		assert.deepStrictEqual({ afterTick, healthy, closed: socket.closed, timeouts: service.consecutiveKeepaliveTimeouts }, {
			afterTick: { closed: 0, socket: true },
			healthy: { closed: 0, socket: true },
			closed: [[4001, 'keepalive timeout']],
			timeouts: 0,
		});
	}));

	test('replaces a connection it cannot probe and dials at once when it was waiting to retry', async () => {
		const socket = fakeSocket();
		const unprobeable = resumeFixture(socket, false);
		await unprobeable.fixture.handleSystemResume();

		const waiting = resumeFixture(undefined, true);
		waiting.fixture.reconnectTimer = setTimeout(() => assert.fail('the pending retry should be replaced'), 60_000);
		await waiting.fixture.handleSystemResume();

		assert.deepStrictEqual({
			unprobeable: { events: unprobeable.events, closed: socket.closed, socket: unprobeable.fixture.socket },
			waiting: { events: waiting.events, timer: waiting.fixture.reconnectTimer, attempt: waiting.fixture.reconnectAttempt },
		}, {
			unprobeable: { events: ['disconnected:system-resume'], closed: [[4003, 'system resume']], socket: undefined },
			waiting: { events: ['connect'], timer: undefined, attempt: 0 },
		});
	});
});
