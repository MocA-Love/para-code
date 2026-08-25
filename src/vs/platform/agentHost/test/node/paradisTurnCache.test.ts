/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FileService } from '../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentSession } from '../../common/agent.js';
import { MessageKind } from '../../common/state/protocol/channels-chat/state.js';
import { ParadisTurnCache, type IParadisTurnCacheKey, type IParadisTurnCacheStamp } from '../../node/paradisTurnCache.js';
import { SessionDataService } from '../../node/sessionDataService.js';
import type { Turn } from '../../common/state/sessionState.js';

/** `Turn`'s `resource` fields are the protocol `URI` (a plain string), never a `URI` class instance. */
function fakeTurn(id: string, resource: string): Turn {
	return {
		id,
		message: {
			text: 'hello',
			origin: { kind: MessageKind.User },
			attachments: [{ kind: 'resource' as const, resource }],
		},
		responseParts: [],
		usage: undefined,
		state: 'complete' as Turn['state'],
	} as unknown as Turn;
}

suite('ParadisTurnCache', () => {

	const disposables = new DisposableStore();
	const basePath = URI.from({ scheme: Schemas.inMemory, path: '/userData' });
	let fileService: FileService;
	let sessionDataService: SessionDataService;
	let cache: ParadisTurnCache;

	const routing = AgentSession.uri('claude', 'session-1');
	const key: IParadisTurnCacheKey = { id: 'sdk-session-1', routing: routing.toString() };
	const stamp: IParadisTurnCacheStamp = { size: 1234, mtimeMs: 1_700_000_000_000 };
	const attachmentResource = URI.file('/repo/src/file.ts').toString();

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		sessionDataService = new SessionDataService(basePath, fileService, new NullLogService());
		cache = new ParadisTurnCache('test-fmt-1', sessionDataService, fileService, new NullLogService());
	});

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('read misses when nothing was ever written', async () => {
		const result = await cache.read(routing, key, stamp);
		assert.strictEqual(result, undefined);
	});

	test('write then read returns the same turns', async () => {
		const turns = [fakeTurn('turn-1', attachmentResource)];
		cache.write(routing, key, stamp, turns);
		await cache.whenIdle();

		const result = await cache.read(routing, key, stamp);
		assert.ok(result);
		assert.strictEqual(result!.length, 1);
		assert.strictEqual(result![0].id, 'turn-1');
		// eslint-disable-next-line local/code-no-any-casts
		assert.strictEqual((result![0].message.attachments as any)[0].resource, attachmentResource);
	});

	test('read misses when the stamp size differs', async () => {
		cache.write(routing, key, stamp, [fakeTurn('turn-1', attachmentResource)]);
		await cache.whenIdle();

		const result = await cache.read(routing, key, { ...stamp, size: stamp.size + 1 });
		assert.strictEqual(result, undefined);
	});

	test('read misses when the stamp mtime differs', async () => {
		cache.write(routing, key, stamp, [fakeTurn('turn-1', attachmentResource)]);
		await cache.whenIdle();

		const result = await cache.read(routing, key, { ...stamp, mtimeMs: stamp.mtimeMs + 1 });
		assert.strictEqual(result, undefined);
	});

	test('read misses when the key id differs', async () => {
		cache.write(routing, key, stamp, [fakeTurn('turn-1', attachmentResource)]);
		await cache.whenIdle();

		const result = await cache.read(routing, { ...key, id: 'other-sdk-session' }, stamp);
		assert.strictEqual(result, undefined);
	});

	test('read misses when the routing differs (different cache directory)', async () => {
		cache.write(routing, key, stamp, [fakeTurn('turn-1', attachmentResource)]);
		await cache.whenIdle();

		const otherRouting = AgentSession.uri('claude', 'session-2');
		const result = await cache.read(otherRouting, key, stamp);
		assert.strictEqual(result, undefined);
	});

	test('read misses when two routings sanitize to the same cache directory but differ as keys', async () => {
		// `SessionDataService` sanitizes non-alphanumeric characters to `-`, so
		// `foo/bar` and `foo-bar` collide on disk. The key's `routing` string
		// (not just the directory) must still discriminate them.
		const routingA = AgentSession.uri('claude', 'foo/bar');
		const routingB = AgentSession.uri('claude', 'foo-bar');
		assert.strictEqual(
			sessionDataService.getSessionDataDir(routingA).toString(),
			sessionDataService.getSessionDataDir(routingB).toString(),
			'test premise: both routings must collide on disk'
		);

		const keyA: IParadisTurnCacheKey = { id: 'sdk-session-1', routing: routingA.toString() };
		const keyB: IParadisTurnCacheKey = { id: 'sdk-session-1', routing: routingB.toString() };
		cache.write(routingA, keyA, stamp, [fakeTurn('turn-a', attachmentResource)]);
		await cache.whenIdle();

		const result = await cache.read(routingB, keyB, stamp);
		assert.strictEqual(result, undefined);
	});

	test('read misses when the on-disk format version differs from the cache instance', async () => {
		cache.write(routing, key, stamp, [fakeTurn('turn-1', attachmentResource)]);
		await cache.whenIdle();

		const otherFormatCache = new ParadisTurnCache('test-fmt-2', sessionDataService, fileService, new NullLogService());
		const result = await otherFormatCache.read(routing, key, stamp);
		assert.strictEqual(result, undefined);
	});

	test('read misses (not throws) on corrupt JSON', async () => {
		const dir = sessionDataService.getSessionDataDir(routing);
		await fileService.createFolder(dir);
		await fileService.writeFile(URI.joinPath(dir, 'paradisTurns.json'), VSBuffer.fromString('{ not json'));

		const result = await cache.read(routing, key, stamp);
		assert.strictEqual(result, undefined);
	});

	test('read misses (not throws) when the schema version field is missing or wrong', async () => {
		const dir = sessionDataService.getSessionDataDir(routing);
		await fileService.createFolder(dir);
		await fileService.writeFile(URI.joinPath(dir, 'paradisTurns.json'), VSBuffer.fromString(JSON.stringify({
			v: 999, fmt: 'test-fmt-1', key, stamp, turns: [fakeTurn('turn-1', attachmentResource)],
		})));

		const result = await cache.read(routing, key, stamp);
		assert.strictEqual(result, undefined);
	});

	test('read misses (not throws) when turns is not an array', async () => {
		const dir = sessionDataService.getSessionDataDir(routing);
		await fileService.createFolder(dir);
		await fileService.writeFile(URI.joinPath(dir, 'paradisTurns.json'), VSBuffer.fromString(JSON.stringify({
			v: 1, fmt: 'test-fmt-1', key, stamp, turns: 'not-an-array',
		})));

		const result = await cache.read(routing, key, stamp);
		assert.strictEqual(result, undefined);
	});

	test('write silently skips entries whose transcript stamp exceeds the size limit', async () => {
		const hugeStamp: IParadisTurnCacheStamp = { size: 64 * 1024 * 1024, mtimeMs: stamp.mtimeMs };
		cache.write(routing, key, hugeStamp, [fakeTurn('turn-1', attachmentResource)]);
		await cache.whenIdle();

		const dir = sessionDataService.getSessionDataDir(routing);
		assert.strictEqual(await fileService.exists(URI.joinPath(dir, 'paradisTurns.json')), false);
	});

	test('write failures are swallowed: a subsequent write for the same routing still lands', async () => {
		// Force the first write to fail by writing to a path a folder currently
		// occupies, then let the queue continue to a normal write.
		const dir = sessionDataService.getSessionDataDir(routing);
		await fileService.createFolder(URI.joinPath(dir, 'paradisTurns.json'));

		cache.write(routing, key, stamp, [fakeTurn('turn-1', attachmentResource)]);
		await cache.whenIdle();
		// First write failed (target path is a directory) but must not throw
		// out of `whenIdle()`, and must not wedge the per-routing queue.
		assert.strictEqual(await cache.read(routing, key, stamp), undefined);

		await fileService.del(URI.joinPath(dir, 'paradisTurns.json'), { recursive: true });
		cache.write(routing, key, stamp, [fakeTurn('turn-2', attachmentResource)]);
		await cache.whenIdle();

		const result = await cache.read(routing, key, stamp);
		assert.ok(result);
		assert.strictEqual(result![0].id, 'turn-2');
	});

	test('later write for the same routing overwrites the earlier one', async () => {
		cache.write(routing, key, stamp, [fakeTurn('turn-1', attachmentResource)]);
		const laterStamp: IParadisTurnCacheStamp = { size: 5678, mtimeMs: stamp.mtimeMs + 1000 };
		cache.write(routing, key, laterStamp, [fakeTurn('turn-2', attachmentResource)]);
		await cache.whenIdle();

		const stale = await cache.read(routing, key, stamp);
		assert.strictEqual(stale, undefined);

		const fresh = await cache.read(routing, key, laterStamp);
		assert.ok(fresh);
		assert.strictEqual(fresh![0].id, 'turn-2');
	});
});
