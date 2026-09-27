/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs, existsSync } from 'fs';
import { createConnection, createServer, Server, Socket } from 'net';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_COMPUTER_USE_APP_NAME, PARADIS_COMPUTER_USE_EXECUTABLE, PARADIS_COMPUTER_USE_PROTOCOL_VERSION } from '../../common/paradisComputerUse.js';
import { IParadisComputerUseHelperHost, ParadisComputerUseHelperClient, ParadisComputerUseHelperError, paradisIsSupportedDarwin, paradisParseHelperStatus } from '../../node/paradisComputerUseHelperClient.js';

type FakeReply = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } | 'hang' | 'crash';

interface IFakeHelperOptions {
	protocolVersion?: number;
	responsibility?: 'self' | 'other' | 'unknown';
	/** 起動しても listen しない。 */
	neverListen?: boolean;
	/** `open` が失敗する。 */
	launchFails?: boolean;
	reply?(method: string, params: Record<string, unknown>): FakeReply;
}

/**
 * 補助アプリの代わり。`launch` でトークンのファイルを読んで消し、渡されたパスで 1 本だけ接続を受け、
 * 本物と同じ 1 行 1 JSON で答える。
 */
class FakeHelper {
	launches = 0;
	readonly handshakeTokens: string[] = [];
	readonly tokenFileModes: number[] = [];
	readonly requests: string[] = [];
	readonly staleTerminated: number[] = [];
	private readonly _servers: Server[] = [];
	private readonly _sockets: Socket[] = [];

	constructor(private readonly _options: IFakeHelperOptions = {}) { }

	host(root: string, overrides: Partial<IParadisComputerUseHelperHost> = {}): IParadisComputerUseHelperHost {
		return {
			platform: 'darwin',
			osRelease: '24.1.0',
			helperCandidates: [join(root, 'missing', PARADIS_COMPUTER_USE_APP_NAME), join(root, 'app', PARADIS_COMPUTER_USE_APP_NAME)],
			runtimeDirectory: join(root, 'runtime'),
			exists: path => existsSync(path),
			launch: (_appPath, args) => this._launch(args),
			connect: socketPath => createConnection(socketPath),
			terminateStaleHelper: async pid => { this.staleTerminated.push(pid); },
			randomToken: () => 'ab'.repeat(32),
			...overrides,
		};
	}

	/** 今つながっている接続を切る（補助アプリが落ちたことにする）。 */
	crash(): void {
		for (const socket of this._sockets) {
			socket.destroy();
		}
	}

