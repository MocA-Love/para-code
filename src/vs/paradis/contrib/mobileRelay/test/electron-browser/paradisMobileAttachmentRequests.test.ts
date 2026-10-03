/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import {
	ParadisMobileThumbnailCache,
	paradisIsMobileAttachmentName,
	paradisMobileAttachmentThumbSize,
	paradisReadImageDimensions,
	paradisResolveMobileAttachment,
	paradisSniffImageMediaType,
} from '../../common/paradisMobileAttachment.js';
import { paradisCreateMobileUploadTarget } from '../../common/paradisMobileWorkspacePath.js';
import { paradisCreateMobileAttachmentThumbnail } from '../../electron-browser/paradisMobileAttachmentRequests.js';
import { IParadisMobileRequestHost, paradisDispatchMobileRequest } from '../../electron-browser/paradisMobileRequestHandlers.js';

const USER_DATA = URI.file('/data/User');
const UPLOADS = URI.file('/data/User/paraMobileUploads');
const NAME = 'attachment-1759500000000-abc123.jpg';

interface IFakeFileOptions {
	/** 読むと例外になるファイル。 */
	readonly failRead?: readonly string[];
	/** realpath が壊れた値を返す（想定していない例外を起こす）ファイル。 */
	readonly brokenRealpath?: readonly string[];
	/** 読んでいる間に起きること（差し替えの再現）。 */
	readonly onRead?: (path: string, mtimes: Record<string, number>) => void;
	/** 読み終わるまで待たせる（列が詰まった状態の再現）。 */
	readonly readGate?: Promise<void>;
}

/**
 * realpath・stat・readFile だけを持つ fileService の代わり。`links` はシンボリックリンク（元 → 実体）、
 * `files` は実在するファイルと大きさ。更新時刻は `mtimes`（既定 0）。読むと中身は 7 バイトの JPEG の頭。
 */
function fakeFileService(files: Record<string, number>, links: Record<string, string> = {}, directories: readonly string[] = [UPLOADS.path], options: IFakeFileOptions = {}) {
	const reads: string[] = [];
	const mtimes: Record<string, number> = {};
	const service = {
		async realpath(resource: URI) {
			const target = links[resource.path] ?? resource.path;
			if (options.brokenRealpath?.includes(target)) {
				return {} as URI;
			}
			return files[target] !== undefined || directories.includes(target) ? URI.file(target) : undefined;
		},
		async stat(resource: URI) {
			const size = files[resource.path];
			if (size === undefined) {
				throw new Error('ENOENT');
			}
			return { resource, name: resource.path, isFile: true, isDirectory: false, isSymbolicLink: false, size, mtime: mtimes[resource.path] ?? 0, ctime: 0, etag: '', readonly: false, locked: false, executable: false };
		},
		async readFile(resource: URI) {
			reads.push(resource.path);
			if (options.failRead?.includes(resource.path)) {
				throw new Error(`EACCES: ${resource.path}`);
			}
			options.onRead?.(resource.path, mtimes);
			await options.readGate;
			return { resource, value: VSBuffer.wrap(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])), name: '', size: 7, mtime: 0, ctime: 0, etag: '', readonly: false, locked: false, executable: false };
		},
	};
	return { service, reads };
}

/** fs の attachment を登録表へ流し、要求の数だけ応答がそろうまで待つ。`onReply` は応答が届くたびに呼ぶ。 */
function dispatchAttachments(service: object, requests: readonly Record<string, unknown>[], onReply?: (reply: Record<string, unknown>) => void): Promise<Record<string, unknown>[]> {
	const services = new Map<unknown, unknown>([
		[IFileService, service],
		[IEnvironmentService, { userRoamingDataHome: USER_DATA }],
		[IRemoteAgentService, { getConnection: () => null, getEnvironment: async () => null }],
	]);
	return new Promise(resolve => {
		const replies: Record<string, unknown>[] = [];
		const host: IParadisMobileRequestHost = {
			invokeFunction: fn => fn({ get: (id: unknown) => services.get(id) } as ServicesAccessor),
			resolveRoot: () => undefined,
			runGit: async () => ({ code: 0, stdout: '', stderr: '' }),
			resolvePath: async () => undefined,
			getMobileCapabilities: async () => undefined,
			getMobileWireVersion: async () => 3,
			send: (_channel, _mobileId, payload) => {
				const reply = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
				replies.push(reply);
				onReply?.(reply);
				if (replies.length === requests.length) {
					resolve(replies.sort((a, b) => String(a.id).localeCompare(String(b.id))));
				}
			},
		};
		for (const body of requests) {
			paradisDispatchMobileRequest('fs', { t: 'attachment', ...body }, 'phone', host);
		}
	});
}

