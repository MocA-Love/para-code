/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続していないホストへの SSH（SFTP）の結合テスト。手元の sshd ではなく、ssh2 の Server を 127.0.0.1 に立て、
// 一時フォルダーを根にした SFTP を返させる。鍵ファイル＋IdentitiesOnly で入り、known_hosts を照合する。

import assert from 'assert';
import * as fs from 'fs';
import type { AddressInfo } from 'net';
import * as os from 'os';
import type { ParsedKey, Server, SFTPWrapper } from 'ssh2';
import { VSBuffer, bufferToStream, newWriteableBufferStream } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join, posix } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisSshHostConfig, paradisSftpUri, PARADIS_SFTP_SCHEME } from '../../common/paradisSftp.js';
import { ParadisSftpFileSystemProvider } from '../../common/paradisSftpFileSystemProvider.js';
import { IParadisSftpEnvironment, IParadisSsh2Module, paradisLoadSsh2, paradisResolveAgentPath } from '../../node/paradisSftpConnection.js';
import { ParadisSftpChannel, ParadisSftpService } from '../../node/paradisSftpService.js';

interface IServerModule extends IParadisSsh2Module {
	readonly Server: (new (config: { hostKeys: string[] }, listener: (client: ServerClient) => void) => Server) & { KEEPALIVE_CLIENT_INTERVAL: number };
	readonly utils: IParadisSsh2Module['utils'] & {
		generateKeyPairSync(type: string, options?: object): { private: string; public: string };
		sftp: { flagsToString(flags: number): string; STATUS_CODE: Record<string, number> };
	};
}

// ssh2 の server 側の型は細かいので、テストで使う形だけを書く
interface ServerClient {
	on(event: 'authentication', listener: (context: IAuthContext) => void): ServerClient;
	on(event: 'ready', listener: () => void): ServerClient;
	on(event: 'session', listener: (accept: () => { on(event: 'sftp', listener: (accept: () => SFTPWrapper) => void): void }) => void): ServerClient;
	on(event: 'error', listener: (error: Error) => void): ServerClient;
	end(): void;
}

interface IAuthContext {
	readonly method: string;
	readonly key?: { readonly algo: string; readonly data: Buffer };
	readonly signature?: Buffer;
	readonly blob?: Buffer;
	readonly hashAlgo?: string;
	accept(): void;
	reject(methods?: string[]): void;
}

function generateKeys(ssh2: IServerModule): { private: string; public: string } {
	// テストの renderer の crypto では、まれに ssh2 が読めない鍵ができる。読めるものができるまで作り直す
	for (let attempt = 0; attempt < 10; attempt++) {
		let keys: { private: string; public: string };
		try {
			keys = ssh2.utils.generateKeyPairSync('ed25519');
		} catch {
			keys = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 });
		}
		if (!(ssh2.utils.parseKey(keys.private) instanceof Error)) {
			return keys;
		}
	}
	throw new Error('could not generate a usable key');
}

