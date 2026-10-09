/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileOperationError, FileOperationResult, IFileContent, IFileService, IReadFileOptions } from '../../../../../platform/files/common/files.js';
import {
	getParadisImageMimeType,
	getParadisImageWheelScale,
	getParadisImageZoomInScale,
	getParadisImageZoomOutScale,
	isParadisGitLfsPointer,
	loadParadisImage,
	ParadisImageCache,
	ParadisImageData,
} from '../../browser/image/paradisImagePreview.js';

suite('ParadisImagePreview', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('fixes the MIME type from the extension for every format the upstream image preview opens', () => {
		const names = ['a.jpg', 'a.JPE', 'a.jpeg', 'a.png', 'a.bmp', 'a.gif', 'a.ico', 'a.webp', 'a.avif', 'a.svg', 'a.html', 'a.png.txt'];
		deepStrictEqual(Object.fromEntries(names.map(name => [name, getParadisImageMimeType(URI.file(`/w/${name}`)) ?? null])), {
			'a.jpg': 'image/jpeg',
			'a.JPE': 'image/jpeg',
			'a.jpeg': 'image/jpeg',
			'a.png': 'image/png',
			'a.bmp': 'image/bmp',
			'a.gif': 'image/gif',
			'a.ico': 'image/x-icon',
			'a.webp': 'image/webp',
			'a.avif': 'image/avif',
			'a.svg': 'image/svg+xml',
			'a.html': null,
			'a.png.txt': null,
		});
	});

	test('steps and clamps the zoom like the upstream image preview', () => {
		deepStrictEqual({
			inFromFitRatio: getParadisImageZoomInScale(0.37),
			inFromOne: getParadisImageZoomInScale(1),
			inAtMax: getParadisImageZoomInScale(20),
			outFromOne: getParadisImageZoomOutScale(1),
			outFromBetween: getParadisImageZoomOutScale(1.2),
			outAtMin: getParadisImageZoomOutScale(0.1),
			wheelDown: getParadisImageWheelScale(1, 10),
			wheelUp: getParadisImageWheelScale(1, -10),
			wheelClampedHigh: getParadisImageWheelScale(20, -1),
			wheelClampedLow: getParadisImageWheelScale(0.1, 1),
		}, {
			inFromFitRatio: 0.4,
			inFromOne: 1.5,
			inAtMax: 20,
			outFromOne: 0.9,
			outFromBetween: 1,
			outAtMin: 0.1,
			wheelDown: 0.925,
			wheelUp: 1.075,
			wheelClampedHigh: 20,
			wheelClampedLow: 0.1,
		});
	});

	test('treats only small git: files that start with the LFS header as Git LFS pointers', () => {
		const pointer = VSBuffer.fromString('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n');
		const gitUri = URI.from({ scheme: 'git', path: '/w/a.png', query: '{"ref":"HEAD"}' });
		deepStrictEqual({
			gitPointer: isParadisGitLfsPointer(gitUri, pointer),
			filePointer: isParadisGitLfsPointer(URI.file('/w/a.png'), pointer),
			gitImage: isParadisGitLfsPointer(gitUri, VSBuffer.wrap(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))),
			gitEmpty: isParadisGitLfsPointer(gitUri, VSBuffer.alloc(0)),
			gitLarge: isParadisGitLfsPointer(gitUri, VSBuffer.fromString('version https://git-lfs.github.com/spec/v1' + ' '.repeat(2000))),
		}, { gitPointer: true, filePointer: false, gitImage: false, gitEmpty: false, gitLarge: false });
	});

	test('evicts the least recently used images over the byte budget and revokes their URLs', () => {
		const revoked: string[] = [];
		const cache = new ParadisImageCache(100, url => revoked.push(url));
		const entry = (name: string, size: number): ParadisImageData => ({ blob: new Blob([]), size, etag: name, url: `blob:${name}` });
		cache.set('a', entry('a', 30));
		cache.set('b', entry('b', 30));
		cache.set('c', entry('c', 30));
		cache.get('a');
		cache.set('d', entry('d', 30));
		cache.set('huge', entry('huge', 60));
		deepStrictEqual({
			revoked,
			kept: ['a', 'b', 'c', 'd', 'huge'].filter(key => cache.get(key)),
			ownsA: cache.owns('blob:a'),
			ownsHuge: cache.owns('blob:huge'),
			totalBytes: cache.totalBytes,
		}, { revoked: ['blob:b'], kept: ['a', 'c', 'd'], ownsA: true, ownsHuge: false, totalBytes: 90 });
	});

	test('reads a file once and only stats it again while the etag is unchanged', async () => {
		const reads: { resource: string; etag: string | undefined }[] = [];
		let etag = 'v1';
		const fileService: Pick<IFileService, 'readFile'> = {
			async readFile(resource: URI, options?: IReadFileOptions): Promise<IFileContent> {
				reads.push({ resource: resource.scheme, etag: options?.etag });
				if (options?.etag === etag) {
					throw new FileOperationError('not modified', FileOperationResult.FILE_NOT_MODIFIED_SINCE);
				}
				const value = VSBuffer.fromString('<svg xmlns="http://www.w3.org/2000/svg"/>');
				return { resource, name: 'a.svg', value, size: value.byteLength, etag, mtime: 1, ctime: 1, readonly: false, locked: false, executable: false };
			}
		};
		const revoked: string[] = [];
		const cache = new ParadisImageCache(1024 * 1024, url => revoked.push(url));
		let urls = 0;
		const createUrl = () => `blob:${++urls}`;
		const file = URI.file('/w/a.svg');
		const git = URI.from({ scheme: 'git', path: '/w/a.svg' });

		const first = await loadParadisImage(fileService, file, cache, CancellationToken.None, createUrl);
		const second = await loadParadisImage(fileService, file, cache, CancellationToken.None, createUrl);
		etag = 'v2';
		const changed = await loadParadisImage(fileService, file, cache, CancellationToken.None, createUrl);
		const fromGit = await loadParadisImage(fileService, git, cache, CancellationToken.None, createUrl);
		const fromGitAgain = await loadParadisImage(fileService, git, cache, CancellationToken.None, createUrl);

		const summary = (result: Awaited<ReturnType<typeof loadParadisImage>>) => result.kind === 'image'
			? { url: result.data.url, fromCache: result.fromCache, type: result.data.blob.type }
			: result;
		deepStrictEqual({
			results: [first, second, changed, fromGit, fromGitAgain].map(summary),
			reads,
			revoked,
			gitOwned: cache.owns('blob:3'),
		}, {
			results: [
				{ url: 'blob:1', fromCache: false, type: 'image/svg+xml' },
				{ url: 'blob:1', fromCache: true, type: 'image/svg+xml' },
				{ url: 'blob:2', fromCache: false, type: 'image/svg+xml' },
				{ url: 'blob:3', fromCache: false, type: 'image/svg+xml' },
				{ url: 'blob:4', fromCache: false, type: 'image/svg+xml' },
			],
			reads: [
				{ resource: 'file', etag: undefined },
				{ resource: 'file', etag: 'v1' },
				{ resource: 'file', etag: 'v1' },
				{ resource: 'git', etag: undefined },
				{ resource: 'git', etag: undefined },
			],
			revoked: ['blob:1'],
			gitOwned: false,
		});
	});

	test('reports Git LFS pointers instead of an image', async () => {
		const value = VSBuffer.fromString('version https://git-lfs.github.com/spec/v1\noid sha256:abc\n');
		const fileService: Pick<IFileService, 'readFile'> = {
			async readFile(resource: URI): Promise<IFileContent> {
				return { resource, name: 'a.png', value, size: value.byteLength, etag: 'e', mtime: 1, ctime: 1, readonly: true, locked: false, executable: false };
			}
		};
		const result = await loadParadisImage(fileService, URI.from({ scheme: 'git', path: '/w/a.png' }), new ParadisImageCache(), CancellationToken.None, () => 'blob:x');
		deepStrictEqual(result, { kind: 'gitLfs' });
	});
});