suite('ParadisMobileAttachment', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('アップロードが作る名前だけを通す', () => {
		const made = paradisCreateMobileUploadTarget(USER_DATA, 'IMG_0001.HEIC', 1759500000000, 'k3x9q2');
		assert.deepStrictEqual({
			made: made.path,
			accepted: [NAME, 'attachment-1759500000000-k3x9q2.HEIC', 'attachment-1759500000000-k3x9q2'].map(paradisIsMobileAttachmentName),
			rejected: [
				'../attachment-1759500000000-abc123.jpg',
				'attachment-1759500000000-abc123.jpg/../../secret',
				'attachment-1759500000000-abc123.jpg\0',
				'attachment-175950000000-abc123.jpg',
				'attachment-1759500000000-abc-123.jpg',
				'attachment-1759500000000-abc123.j.pg',
				'attachment-1759500000000-abc123.verylongext',
				'C:\\attachment-1759500000000-abc123.jpg',
				'/data/User/paraMobileUploads/attachment-1759500000000-abc123.jpg',
				'secret.txt',
				'',
				42,
				undefined,
			].map(paradisIsMobileAttachmentName),
		}, {
			made: '/data/User/paraMobileUploads/attachment-1759500000000-k3x9q2.HEIC',
			accepted: [true, true, true],
			rejected: Array(13).fill(false),
		});
	});

	test('置き場の直下の実体だけを返し、リンクで外へ出る・入れ子・無い・大きすぎるものは断る', async () => {
		const outside = 'attachment-1759500000001-out.png';
		const nested = 'attachment-1759500000002-nest.png';
		const big = 'attachment-1759500000003-big.png';
		const { service } = fakeFileService({
			[`${UPLOADS.path}/${NAME}`]: 1200,
			'/Users/me/.ssh/id_rsa': 400,
			[`${UPLOADS.path}/sub/${nested}`]: 10,
			[`${UPLOADS.path}/${big}`]: 30 * 1024 * 1024,
		}, {
			[`${UPLOADS.path}/${outside}`]: '/Users/me/.ssh/id_rsa',
			[`${UPLOADS.path}/${nested}`]: `${UPLOADS.path}/sub/${nested}`,
		});
		const results = await Promise.all([NAME, outside, nested, big, 'attachment-1759500000004-none.png', '../etc/passwd'].map(name => paradisResolveMobileAttachment(service, UPLOADS, name)));
		assert.deepStrictEqual(results.map(result => result.kind === 'ok' ? `ok ${result.uri.path} ${result.size}` : result.kind), [
			`ok ${UPLOADS.path}/${NAME} 1200`,
			'missing',
			'missing',
			'tooLarge',
			'missing',
			'invalid',
		]);
	});

	test('置き場そのものがリンクでも、実体の置き場の直下なら通す', async () => {
		const { service } = fakeFileService({ [`/real/uploads/${NAME}`]: 5 }, { [UPLOADS.path]: '/real/uploads', [`${UPLOADS.path}/${NAME}`]: `/real/uploads/${NAME}` }, ['/real/uploads']);
		const result = await paradisResolveMobileAttachment(service, UPLOADS, NAME);
		assert.deepStrictEqual(result.kind === 'ok' ? result.uri.path : result.kind, `/real/uploads/${NAME}`);
	});

	test('種類と縦横はヘッダーから読み、サムネイルの縦横は長辺 512 に収める', () => {
		const png = new Uint8Array(24);
		png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		new DataView(png.buffer).setUint32(16, 4032);
		new DataView(png.buffer).setUint32(20, 3024);
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xd0, 0x0f, 0xc0, 0x03]);
		assert.deepStrictEqual({
			types: [paradisSniffImageMediaType(png), paradisSniffImageMediaType(jpeg), paradisSniffImageMediaType(new Uint8Array([1, 2, 3]))],
			dimensions: [paradisReadImageDimensions(png), paradisReadImageDimensions(jpeg), paradisReadImageDimensions(new Uint8Array([1, 2, 3]))],
			thumbs: [paradisMobileAttachmentThumbSize(4032, 3024), paradisMobileAttachmentThumbSize(1170, 2532), paradisMobileAttachmentThumbSize(300, 200)],
		}, {
			types: ['image/png', 'image/jpeg', undefined],
			dimensions: [{ width: 4032, height: 3024 }, { width: 4032, height: 3024 }, undefined],
			thumbs: [{ width: 512, height: 384 }, { width: 237, height: 512 }, { width: 300, height: 200 }],
		});
	});

	test('サムネイルは長辺 512 の JPEG になり、読めない・巨大な画像は作らない', async () => {
		const canvas = new OffscreenCanvas(1024, 256);
		const context = canvas.getContext('2d')!;
		context.fillStyle = '#336699';
		context.fillRect(0, 0, 1024, 256);
		const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
		const bomb = new Uint8Array(24);
		bomb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		new DataView(bomb.buffer).setUint32(16, 100_000);
		new DataView(bomb.buffer).setUint32(20, 100_000);
		const thumbnail = await paradisCreateMobileAttachmentThumbnail(png);
		assert.deepStrictEqual({
			type: thumbnail !== undefined ? paradisSniffImageMediaType(thumbnail) : undefined,
			size: thumbnail !== undefined ? paradisReadImageDimensions(thumbnail) : undefined,
			unreadable: await paradisCreateMobileAttachmentThumbnail(new Uint8Array([1, 2, 3])),
			bomb: await paradisCreateMobileAttachmentThumbnail(bomb),
		}, {
			type: 'image/jpeg',
			size: { width: 512, height: 128 },
			unreadable: undefined,
			bomb: undefined,
		});
	});

	test('fs の attachment: 名前で置き場から読み、外を指す名前は読まずに断る', async () => {
		const { service, reads } = fakeFileService({ [`${UPLOADS.path}/${NAME}`]: 7 });
		const replies = await dispatchAttachments(service, [
			{ id: 'a1', name: NAME, variant: 'full' },
			{ id: 'a2', name: '../../.ssh/id_rsa', variant: 'full' },
			{ id: 'a3', name: NAME, variant: 'huge' },
			{ id: 'a4', name: 'attachment-1759500000009-gone.png', variant: 'thumb' },
		]);
		assert.deepStrictEqual({ replies: replies.map(reply => ({ id: reply.id, t: reply.t, mediaType: reply.mediaType, size: reply.size, code: reply.code, failed: reply.error !== undefined })), reads }, {
			replies: [
				{ id: 'a1', t: 'attachment', mediaType: 'image/jpeg', size: 7, code: undefined, failed: false },
				{ id: 'a2', t: undefined, mediaType: undefined, size: undefined, code: undefined, failed: true },
				{ id: 'a3', t: undefined, mediaType: undefined, size: undefined, code: undefined, failed: true },
				{ id: 'a4', t: undefined, mediaType: undefined, size: undefined, code: 'missing', failed: true },
			],
			reads: [`${UPLOADS.path}/${NAME}`],
		});
	});

	test('fs の attachment: 読めない・読む間に差し替わったものは missing、想定外の失敗は other。応答にパスや例外の文を入れない', async () => {
		const unreadable = 'attachment-1759500000010-unread.jpg';
		const swapped = 'attachment-1759500000011-swap.jpg';
		const broken = 'attachment-1759500000012-broken.jpg';
		const { service } = fakeFileService({
			[`${UPLOADS.path}/${unreadable}`]: 7,
			[`${UPLOADS.path}/${swapped}`]: 7,
			[`${UPLOADS.path}/${broken}`]: 7,
		}, {}, [UPLOADS.path], {
			failRead: [`${UPLOADS.path}/${unreadable}`],
			brokenRealpath: [`${UPLOADS.path}/${broken}`],
			onRead: (path, mtimes) => { mtimes[path] = 1; },
		});
		const replies = await dispatchAttachments(service, [
			{ id: 'b1', name: unreadable, variant: 'full' },
			{ id: 'b2', name: swapped, variant: 'full' },
			{ id: 'b3', name: broken, variant: 'full' },
		]);
		assert.deepStrictEqual({
			codes: replies.map(reply => [reply.id, reply.code, reply.t]),
			leaks: replies.some(reply => /paraMobileUploads|EACCES|\/data\//.test(String(reply.error))),
		}, {
			codes: [['b1', 'missing', undefined], ['b2', 'missing', undefined], ['b3', 'other', undefined]],
			leaks: false,
		});
	});

	test('fs の attachment: サムネイルは読み込みから列の中で 1 本ずつ行い、列で待てるのは 8 件まで（超えた分は読まずに other）', async () => {
		const names = Array.from({ length: 11 }, (_, index) => `attachment-17595000001${String(index).padStart(2, '0')}-q${index}.jpg`);
		let release: () => void = () => { };
		const readGate = new Promise<void>(resolve => { release = resolve; });
		const { service, reads } = fakeFileService(Object.fromEntries(names.map(name => [`${UPLOADS.path}/${name}`, 7])), {}, [UPLOADS.path], { readGate });
		const early: string[] = [];
		let readsWhileBlocked = -1;
		const done = dispatchAttachments(service, names.map((name, index) => ({ id: `q${String(index).padStart(2, '0')}`, name, variant: 'thumb' })), reply => {
			early.push(String(reply.code));
			// 断られた 3 件が返りそろった時点で、読み込みは列の先頭の 1 件だけ（待っている要求は中身を抱えていない）
			if (early.length === 3) {
				readsWhileBlocked = reads.length;
				release();
			}
		});
		const replies = await done;
		assert.deepStrictEqual({
			early,
			readsWhileBlocked: readsWhileBlocked <= 1,
			codes: replies.map(reply => String(reply.code)).sort(),
			reads: reads.length,
		}, {
			early: ['other', 'other', 'other', 'no-thumbnail', 'no-thumbnail', 'no-thumbnail', 'no-thumbnail', 'no-thumbnail', 'no-thumbnail', 'no-thumbnail', 'no-thumbnail'],
			readsWhileBlocked: true,
			codes: [...Array(8).fill('no-thumbnail'), 'other', 'other', 'other'],
			reads: 8,
		});
	});

	test('サムネイルの控えは件数と合計バイトの上限で古い順に捨て、使ったものは残す', () => {
		const cache = new ParadisMobileThumbnailCache(3, 100);
		cache.set('a', new Uint8Array(30));
		cache.set('b', new Uint8Array(30));
		cache.set('c', new Uint8Array(30));
		cache.get('a');
		cache.set('d', new Uint8Array(30));
		const afterCount = ['a', 'b', 'c', 'd'].map(key => cache.get(key) !== undefined);
		cache.set('e', new Uint8Array(60));
		cache.set('huge', new Uint8Array(200));
		assert.deepStrictEqual({
			afterCount,
			afterBytes: ['a', 'c', 'd', 'e', 'huge'].map(key => cache.get(key) !== undefined),
			stats: cache.stats(),
			keyChangesWithMtime: ParadisMobileThumbnailCache.keyOf(UPLOADS, { uri: URI.file('/x'), size: 1, mtime: 1 }) !== ParadisMobileThumbnailCache.keyOf(UPLOADS, { uri: URI.file('/x'), size: 1, mtime: 2 }),
		}, {
			afterCount: [true, false, true, true],
			afterBytes: [false, false, true, true, false],
			stats: { count: 2, bytes: 90 },
			keyChangesWithMtime: true,
		});
	});
});
