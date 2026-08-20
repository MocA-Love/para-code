/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileChangesEvent, FileChangeType, IFileStatWithPartialMetadata, IFileStreamContent, IFileSystemWatcher, IReadFileStreamOptions, IWatchOptionsWithCorrelation } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { BrowserWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/browser/environmentService.js';
import { TestFileService, TestProductService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { TestSharedProcessService } from '../../../../../workbench/test/electron-browser/workbenchTestServices.js';
import { ParadisRemoteTranscriptMirror, registerParadisRemoteTranscriptMirrorContribution } from '../../electron-browser/paradisRemoteTranscriptMirror.contribution.js';

const REMOTE_AUTHORITY = 'ssh-remote+transcript-test';
const REMOTE_PATH = '/home/test/.codex/sessions/2026/08/13/session.jsonl';
const READ_CHUNK_BYTES = 512 * 1024;

function remoteTranscriptUri(): URI {
	return URI.from({ scheme: 'vscode-remote', authority: REMOTE_AUTHORITY, path: REMOTE_PATH });
}

interface IReadCall {
	readonly position: number;
	readonly length: number;
}

interface IRelayCall {
	readonly command: string;
	readonly ownerId: string;
	readonly remotePath?: string;
	readonly data?: VSBuffer;
}

class TranscriptFileService extends TestFileService {
	private data = VSBuffer.alloc(0);
	private shortReadBytes: number | undefined;
	readonly rangeReads: IReadCall[] = [];
	watchDisposals = 0;

	setTranscript(data: VSBuffer): void {
		this.data = data;
	}

	setShortReadBytes(bytes: number | undefined): void {
		this.shortReadBytes = bytes;
	}

	override async stat(resource: URI): Promise<IFileStatWithPartialMetadata> {
		return { ...await super.stat(resource), size: this.data.byteLength };
	}

	// 写しは readFileStream で読む（readFile だと接続先で範囲読みにならず、追記のたびに
	// transcript 全体が SSH を流れる）。ここも同じ入口を模して範囲読みを記録する。
	override async readFileStream(resource: URI, options?: IReadFileStreamOptions): Promise<IFileStreamContent> {
		const position = options?.position ?? 0;
		const requestedLength = options?.length ?? this.data.byteLength - position;
		const returnedLength = Math.min(requestedLength, this.shortReadBytes ?? requestedLength);
		this.rangeReads.push({ position, length: requestedLength });
		return {
			...await super.readFileStream(resource, options),
			value: bufferToStream(this.data.slice(position, position + returnedLength)),
		};
	}

	override watch(resource: URI, options: IWatchOptionsWithCorrelation): IFileSystemWatcher;
	override watch(resource: URI): IDisposable;
	override watch(resource: URI, options?: IWatchOptionsWithCorrelation): IFileSystemWatcher | IDisposable {
		const watcher = options ? super.watch(resource, options) : super.watch(resource);
		return {
			...watcher,
			dispose: () => {
				this.watchDisposals++;
				watcher.dispose();
			},
		};
	}
}

class TranscriptRelayChannel implements IChannel {
	readonly calls: IRelayCall[] = [];
	wanted: readonly string[] = [REMOTE_PATH];
	beginOffset = 0;
	resetOffset = 0;
	appendUnavailable = false;
	private offset = 0;
	private beginPromise: Promise<number> | undefined;
	private resolveBeginPromise: ((offset: number) => void) | undefined;

	deferBegin(): void {
		this.beginPromise = new Promise<number>(resolve => this.resolveBeginPromise = resolve);
	}

	resolveBegin(offset: number): void {
		this.resolveBeginPromise?.(offset);
		this.resolveBeginPromise = undefined;
	}

	call<T>(command: string, arg?: unknown): Promise<T> {
		const parameters = Array.isArray(arg) ? arg : [];
		const ownerId = typeof parameters[0] === 'string' ? parameters[0] : '';
		const remotePath = typeof parameters[1] === 'string' ? parameters[1] : undefined;
		const data = parameters[2] instanceof VSBuffer ? parameters[2] : undefined;
		this.calls.push({ command, ownerId, remotePath, data });

		switch (command) {
			case 'listRemoteTranscriptMirrors':
				return Promise.resolve(this.wanted) as Promise<T>;
			case 'beginRemoteTranscriptMirror':
				return (this.beginPromise ?? Promise.resolve(this.beginOffset)).then(offset => {
					this.offset = offset;
					return offset;
				}) as Promise<T>;
			case 'appendRemoteTranscriptMirror':
				this.offset += data?.byteLength ?? 0;
				return Promise.resolve(this.appendUnavailable ? -1 : this.offset) as Promise<T>;
			case 'resetRemoteTranscriptMirror':
				this.offset = this.resetOffset;
				return Promise.resolve(this.resetOffset) as Promise<T>;
			case 'releaseRemoteTranscriptMirrors':
				return Promise.resolve(undefined) as Promise<T>;
			default:
				throw new Error(`Unexpected relay command: ${command}`);
		}
	}

	listen<T>(): Event<T> {
		return Event.None;
	}
}

class TranscriptSharedProcessService extends TestSharedProcessService {
	constructor(private readonly channel: IChannel) {
		super();
	}

	override getChannel(channelName: string): IChannel {
		assert.strictEqual(channelName, 'paradisMobileRelay');
		return this.channel;
	}
}

async function waitUntil(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
	const startedAt = Date.now();
	while (!condition()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error('waitUntil timed out');
		}
		await new Promise<void>(resolve => setTimeout(resolve, 1));
	}
}

suite('ParadisRemoteTranscriptMirror contribution', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const contributionId = 'paradis.remoteTranscriptMirror';

	function createMirror(fileService: TranscriptFileService, channel: TranscriptRelayChannel): ParadisRemoteTranscriptMirror {
		const environmentService = new BrowserWorkbenchEnvironmentService(
			'transcript-test',
			URI.file('/logs'),
			{ remoteAuthority: REMOTE_AUTHORITY },
			TestProductService,
		);
		return store.add(new ParadisRemoteTranscriptMirror(
			environmentService,
			fileService,
			new TranscriptSharedProcessService(channel),
			new NullLogService(),
		));
	}

	test('exposes the registration contract used by the desktop aggregate entrypoint', () => {
		const registrations: Array<{ id: string; ctor: typeof ParadisRemoteTranscriptMirror; phase: WorkbenchPhase }> = [];
		registerParadisRemoteTranscriptMirrorContribution((id, ctor, phase) => registrations.push({ id, ctor, phase }));

		assert.deepStrictEqual(registrations, [{
			id: contributionId,
			ctor: ParadisRemoteTranscriptMirror,
			phase: WorkbenchPhase.AfterRestored,
		}]);
	});

	test('reads from the ledger offset in bounded chunks', async () => {
		const fileService = new TranscriptFileService();
		const channel = new TranscriptRelayChannel();
		channel.beginOffset = 2;
		fileService.setTranscript(VSBuffer.alloc(READ_CHUNK_BYTES + 3));

		createMirror(fileService, channel);
		await waitUntil(() => channel.calls.filter(call => call.command === 'appendRemoteTranscriptMirror').length === 2);

		assert.deepStrictEqual(fileService.rangeReads, [
			{ position: 2, length: READ_CHUNK_BYTES },
			{ position: READ_CHUNK_BYTES + 2, length: 1 },
		]);
	});

	test('continues immediately after a short read without skipping bytes', async () => {
		const fileService = new TranscriptFileService();
		const channel = new TranscriptRelayChannel();
		channel.beginOffset = 3;
		fileService.setTranscript(VSBuffer.fromString('abcdefghij'));
		fileService.setShortReadBytes(2);

		createMirror(fileService, channel);
		await waitUntil(() => channel.calls.filter(call => call.command === 'appendRemoteTranscriptMirror').length === 4);

		assert.deepStrictEqual({
			reads: fileService.rangeReads,
			appended: channel.calls
				.filter(call => call.command === 'appendRemoteTranscriptMirror')
				.map(call => call.data?.toString()),
		}, {
			reads: [
				{ position: 3, length: 7 },
				{ position: 5, length: 5 },
				{ position: 7, length: 3 },
				{ position: 9, length: 1 },
			],
			appended: ['de', 'fg', 'hi', 'j'],
		});
	});

	test('resets the local mirror before reading a truncated remote transcript', async () => {
		const fileService = new TranscriptFileService();
		const channel = new TranscriptRelayChannel();
		channel.beginOffset = 8;
		fileService.setTranscript(VSBuffer.fromString('new'));

		createMirror(fileService, channel);
		await waitUntil(() => channel.calls.some(call => call.command === 'appendRemoteTranscriptMirror'));

		assert.deepStrictEqual({
			commands: channel.calls.map(call => call.command),
			reads: fileService.rangeReads,
			appended: channel.calls.find(call => call.command === 'appendRemoteTranscriptMirror')?.data?.toString(),
		}, {
			commands: [
				'listRemoteTranscriptMirrors',
				'beginRemoteTranscriptMirror',
				'resetRemoteTranscriptMirror',
				'appendRemoteTranscriptMirror',
			],
			reads: [{ position: 0, length: 3 }],
			appended: 'new',
		});
	});

	test('stops watching when reset reports that ownership was lost', async () => {
		const fileService = new TranscriptFileService();
		const channel = new TranscriptRelayChannel();
		channel.beginOffset = 8;
		channel.resetOffset = -1;
		fileService.setTranscript(VSBuffer.fromString('new'));

		createMirror(fileService, channel);
		await waitUntil(() => fileService.watchDisposals === 1);
		fileService.fireFileChanges(new FileChangesEvent([{
			resource: remoteTranscriptUri(),
			type: FileChangeType.UPDATED,
		}], false));
		await new Promise<void>(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual({
			commands: channel.calls.map(call => call.command),
			watches: fileService.watches.length,
			reads: fileService.rangeReads.length,
		}, {
			commands: [
				'listRemoteTranscriptMirrors',
				'beginRemoteTranscriptMirror',
				'resetRemoteTranscriptMirror',
			],
			watches: 0,
			reads: 0,
		});
	});

	test('does not watch or read a transcript owned by another renderer', async () => {
		const fileService = new TranscriptFileService();
		const channel = new TranscriptRelayChannel();
		channel.beginOffset = -1;
		fileService.setTranscript(VSBuffer.fromString('unavailable'));

		createMirror(fileService, channel);
		await waitUntil(() => channel.calls.some(call => call.command === 'beginRemoteTranscriptMirror'));
		await new Promise<void>(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual({
			watches: fileService.watches.length,
			reads: fileService.rangeReads.length,
			appends: channel.calls.filter(call => call.command === 'appendRemoteTranscriptMirror').length,
		}, { watches: 0, reads: 0, appends: 0 });
	});

	test('stops watching when append reports that ownership was lost', async () => {
		const fileService = new TranscriptFileService();
		const channel = new TranscriptRelayChannel();
		channel.appendUnavailable = true;
		fileService.setTranscript(VSBuffer.fromString('lost'));

		createMirror(fileService, channel);
		await waitUntil(() => fileService.watchDisposals === 1);
		fileService.fireFileChanges(new FileChangesEvent([{
			resource: remoteTranscriptUri(),
			type: FileChangeType.UPDATED,
		}], false));
		await new Promise<void>(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual({
			watches: fileService.watches.length,
			reads: fileService.rangeReads.length,
		}, { watches: 0, reads: 1 });
	});

	test('appends immediately when an UPDATED event arrives after initial follow', async () => {
		const fileService = new TranscriptFileService();
		const channel = new TranscriptRelayChannel();
		fileService.setTranscript(VSBuffer.alloc(0));
		createMirror(fileService, channel);
		await waitUntil(() => fileService.watches.length === 1);
		await new Promise<void>(resolve => setTimeout(resolve, 0));

		fileService.setTranscript(VSBuffer.fromString('later'));
		fileService.fireFileChanges(new FileChangesEvent([{
			resource: remoteTranscriptUri(),
			type: FileChangeType.UPDATED,
		}], false));
		await waitUntil(() => channel.calls.some(call => call.command === 'appendRemoteTranscriptMirror'), 500);

		assert.deepStrictEqual({
			reads: fileService.rangeReads,
			appended: channel.calls.find(call => call.command === 'appendRemoteTranscriptMirror')?.data?.toString(),
			watches: fileService.watches.length,
		}, {
			reads: [{ position: 0, length: 5 }],
			appended: 'later',
			watches: 1,
		});
	});

	test('stops unwanted transcripts and releases the same owner when disposed', async () => {
		const fileService = new TranscriptFileService();
		const channel = new TranscriptRelayChannel();
		fileService.setTranscript(VSBuffer.alloc(0));
		const mirror = createMirror(fileService, channel);
		await waitUntil(() => fileService.watches.length === 1);
		channel.wanted = [];
		await waitUntil(() => fileService.watchDisposals === 1);

		mirror.dispose();
		await waitUntil(() => channel.calls.some(call => call.command === 'releaseRemoteTranscriptMirrors'));
		const ownerIds = new Set(channel.calls.map(call => call.ownerId));
		assert.deepStrictEqual({
			watches: fileService.watches.length,
			watchDisposals: fileService.watchDisposals,
			ownerCount: ownerIds.size,
			released: channel.calls.at(-1)?.command,
		}, {
			watches: 0,
			watchDisposals: 1,
			ownerCount: 1,
			released: 'releaseRemoteTranscriptMirrors',
		});
	});

	test('releases ownership acquired after disposal while begin is pending', async () => {
		const fileService = new TranscriptFileService();
		const channel = new TranscriptRelayChannel();
		channel.deferBegin();
		fileService.setTranscript(VSBuffer.alloc(0));
		const mirror = createMirror(fileService, channel);
		await waitUntil(() => channel.calls.some(call => call.command === 'beginRemoteTranscriptMirror'));

		mirror.dispose();
		channel.resolveBegin(0);
		await waitUntil(() => channel.calls.filter(call => call.command === 'releaseRemoteTranscriptMirrors').length === 2);

		assert.deepStrictEqual({
			commands: channel.calls.map(call => call.command),
			watches: fileService.watches.length,
		}, {
			commands: [
				'listRemoteTranscriptMirrors',
				'beginRemoteTranscriptMirror',
				'releaseRemoteTranscriptMirrors',
				'releaseRemoteTranscriptMirrors',
			],
			watches: 0,
		});
	});
});
