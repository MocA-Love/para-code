/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ok, strictEqual } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { inlineParadisMarkdownMedia, resolveParadisMediaUri } from '../../browser/paradisMarkdownInlineResources.js';

suite('paradisMarkdownInlineResources', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const DOC = URI.from({ scheme: Schemas.file, path: '/repo/docs/readme.md' });
	const FOLDER = URI.from({ scheme: Schemas.file, path: '/repo' });
	// 1x1 の透明 GIF。中身は問わないが、base64 の往復がそのまま確かめられる大きさにしておく。
	const GIF = VSBuffer.fromString('GIF89a-tiny');

	/**
	 * 読み込みの回数を数え、必要なら途中で止められる provider。挙動は素のものと同じ。
	 * 「同時に何本走ったか」を見るために、止めている間の本数を数える。
	 */
	class CountingFileSystemProvider extends InMemoryFileSystemProvider {
		reads = 0;
		inFlight = 0;
		private _gate: Promise<void> | undefined;
		private _open: (() => void) | undefined;
		private _started: (() => void) | undefined;
		private _startedTarget = 0;

		/** これ以降の読み込みを `releaseReads()` まで待たせる。 */
		blockReads(): void {
			this._gate = new Promise<void>(resolve => { this._open = resolve; });
		}

		releaseReads(): void {
			this._open?.();
			this._gate = undefined;
			this._open = undefined;
		}

		/** `count` 本の読み込みが同時に始まるまで待つ。 */
		whenReadsStarted(count: number): Promise<void> {
			if (this.inFlight >= count) {
				return Promise.resolve();
			}
			this._startedTarget = count;
			return new Promise<void>(resolve => { this._started = resolve; });
		}

		override async readFile(resource: URI): Promise<Uint8Array> {
			this.reads++;
			this.inFlight++;
			if (this._startedTarget > 0 && this.inFlight >= this._startedTarget) {
				this._started?.();
				this._started = undefined;
				this._startedTarget = 0;
			}
			try {
				await this._gate;
				return await super.readFile(resource);
			} finally {
				this.inFlight--;
			}
		}
	}

	async function createFileService(disposables: DisposableStore, files: ReadonlyArray<[string, VSBuffer]>): Promise<{ fileService: FileService; provider: CountingFileSystemProvider }> {
		const fileService = disposables.add(new FileService(new NullLogService()));
		const provider = disposables.add(new CountingFileSystemProvider());
		disposables.add(fileService.registerProvider(Schemas.file, provider));
		for (const [path, contents] of files) {
			const uri = URI.from({ scheme: Schemas.file, path });
			await fileService.createFolder(uri.with({ path: uri.path.replace(/\/[^/]+$/, '') }));
			await fileService.writeFile(uri, contents);
		}
		provider.reads = 0;
		return { fileService, provider };
	}

	suite('resolveParadisMediaUri', () => {

		test('resolves relative paths against the document folder', () => {
			strictEqual(resolveParadisMediaUri('a.png', DOC, FOLDER)?.path, '/repo/docs/a.png');
			strictEqual(resolveParadisMediaUri('./img/a.png', DOC, FOLDER)?.path, '/repo/docs/img/a.png');
			strictEqual(resolveParadisMediaUri('../assets/a.png', DOC, FOLDER)?.path, '/repo/assets/a.png');
		});

		test('resolves root-relative paths against the workspace folder', () => {
			strictEqual(resolveParadisMediaUri('/assets/a.png', DOC, FOLDER)?.path, '/repo/assets/a.png');
			strictEqual(resolveParadisMediaUri('/assets/a.png', DOC, undefined), undefined);
		});

		test('drops the query and fragment, and decodes escapes', () => {
			strictEqual(resolveParadisMediaUri('my%20image.png?raw=true', DOC, FOLDER)?.path, '/repo/docs/my image.png');
			strictEqual(resolveParadisMediaUri('a.png#frag', DOC, FOLDER)?.path, '/repo/docs/a.png');
		});

		test('keeps absolute file uris and refuses other schemes', () => {
			strictEqual(resolveParadisMediaUri('file:///elsewhere/a.png', DOC, FOLDER)?.path, '/elsewhere/a.png');
			strictEqual(resolveParadisMediaUri('mailto:someone@example.com', DOC, FOLDER), undefined);
		});
	});

	suite('inlineParadisMarkdownMedia', () => {

		test('inlines a relative image as a data uri', async () => {
			const disposables = store.add(new DisposableStore());
			const { fileService } = await createFileService(disposables, [['/repo/docs/a.png', GIF]]);

			const result = await inlineParadisMarkdownMedia(
				'<p><img src="./a.png" alt="figure"></p>', DOC, FOLDER, fileService, CancellationToken.None);

			strictEqual(result.inlined, 1);
			strictEqual(result.skipped, 0);
			ok(result.html.includes('src="data:image/png;base64,'), result.html);
			ok(result.html.includes('alt="figure"'), result.html);
		});

		test('leaves remote and already inlined sources untouched', async () => {
			const disposables = store.add(new DisposableStore());
			const { fileService } = await createFileService(disposables, []);

			const html = '<img src="https://example.com/a.png"><img src="data:image/gif;base64,AA">';
			const result = await inlineParadisMarkdownMedia(html, DOC, FOLDER, fileService, CancellationToken.None);

			strictEqual(result.inlined, 0);
			strictEqual(result.skipped, 0);
			ok(result.html.includes('https://example.com/a.png'), result.html);
			ok(result.html.includes('data:image/gif;base64,AA'), result.html);
		});

		test('replaces a missing image with a note instead of a broken icon', async () => {
			const disposables = store.add(new DisposableStore());
			const { fileService } = await createFileService(disposables, []);

			const result = await inlineParadisMarkdownMedia(
				'<p><img src="gone.png"></p>', DOC, FOLDER, fileService, CancellationToken.None);

			strictEqual(result.inlined, 0);
			strictEqual(result.skipped, 1);
			ok(!result.html.includes('<img'), result.html);
			ok(result.html.includes('paradis-media-unavailable'), result.html);
			ok(result.html.includes('gone.png'), result.html);
		});

		test('skips files over the per-file budget', async () => {
			const disposables = store.add(new DisposableStore());
			const { fileService } = await createFileService(disposables, [['/repo/docs/big.png', VSBuffer.fromString('0123456789')]]);

			const result = await inlineParadisMarkdownMedia(
				'<img src="big.png">', DOC, FOLDER, fileService, CancellationToken.None,
				{ maxBytesPerFile: 4, maxBytesTotal: 1024 });

			strictEqual(result.inlined, 0);
			strictEqual(result.skipped, 1);
			ok(result.html.includes('paradis-media-unavailable'), result.html);
		});

		test('stops inlining once the document budget is used up', async () => {
			const disposables = store.add(new DisposableStore());
			const { fileService } = await createFileService(disposables, [
				['/repo/docs/a.png', VSBuffer.fromString('aaaaaaaaaa')],
				['/repo/docs/b.png', VSBuffer.fromString('bbbbbbbbbb')],
			]);

			// 予算は「埋め込んだ文字列の長さ」で数える。10バイトの画像は
			// `data:image/png;base64,` (22) + base64 (16) = 38 文字になるので、1枚は通り2枚は通らない値にする。
			const result = await inlineParadisMarkdownMedia(
				'<img src="a.png"><img src="b.png">', DOC, FOLDER, fileService, CancellationToken.None,
				{ maxBytesPerFile: 1024, maxBytesTotal: 50 });

			strictEqual(result.inlined, 1);
			strictEqual(result.skipped, 1);
		});

		test('reads the images at the same time instead of one after another', async () => {
			// 遠いファイルシステムでは、読み込みが直列だと枚数だけ往復が積み上がる。
			const disposables = store.add(new DisposableStore());
			const files: [string, VSBuffer][] = [];
			for (let index = 0; index < 6; index++) {
				files.push([`/repo/docs/img${index}.png`, GIF]);
			}
			const { fileService, provider } = await createFileService(disposables, files);
			provider.blockReads();

			const html = files.map((_, index) => `<img src="img${index}.png">`).join('');
			const pending = inlineParadisMarkdownMedia(html, DOC, FOLDER, fileService, CancellationToken.None);

			await provider.whenReadsStarted(6);
			strictEqual(provider.inFlight, 6);
			provider.releaseReads();

			strictEqual((await pending).inlined, 6);
		});

		test('reads a repeated image only once', async () => {
			const disposables = store.add(new DisposableStore());
			const { fileService, provider } = await createFileService(disposables, [['/repo/docs/a.png', GIF]]);

			const result = await inlineParadisMarkdownMedia(
				'<img src="a.png"><img src="./a.png">', DOC, FOLDER, fileService, CancellationToken.None);

			strictEqual(result.inlined, 2);
			strictEqual(provider.reads, 1);
		});
	});
});
