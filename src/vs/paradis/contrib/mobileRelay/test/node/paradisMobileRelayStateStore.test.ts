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
import { paradisParseRelayState, paradisRelayStateAsidePath } from '../../node/paradisMobileRelayStateFile.js';
import { ParadisMobileRelayService } from '../../node/paradisMobileRelayService.js';
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

	function createService(encryption: FakeEncryptionService): ParadisMobileRelayService {
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
			{ disableHostResourceSampling: true },
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