	async close(): Promise<void> {
		this.crash();
		await Promise.all(this._servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
	}

	private async _launch(args: readonly string[]): Promise<void> {
		this.launches++;
		if (this._options.launchFails) {
			throw new Error('open exited with 1');
		}
		const socketPath = args[args.indexOf('--socket') + 1];
		const tokenFile = args[args.indexOf('--token-file') + 1];
		this.tokenFileModes.push((await fs.stat(tokenFile)).mode & 0o777);
		const token = await fs.readFile(tokenFile, 'utf8');
		await fs.rm(tokenFile);
		if (this._options.neverListen) {
			return;
		}
		const server = createServer(socket => {
			// 1 本だけ受ける
			server.close();
			this._sockets.push(socket);
			let buffer = '';
			socket.setEncoding('utf8');
			socket.on('data', (chunk: string) => {
				buffer += chunk;
				let newline = buffer.indexOf('\n');
				while (newline >= 0) {
					this._answer(socket, token, JSON.parse(buffer.slice(0, newline)));
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf('\n');
				}
			});
			socket.on('error', () => undefined);
		});
		this._servers.push(server);
		await new Promise<void>(resolve => server.listen(socketPath, () => resolve()));
	}

	private _answer(socket: Socket, token: string, request: { id: number; method: string; params: Record<string, unknown> }): void {
		this.requests.push(request.method);
		if (request.method === 'handshake') {
			this.handshakeTokens.push(String(request.params.token));
			if (request.params.token !== token) {
				socket.destroy();
				return;
			}
			socket.write(`${JSON.stringify({ id: request.id, ok: true, result: this._status() })}\n`);
			return;
		}
		const reply = this._options.reply?.(request.method, request.params) ?? { ok: true, result: request.method === 'status' ? this._status() : {} };
		if (reply === 'hang') {
			return;
		}
		if (reply === 'crash') {
			socket.destroy();
			return;
		}
		socket.write(`${JSON.stringify(reply.ok ? { id: request.id, ok: true, result: reply.result } : { id: request.id, ok: false, error: reply.error })}\n`);
	}

	private _status(): object {
		return {
			protocolVersion: this._options.protocolVersion ?? PARADIS_COMPUTER_USE_PROTOCOL_VERSION,
			helperVersion: '0.1.0',
			pid: 4321,
			osVersion: '15.1.0',
			permissions: { accessibility: 'not-granted', screenRecording: 'granted' },
			responsibility: { status: this._options.responsibility ?? 'self', pid: this._options.responsibility === 'other' ? 1 : 4321 },
		};
	}
}

suite('ParadisComputerUseHelperClient', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	const fakes: FakeHelper[] = [];

	setup(async () => {
		// macOS の一時フォルダは長いので、ソケットのパスが上限に収まるよう短い名前にする
		root = await fs.mkdtemp(join(tmpdir(), 'pcu-'));
		const executable = join(root, 'app', PARADIS_COMPUTER_USE_APP_NAME, 'Contents', 'MacOS', PARADIS_COMPUTER_USE_EXECUTABLE);
		await fs.mkdir(join(executable, '..'), { recursive: true });
		await fs.writeFile(executable, '');
	});

	teardown(async () => {
		await Promise.all(fakes.splice(0).map(fake => fake.close()));
		await fs.rm(root, { recursive: true, force: true });
	});

	function createClient(options: IFakeHelperOptions = {}, overrides: Partial<IParadisComputerUseHelperHost> = {}) {
		const fake = new FakeHelper(options);
		fakes.push(fake);
		const client = disposables.add(new ParadisComputerUseHelperClient(fake.host(root, overrides), undefined, { requestTimeoutMs: 300, launchTimeoutMs: 500 }));
		return { fake, client };
	}

	test('launches the helper, authenticates with a one-time token and reads its status', async () => {
		await fs.mkdir(join(root, 'runtime'), { recursive: true, mode: 0o755 });
		await fs.writeFile(join(root, 'runtime', 'helper.pid'), '777');
		const { fake, client } = createClient();
		const availability = await client.check();
		const apps = await client.request('listApps');
		const runtimeEntries = (await fs.readdir(join(root, 'runtime'))).sort();
		assert.deepStrictEqual({
			availability,
			status: client.lastStatus,
			apps,
			launches: fake.launches,
			handshakeTokens: fake.handshakeTokens,
			tokenFileModes: fake.tokenFileModes,
			requests: fake.requests,
			staleTerminated: fake.staleTerminated,
			runtimeMode: (await fs.stat(join(root, 'runtime'))).mode & 0o777,
			runtimeEntries,
			pidFile: await fs.readFile(join(root, 'runtime', 'helper.pid'), 'utf8'),
		}, {
			availability: 'ok',
			status: {
				protocolVersion: PARADIS_COMPUTER_USE_PROTOCOL_VERSION,
				helperVersion: '0.1.0',
				pid: 4321,
				osVersion: '15.1.0',
				permissions: { accessibility: false, screenRecording: true },
				responsibility: 'self',
				responsiblePid: 4321,
			},
			apps: {},
			launches: 1,
			handshakeTokens: ['ab'.repeat(32)],
			tokenFileModes: [0o600],
			requests: ['handshake', 'status', 'listApps'],
			staleTerminated: [777],
			runtimeMode: 0o700,
			// ソケットとトークンを置いたその起動だけのフォルダは残さない
			runtimeEntries: ['helper.pid'],
			pidFile: '4321',
		});
	});

	test('reports the OS and a missing helper without launching anything', async () => {
		const old = createClient({}, { osRelease: '22.6.0' });
		const linux = createClient({}, { platform: 'linux', osRelease: '6.1.0' });
		const missing = createClient({}, { helperCandidates: [join(root, 'nowhere', PARADIS_COMPUTER_USE_APP_NAME)] });
		assert.deepStrictEqual({
			old: await old.client.check(),
			linux: await linux.client.check(),
			missing: await missing.client.check(),
			launches: old.fake.launches + linux.fake.launches + missing.fake.launches,
			staticMissing: missing.client.staticAvailability(),
		}, { old: 'unsupported-os', linux: 'unsupported-os', missing: 'missing', launches: 0, staticMissing: 'missing' });
	});

	test('turns a failed launch, a helper that never listens, a protocol mismatch and a misattributed helper into states', async () => {
		const launchFails = createClient({ launchFails: true });
		const neverListens = createClient({ neverListen: true });
		const incompatible = createClient({ protocolVersion: PARADIS_COMPUTER_USE_PROTOCOL_VERSION + 1 });
		const misattributed = createClient({ responsibility: 'other' });
		const unknownResponsibility = createClient({ responsibility: 'unknown' });
		assert.deepStrictEqual({
			launchFails: await launchFails.client.check(),
			neverListens: await neverListens.client.check(),
			incompatible: await incompatible.client.check(),
			misattributed: await misattributed.client.check(),
			// 非公開 API が無くて確かめられないときは止めない（設計書 8 章 3 番）
			unknownResponsibility: await unknownResponsibility.client.check(),
		}, { launchFails: 'launch-failed', neverListens: 'launch-failed', incompatible: 'incompatible', misattributed: 'misattributed', unknownResponsibility: 'ok' });
		await assert.rejects(launchFails.client.request('listApps'), (error: ParadisComputerUseHelperError) => error.code === 'unavailable');
	});

	test('passes helper errors through with their code', async () => {
		const { client } = createClient({ reply: method => method === 'accessibilityTree' ? { ok: false, error: { code: 'accessibility_not_granted', message: 'no' } } : { ok: true, result: {} } });
		await client.check();
		await assert.rejects(client.request('accessibilityTree', { pid: 1 }), (error: ParadisComputerUseHelperError) => error.code === 'accessibility_not_granted');
		assert.strictEqual(client.availability, 'ok');
	});

	test('gives up on a request that does not answer and starts a new helper for the next one', async () => {
		let hang = true;
		const { fake, client } = createClient({ reply: method => method === 'listApps' && hang ? 'hang' : { ok: true, result: { apps: [] } } });
		await client.check();
		await assert.rejects(client.request('listApps'), (error: ParadisComputerUseHelperError) => error.code === 'timeout');
		hang = false;
		assert.deepStrictEqual({ next: await client.request('listApps'), launches: fake.launches, availability: client.availability }, { next: { apps: [] }, launches: 2, availability: 'ok' });
	});

	test('restarts once after a crash while answering and stops after a second one', async () => {
		const { fake, client } = createClient({ reply: method => method === 'listApps' ? 'crash' : { ok: true, result: {} } });
		await client.check();
		await assert.rejects(client.request('listApps'), (error: ParadisComputerUseHelperError) => error.code === 'helper_disconnected');
		const afterFirst = client.availability;
		await assert.rejects(client.request('listApps'), (error: ParadisComputerUseHelperError) => error.code === 'helper_disconnected');
		assert.deepStrictEqual({ afterFirst, afterSecond: client.availability, launches: fake.launches }, { afterFirst: 'ok', afterSecond: 'launch-failed', launches: 2 });
		// 設定を入れ直す（check）と、もう一度試す
		assert.strictEqual(await client.check(), 'ok');
	});

	test('an idle helper that exits is started again on the next request without counting as a crash', async () => {
		const { fake, client } = createClient({ reply: () => ({ ok: true, result: { ok: true } }) });
		await client.check();
		fake.crash();
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepStrictEqual({ result: await client.request('permissions'), launches: fake.launches, availability: client.availability }, { result: { ok: true }, launches: 2, availability: 'ok' });
	});

	test('stops the helper when turned off and reports only the static state', async () => {
		const { fake, client } = createClient();
		await client.check();
		client.markDisabled();
		assert.deepStrictEqual({ availability: client.availability, launches: fake.launches }, { availability: 'unchecked', launches: 1 });
	});

	test('parses the handshake and the Darwin version', () => {
		assert.deepStrictEqual({
			status: paradisParseHelperStatus({ protocolVersion: 1, helperVersion: '1', pid: 2, permissions: { accessibility: 'granted', screenRecording: 'maybe' }, responsibility: { status: 'weird' } }),
			broken: paradisParseHelperStatus({ protocolVersion: '1' }),
			sonoma: paradisIsSupportedDarwin('darwin', '23.0.0'),
			ventura: paradisIsSupportedDarwin('darwin', '22.6.0'),
			windows: paradisIsSupportedDarwin('win32', '10.0.22631'),
		}, {
			status: { protocolVersion: 1, helperVersion: '1', pid: 2, permissions: { accessibility: true, screenRecording: false }, responsibility: 'unknown' },
			broken: undefined,
			sonoma: true,
			ventura: false,
			windows: false,
		});
	});
});
