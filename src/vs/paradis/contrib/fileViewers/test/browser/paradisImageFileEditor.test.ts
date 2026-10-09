/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { Dimension } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { decodeBase64 } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { FileOperationError, FileOperationResult, IFileContent, IFileService, IReadFileOptions } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IStatusbarEntry, IStatusbarService } from '../../../../../workbench/services/statusbar/browser/statusbar.js';
import { ITextFileService } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { TestEditorGroupView } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { IParadisViewerOpenTiming, ParadisViewerOpenCounter, startParadisViewerOpenTiming } from '../../common/paradisViewerOpenTiming.js';
import { ParadisImageFileEditor } from '../../browser/image/paradisImageFileEditor.js';
import { ParadisImageInput } from '../../browser/image/paradisImageInput.js';

/** A 1x1 PNG. */
const PNG = decodeBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');

type Recorded = Record<string, number | string | boolean>;

class TestImageEditor extends ParadisImageFileEditor {
	readonly recorded: Recorded[] = [];
	private readonly _counter = new ParadisViewerOpenCounter();
	protected override _startOpenTiming(): IParadisViewerOpenTiming {
		return startParadisViewerOpenTiming('image', { recorder: attributes => this.recorded.push({ ...attributes, safe_paint_ms: 0 }), counter: this._counter });
	}
}

suite('ParadisImageFileEditor', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function until(condition: () => boolean, label: string): Promise<void> {
		for (let i = 0; i < 300 && !condition(); i++) {
			await timeout(10);
		}
		if (!condition()) {
			throw new Error(`timed out waiting for ${label}`);
		}
	}

	test('paints images once per open, does not reread or remeasure when coming back to the same tab, and shows the status bar entries', async () => {
		const parent = mainWindow.document.createElement('div');
		parent.style.cssText = 'position: fixed; left: 0; top: 0; width: 640px; height: 320px;';
		mainWindow.document.body.appendChild(parent);
		store.add(toDisposable(() => parent.remove()));

		const reads: { path: string; etag: string | undefined }[] = [];
		const fileService = {
			readFile: async (resource: URI, options?: IReadFileOptions): Promise<IFileContent> => {
				reads.push({ path: resource.path, etag: options?.etag });
				if (options?.etag === `etag:${resource.path}`) {
					throw new FileOperationError('not modified', FileOperationResult.FILE_NOT_MODIFIED_SINCE);
				}
				return { resource, name: 'x.png', value: PNG, size: PNG.byteLength, etag: `etag:${resource.path}`, mtime: 1, ctime: 1, readonly: false, locked: false, executable: false };
			},
			createWatcher: () => ({ onDidChange: Event.None, dispose: () => { } }),
		} as unknown as IFileService;
		const status = new Map<string, string>();
		const statusbarService = {
			addEntry: (entry: IStatusbarEntry, id: string) => {
				status.set(id, entry.text);
				return { update: (next: IStatusbarEntry) => status.set(id, next.text), dispose: () => status.delete(id) };
			},
		} as unknown as IStatusbarService;
		const active: { pane?: TestImageEditor } = {};
		const editorService = { get activeEditorPane() { return active.pane; }, onDidActiveEditorChange: Event.None } as unknown as IEditorService;
		const editor = active.pane = store.add(new TestImageEditor(
			new TestEditorGroupView(1),
			NullTelemetryService,
			new TestThemeService(),
			store.add(new TestStorageService()),
			fileService,
			editorService,
			statusbarService,
			{} as IContextMenuService,
			new NullLogService(),
		));
		editor.create(parent);
		editor.setVisible(true);
		editor.layout(new Dimension(640, 320));

		const textFileService = { isDirty: () => false } as unknown as ITextFileService;
		const workingCopyService = { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService;
		const first = store.add(new ParadisImageInput(URI.file('/w/a.png'), textFileService, workingCopyService));
		const second = store.add(new ParadisImageInput(URI.file('/w/b.png'), textFileService, workingCopyService));
		const image = () => parent.querySelector<HTMLImageElement>('.paradis-image-viewer.ready img');

		await editor.setInput(first, undefined, Object.create(null), CancellationToken.None);
		await until(() => editor.recorded.length === 1, 'first paint');
		const firstImage = image();
		const firstStatus = Object.fromEntries(status);

		editor.zoomIn();
		const zoomed = status.get('status.paradis.imagePreview.zoom');

		// Switch away and back to the same tab: the image element stays, nothing is reread or measured.
		editor.clearInput();
		await editor.setInput(first, undefined, Object.create(null), CancellationToken.None);
		await until(() => reads.length === 2, 'revalidation');
		await timeout(50);
		const sameElement = image() === firstImage;

		await editor.setInput(second, undefined, Object.create(null), CancellationToken.None);
		await until(() => editor.recorded.length === 2, 'second paint');

		deepStrictEqual({
			recorded: editor.recorded,
			reads,
			firstStatus,
			zoomed,
			sameElement,
			blobUrl: firstImage?.src.startsWith('blob:'),
		}, {
			recorded: [
				{ safe_size_kb: 0, safe_width_px: 1, safe_height_px: 1, safe_from_cache: false, safe_viewer: 'image', safe_open_ordinal: 1, safe_paint_ms: 0 },
				{ safe_size_kb: 0, safe_width_px: 1, safe_height_px: 1, safe_from_cache: false, safe_viewer: 'image', safe_open_ordinal: 2, safe_paint_ms: 0 },
			],
			reads: [
				{ path: '/w/a.png', etag: undefined },
				{ path: '/w/a.png', etag: 'etag:/w/a.png' },
				{ path: '/w/b.png', etag: undefined },
			],
			firstStatus: {
				// allow-any-unicode-next-line
				'status.paradis.imagePreview.zoom': '画像全体',
				'status.paradis.imagePreview.size': '1x1',
				'status.paradis.imagePreview.binarySize': `${PNG.byteLength}B`,
			},
			zoomed: '150%',
			sameElement: true,
			blobUrl: true,
		});
	});
});