/** 一時フォルダーを根にした SFTP（OpenSSH と同じく rename は上書きしない。posix-rename は無い）。 */
function serveSftp(ssh2: IServerModule, sftp: SFTPWrapper, root: string): void {
	const { STATUS_CODE } = ssh2.utils.sftp;
	const server = sftp as unknown as {
		on(event: string, listener: (...args: never[]) => void): unknown;
		status(id: number, code: number): void;
		handle(id: number, handle: Buffer): void;
		data(id: number, data: Buffer): void;
		attrs(id: number, attrs: object): void;
		name(id: number, names: object[]): void;
	};
	const real = (path: string) => join(root, posix.normalize(`/${path}`).slice(1));
	const handles = new Map<number, { fd?: number; dir?: string; listed?: boolean }>();
	let next = 1;
	const toHandle = (id: number) => {
		const buffer = Buffer.alloc(4);
		buffer.writeUInt32BE(id, 0);
		return buffer;
	};
	const fromHandle = (handle: Buffer) => handles.get(handle.readUInt32BE(0));
	const attrs = (stats: fs.Stats) => ({ mode: stats.mode, uid: stats.uid, gid: stats.gid, size: stats.size, atime: Math.floor(stats.atimeMs / 1000), mtime: Math.floor(stats.mtimeMs / 1000) });
	const fail = (id: number, error: unknown) => {
		const code = (error as NodeJS.ErrnoException).code;
		server.status(id, code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : code === 'EACCES' ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE);
	};
	const guard = (id: number, run: () => void) => {
		try {
			run();
		} catch (error) {
			fail(id, error);
		}
	};
	server.on('REALPATH', (id: number, path: string) => {
		const absolute = path === '.' ? '/home' : posix.normalize(path);
		server.name(id, [{ filename: absolute, longname: absolute, attrs: {} }]);
	});
	server.on('STAT', (id: number, path: string) => guard(id, () => server.attrs(id, attrs(fs.statSync(real(path))))));
	server.on('LSTAT', (id: number, path: string) => guard(id, () => server.attrs(id, attrs(fs.lstatSync(real(path))))));
	server.on('OPEN', (id: number, path: string, flags: number) => guard(id, () => {
		const fd = fs.openSync(real(path), ssh2.utils.sftp.flagsToString(flags));
		const handle = next++;
		handles.set(handle, { fd });
		server.handle(id, toHandle(handle));
	}));
	server.on('READ', (id: number, handle: Buffer, offset: number, length: number) => guard(id, () => {
		const buffer = Buffer.alloc(length);
		const read = fs.readSync(fromHandle(handle)!.fd!, buffer, 0, length, offset);
		if (read === 0) {
			server.status(id, STATUS_CODE.EOF);
		} else {
			server.data(id, buffer.subarray(0, read));
		}
	}));
	server.on('WRITE', (id: number, handle: Buffer, offset: number, data: Buffer) => guard(id, () => {
		fs.writeSync(fromHandle(handle)!.fd!, data, 0, data.length, offset);
		server.status(id, STATUS_CODE.OK);
	}));
	server.on('CLOSE', (id: number, handle: Buffer) => guard(id, () => {
		const key = handle.readUInt32BE(0);
		const open = handles.get(key);
		if (open?.fd !== undefined) {
			fs.closeSync(open.fd);
		}
		handles.delete(key);
		server.status(id, STATUS_CODE.OK);
	}));
	server.on('OPENDIR', (id: number, path: string) => guard(id, () => {
		if (!fs.statSync(real(path)).isDirectory()) {
			throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
		}
		const handle = next++;
		handles.set(handle, { dir: real(path) });
		server.handle(id, toHandle(handle));
	}));
	server.on('READDIR', (id: number, handle: Buffer) => guard(id, () => {
		const open = fromHandle(handle)!;
		if (open.listed) {
			server.status(id, STATUS_CODE.EOF);
			return;
		}
		open.listed = true;
		const names = fs.readdirSync(open.dir!).map(name => ({ filename: name, longname: name, attrs: attrs(fs.lstatSync(join(open.dir!, name))) }));
		if (names.length) {
			server.name(id, names);
		} else {
			server.status(id, STATUS_CODE.EOF);
		}
	}));
	server.on('MKDIR', (id: number, path: string) => guard(id, () => {
		fs.mkdirSync(real(path));
		server.status(id, STATUS_CODE.OK);
	}));
	server.on('REMOVE', (id: number, path: string) => guard(id, () => {
		fs.unlinkSync(real(path));
		server.status(id, STATUS_CODE.OK);
	}));
	server.on('RMDIR', (id: number, path: string) => guard(id, () => {
		fs.rmdirSync(real(path));
		server.status(id, STATUS_CODE.OK);
	}));
	server.on('RENAME', (id: number, from: string, to: string) => guard(id, () => {
		if (fs.existsSync(real(to))) {
			server.status(id, STATUS_CODE.FAILURE);
			return;
		}
		fs.renameSync(real(from), real(to));
		server.status(id, STATUS_CODE.OK);
	}));
	server.on('SETSTAT', (id: number, path: string, attributes: { mode?: number }) => guard(id, () => {
		if (attributes.mode !== undefined) {
			fs.chmodSync(real(path), attributes.mode & 0o7777);
		}
		server.status(id, STATUS_CODE.OK);
	}));
}

interface ITestServer {
	readonly port: number;
	readonly hostPublicKey: string;
	close(): Promise<void>;
}

async function startServer(ssh2: IServerModule, root: string, allowedUserKey: ParsedKey, mode: 'publickey' | 'passwordOnly'): Promise<ITestServer> {
	const hostKeys = generateKeys(ssh2);
	const clients = new Set<ServerClient>();
	const server = new ssh2.Server({ hostKeys: [hostKeys.private] }, client => {
		clients.add(client);
		client.on('error', () => { /* 切断はテストの外 */ });
		client.on('authentication', context => {
			if (mode === 'passwordOnly') {
				context.reject(['password', 'keyboard-interactive']);
				return;
			}
			if (context.method !== 'publickey' || !context.key || !context.key.data.equals(allowedUserKey.getPublicSSH())) {
				context.reject(['publickey']);
				return;
			}
			if (!context.signature) {
				context.accept();
				return;
			}
			if (allowedUserKey.verify(context.blob!, context.signature, context.hashAlgo)) {
				context.accept();
			} else {
				context.reject(['publickey']);
			}
		});
		client.on('ready', () => {
			client.on('session', accept => {
				accept().on('sftp', acceptSftp => serveSftp(ssh2, acceptSftp(), root));
			});
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	return {
		port: (server.address() as AddressInfo).port,
		hostPublicKey: hostKeys.public,
		close: () => new Promise<void>(resolve => {
			for (const client of clients) {
				client.end();
			}
			server.close(() => resolve());
		}),
	};
}

suite('Paradis file transfer - direct SSH (SFTP)', function () {

	this.timeout(30_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let ssh2: IServerModule;
	let tmp: string;
	let root: string;
	let userKey: { private: string; public: string };
	let parsedUserKey: ParsedKey;
	let environment: IParadisSftpEnvironment;
	let disposables: DisposableStore;
	let keepaliveInterval: number;

	suiteSetup(async () => {
		ssh2 = await paradisLoadSsh2() as IServerModule;
		// テストの renderer では setInterval が数値を返し、ssh2 の Server の keepalive（timer.refresh）が落ちる。
		// テストの Server だけ keepalive を止める（本物の shared process は Node のタイマーで、Client 側は使わない）
		keepaliveInterval = ssh2.Server.KEEPALIVE_CLIENT_INTERVAL;
		ssh2.Server.KEEPALIVE_CLIENT_INTERVAL = -1;
		userKey = generateKeys(ssh2);
		// 公開鍵の文字列ではなく秘密鍵から読む（Electron の crypto では公開鍵の文字列を読めない種類がある）
		const parsed = ssh2.utils.parseKey(userKey.private);
		parsedUserKey = (Array.isArray(parsed) ? parsed[0] : parsed) as ParsedKey;
	});

	suiteTeardown(() => {
		ssh2.Server.KEEPALIVE_CLIENT_INTERVAL = keepaliveInterval;
	});

	setup(() => {
		tmp = fs.mkdtempSync(join(os.tmpdir(), 'paradis-sftp-'));
		root = join(tmp, 'root');
		fs.mkdirSync(join(root, 'home'), { recursive: true });
		fs.writeFileSync(join(tmp, 'id_test'), userKey.private, { mode: 0o600 });
		fs.writeFileSync(join(tmp, 'other_key'), generateKeys(ssh2).private, { mode: 0o600 });
		// agent は使わせない（手元の SSH_AUTH_SOCK を拾わない）
		environment = { homedir: tmp, platform: process.platform, env: {}, readFile: path => fs.promises.readFile(path) };
		disposables = store.add(new DisposableStore());
	});

	teardown(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	function hostConfig(server: ITestServer, overrides: Partial<IParadisSshHostConfig> = {}): IParadisSshHostConfig {
		return {
			alias: 'para-test',
			hostname: '127.0.0.1',
			port: server.port,
			user: 'tester',
			identityFiles: ['~/other_key', '~/id_test'],
			identitiesOnly: true,
			userKnownHostsFiles: ['~/known_hosts'],
			globalKnownHostsFiles: [],
			...overrides,
		};
	}

	function createService(config: (alias: string) => IParadisSshHostConfig): ParadisSftpService {
		const service = disposables.add(new ParadisSftpService({ logService: new NullLogService(), environment, resolveHost: async alias => config(alias), handshakeTimeoutMs: 10_000 }));
		return service;
	}

	function createFileService(service: ParadisSftpService): { fileService: FileService; provider: ParadisSftpFileSystemProvider } {
		const channel = new ParadisSftpChannel(service);
		const client: IChannel = {
			call: <T>(command: string, arg?: unknown) => channel.call<T>('', command, arg),
			listen: () => { throw new Error('no events'); },
		};
		const provider = disposables.add(new ParadisSftpFileSystemProvider(client));
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(PARADIS_SFTP_SCHEME, provider));
		return { fileService, provider };
	}

	test('鍵ファイル＋IdentitiesOnly で入り、読み書き・一覧・名前の変更・権限・削除ができる', async () => {
		const server = await startServer(ssh2, root, parsedUserKey, 'publickey');
		try {
			fs.writeFileSync(join(tmp, 'known_hosts'), `[127.0.0.1]:${server.port} ${server.hostPublicKey}\n`);
			const service = createService(() => hostConfig(server));
			const { fileService, provider } = createFileService(service);
			provider.allowHost('para-test');

			const opened = await provider.openHost('para-test');
			assert.deepStrictEqual(opened, { ok: true, home: '/home' });

			const home = paradisSftpUri('para-test', '/home');
			const big = VSBuffer.alloc(300 * 1024 + 17);
			for (let index = 0; index < big.byteLength; index++) {
				big.buffer[index] = index % 251;
			}
			// 一時名に書いてから置き換える（待ち行列と同じ手順）
			const temp = URI.joinPath(home, '.paratransfer-test');
			const target = URI.joinPath(home, 'data.bin');
			await fileService.writeFile(temp, bufferToStream(big));
			await fileService.writeFile(target, VSBuffer.fromString('old'));
			await provider.rename(temp, target, { overwrite: true });
			const read = await fileService.readFile(target);
			assert.ok(read.value.equals(big));
			assert.ok(!fs.existsSync(join(root, 'home', '.paratransfer-test')));

			// 上書きしない名前の変更は、送り先があれば FileExists で断る
			await fileService.writeFile(temp, VSBuffer.fromString('x'));
			await assert.rejects(provider.rename(temp, target, { overwrite: false }), (error: Error) => toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileExists);

			await fileService.createFolder(URI.joinPath(home, 'dir'));
			await fileService.writeFile(URI.joinPath(home, 'dir', 'run.sh'), VSBuffer.fromString('#!/bin/sh'));
			await provider.chmod(URI.joinPath(home, 'dir', 'run.sh'), 0o750, false);
			const info = await provider.statFile(URI.joinPath(home, 'dir', 'run.sh'));
			const listing = await provider.list(home);
			assert.deepStrictEqual({
				info,
				missing: await provider.statFile(URI.joinPath(home, 'nothing')),
				entries: listing.entries.map(entry => ({ name: entry.name, kind: entry.kind, isDirectory: entry.isDirectory })).sort((a, b) => a.name.localeCompare(b.name)),
				stat: (await fileService.stat(target)).size,
			}, {
				info: { mode: 0o750, ownedByMe: true, isDirectory: false, isSymbolicLink: false },
				missing: undefined,
				entries: [
					{ name: '.paratransfer-test', kind: 'file', isDirectory: false },
					{ name: 'data.bin', kind: 'file', isDirectory: false },
					{ name: 'dir', kind: 'directory', isDirectory: true },
				],
				stat: big.byteLength,
			});

			await fileService.del(URI.joinPath(home, 'dir'), { recursive: true });
			await assert.rejects(fileService.readFile(URI.joinPath(home, 'nothing')), (error: Error) => /nothing|not found|ENOENT|No such file/i.test(error.message) || toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound);
			assert.deepStrictEqual(fs.readdirSync(join(root, 'home')).sort(), ['.paratransfer-test', 'data.bin']);
		} finally {
			await server.close();
		}
	});

	test('書いている途中で取り消すと、ハンドルを閉じ、使い終わった接続を保持時間で閉じる', async () => {
		const server = await startServer(ssh2, root, parsedUserKey, 'publickey');
		try {
			fs.writeFileSync(join(tmp, 'known_hosts'), `[127.0.0.1]:${server.port} ${server.hostPublicKey}\n`);
			const service = createService(() => hostConfig(server));
			service.setIdleMs(50);
			const { fileService, provider } = createFileService(service);
			provider.allowHost('para-test');
			const temp = paradisSftpUri('para-test', '/home/.paratransfer-cancel');

			const stream = newWriteableBufferStream();
			const writing = fileService.writeFile(temp, stream);
			stream.write(VSBuffer.alloc(64 * 1024));
			await new Promise(resolve => setTimeout(resolve, 100));
			stream.error(new Error('cancelled'));
			stream.end();
			await assert.rejects(writing);
			// 待ち行列は失敗した一時ファイルを消す
			await fileService.del(temp).catch(() => undefined);
			assert.strictEqual(fs.existsSync(join(root, 'home', '.paratransfer-cancel')), false);

			await new Promise(resolve => setTimeout(resolve, 300));
			assert.strictEqual(service.connectionCount, 0);
		} finally {
			await server.close();
		}
	});

	test('known_hosts に無いホスト・鍵が違うホストには繋がない（受け入れて書き足さない）', async () => {
		const server = await startServer(ssh2, root, parsedUserKey, 'publickey');
		try {
			const service = createService(() => hostConfig(server));
			const { provider } = createFileService(service);
			provider.allowHost('para-test');

			fs.writeFileSync(join(tmp, 'known_hosts'), '');
			const unknown = await provider.openHost('para-test');

			const otherHostKey = generateKeys(ssh2);
			fs.writeFileSync(join(tmp, 'known_hosts'), `[127.0.0.1]:${server.port} ${otherHostKey.public}\n`);
			const mismatch = await provider.openHost('para-test');

			assert.deepStrictEqual({ unknown, mismatch, knownHosts: fs.readFileSync(join(tmp, 'known_hosts'), 'utf8') }, {
				unknown: { ok: false, reason: 'hostKeyUnknown' },
				mismatch: { ok: false, reason: 'hostKeyMismatch' },
				knownHosts: `[127.0.0.1]:${server.port} ${otherHostKey.public}\n`,
			});
		} finally {
			await server.close();
		}
	});

	test('パスワード・2 段階認証しか受け付けないホストと、ProxyJump のホストは「まだ対応していません」', async () => {
		const server = await startServer(ssh2, root, parsedUserKey, 'passwordOnly');
		try {
			fs.writeFileSync(join(tmp, 'known_hosts'), `[127.0.0.1]:${server.port} ${server.hostPublicKey}\n`);
			const service = createService(alias => alias === 'jump' ? hostConfig(server, { alias, proxyJump: 'bastion' }) : hostConfig(server));
			const { provider } = createFileService(service);
			provider.allowHost('para-test');
			provider.allowHost('jump');
			assert.deepStrictEqual([await provider.openHost('para-test'), await provider.openHost('jump')], [
				{ ok: false, reason: 'authUnsupported' },
				{ ok: false, reason: 'proxyJump' },
			]);
		} finally {
			await server.close();
		}
	});

	test('鍵ファイルが合わないホストは authUnsupported（IdentitiesOnly で他の鍵を出さない）', async () => {
		const server = await startServer(ssh2, root, parsedUserKey, 'publickey');
		try {
			fs.writeFileSync(join(tmp, 'known_hosts'), `[127.0.0.1]:${server.port} ${server.hostPublicKey}\n`);
			const service = createService(() => hostConfig(server, { identityFiles: ['~/other_key'] }));
			const { provider } = createFileService(service);
			provider.allowHost('para-test');
			assert.deepStrictEqual(await provider.openHost('para-test'), { ok: false, reason: 'authUnsupported' });
		} finally {
			await server.close();
		}
	});

	test('このウィンドウでユーザーが開いていないホストは、繋がずに断る', async () => {
		const service = createService(() => { throw new Error('should not resolve'); });
		const { fileService, provider } = createFileService(service);
		const resource = paradisSftpUri('para-test', '/home/secret');
		await assert.rejects(fileService.readFile(resource, undefined, CancellationToken.None));
		assert.deepStrictEqual([
			await provider.openHost('para-test'),
			await provider.stat(resource).then(() => 'read', (error: Error) => toFileSystemProviderErrorCode(error)),
			service.connectionCount,
		], [{ ok: false, reason: 'notAllowed' }, FileSystemProviderErrorCode.NoPermissions, 0]);
	});

	test('大文字を含む別名でも、控え（toString）を通った URI を同じホストとして通す', () => {
		const service = createService(() => { throw new Error('should not resolve'); });
		const { provider } = createFileService(service);
		provider.allowHost('Para-Test');
		const restored = URI.parse(paradisSftpUri('Para-Test', '/home/.paratransfer-x').toString());
		assert.deepStrictEqual([restored.authority, provider.isAllowed(restored.authority), provider.isAllowed('other')], ['para-test', true, false]);
	});

	test('agent の場所は IdentityAgent・SSH_AUTH_SOCK・Windows の既定の順に決める', () => {
		const base = { homedir: '/home/me', platform: 'linux' as NodeJS.Platform, env: { SSH_AUTH_SOCK: '/tmp/agent.sock', OTHER: '/tmp/other.sock' } };
		assert.deepStrictEqual([
			paradisResolveAgentPath(undefined, base),
			paradisResolveAgentPath('none', base),
			paradisResolveAgentPath('SSH_AUTH_SOCK', base),
			paradisResolveAgentPath('$OTHER', base),
			paradisResolveAgentPath('~/.1password/agent.sock', base),
			paradisResolveAgentPath(undefined, { ...base, env: {}, platform: 'win32' }),
			paradisResolveAgentPath(undefined, { ...base, env: {} }),
		], ['/tmp/agent.sock', undefined, '/tmp/agent.sock', '/tmp/other.sock', '/home/me/.1password/agent.sock', '\\\\.\\pipe\\openssh-ssh-agent', undefined]);
	});
});
