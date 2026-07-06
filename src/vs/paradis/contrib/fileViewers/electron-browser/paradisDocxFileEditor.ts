/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word(.docx)ビューア。vendored docx-preview（media/docxpreview/、UMD 版）を webview 内で実行し、
// .docx 本体は asWebviewUri のリソース URL から fetch → ArrayBuffer → docx-preview の renderAsync で
// HTML にレンダリングする。docx-preview は zip 展開に jszip（同梱 UMD）をグローバル JSZip として参照する。
// ページ風スタイル（白背景・影・中央寄せ）は PDF ビューアの見た目に合わせている。docx に Raw モードは
// 無いためトグルは持たない。
//
// webview のライフサイクル（OverlayWebview + claim/release）は paradisPdfFileEditor.ts と同方式。

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../base/common/network.js';
import { dirname, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IOverlayWebview, IWebviewService, WebviewContentPurpose } from '../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ParadisDocxInput } from './paradisDocxInput.js';
import { PARADIS_DOCX_EDITOR_ID } from '../browser/paradisFileViewers.js';

/** vendored docx-preview / jszip 成果物の配置ディレクトリ（AppResourcePath）。 */
const DOCX_MEDIA_ROOT = 'vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview' as const;

export class ParadisDocxFileEditor extends EditorPane {

	static readonly ID = PARADIS_DOCX_EDITOR_ID;

	private _rootElement: HTMLElement | undefined;
	private _webviewContainer: HTMLElement | undefined;
	private _webview: IOverlayWebview | undefined;
	private _webviewClaimed = false;
	private _editorVisible = false;
	private _currentResource: URI | undefined;
	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
	) {
		super(PARADIS_DOCX_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._rootElement = dom.append(parent, dom.$('.paradis-docx-viewer'));
		this._rootElement.style.position = 'relative';
		this._rootElement.style.overflow = 'hidden';
		// overlay webview を重ねる位置合わせ用アンカー（paradisPdfFileEditor と同方式）。
		this._webviewContainer = dom.append(this._rootElement, dom.$('.paradis-docx-viewer-webview'));
		this._webviewContainer.style.position = 'absolute';
		this._webviewContainer.style.inset = '0';
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		const resource = (input as ParadisDocxInput).resource;
		this._currentResource = resource;

		const store = new DisposableStore();
		this._inputDisposables.value = store;

		// ディスク上の .docx が差し替わったら表示中なら再レンダリングする。
		try {
			const watcher = this._fileService.createWatcher(resource, { recursive: false, excludes: [] });
			store.add(watcher);
			store.add(watcher.onDidChange(e => {
				if (e.contains(resource) && isEqual(this._currentResource, resource) && this._webviewClaimed) {
					this._renderResource(resource);
				}
			}));
		} catch {
			// watcher が作れなくても表示は継続できる。
		}

		this._updateWebviewPlacement();
	}

	private _ensureWebview(resource: URI): IOverlayWebview {
		if (this._webview) {
			return this._webview;
		}
		const webview = this._webviewService.createWebviewOverlay({
			title: undefined,
			options: {
				purpose: WebviewContentPurpose.CustomEditor,
				enableFindWidget: false,
				tryRestoreScrollPosition: true
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: this._localResourceRoots(resource)
			},
			extension: undefined
		});
		this._webview = webview;
		this._register(webview);
		return webview;
	}

	private _localResourceRoots(resource: URI): URI[] {
		return [dirname(resource), FileAccess.asFileUri(DOCX_MEDIA_ROOT)];
	}

	private _renderResource(resource: URI): void {
		const webview = this._ensureWebview(resource);
		webview.contentOptions = {
			allowScripts: true,
			localResourceRoots: this._localResourceRoots(resource)
		};
		webview.setHtml(this._buildHtml(resource));
	}

	private _buildHtml(resource: URI): string {
		const nonce = generateUuid();
		const remoteInfo = resource.scheme === Schemas.vscodeRemote ? { isRemote: true, authority: resource.authority } : undefined;
		const docxUrl = asWebviewUri(resource, remoteInfo).toString(true);
		const libBase = asWebviewUri(FileAccess.asFileUri(DOCX_MEDIA_ROOT)).toString(true);

		// CSP: スクリプトは nonce 付き inline と webview リソース(https:)のみ。docx-preview が本文中に
		// 埋め込む style は要素インライン + 動的 <style> なので style-src に 'unsafe-inline' を許可する
		// （docx-preview は文書ごとに動的生成する CSS を nonce 無しの <style> で挿入するため）。img は
		// 埋め込み画像の blob:/data: を許可。connect-src は .docx 本体の fetch のため webview リソースを許可。
		return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https:; style-src 'nonce-${nonce}' 'unsafe-inline'; img-src blob: data: https:; font-src https: data: blob:; connect-src https: blob: data:;">
	<style nonce="${nonce}">
		html, body { margin: 0; padding: 0; height: 100%; }
		body {
			background-color: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
			font-family: var(--vscode-font-family);
			font-size: 13px;
		}
		#scroller { position: absolute; inset: 0; overflow: auto; }
		#content { padding: 32px 16px 48px; display: flex; flex-direction: column; align-items: center; }
		/* docx-preview のページ要素（.docx-wrapper > section.docx）に PDF ビューア風の白紙＋影を付ける。 */
		#content .docx-wrapper { background: transparent; padding: 0; display: flex; flex-direction: column; align-items: center; gap: 16px; }
		#content .docx-wrapper > section.docx { background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.35); margin: 0; }
		#status { position: absolute; top: 45%; width: 100%; text-align: center; opacity: .75; }
	</style>
</head>
<body>
	<div id="scroller"><div id="content"></div></div>
	<div id="status">読み込み中…</div>
	<script nonce="${nonce}" src="${libBase}/jszip.min.js"></script>
	<script nonce="${nonce}" src="${libBase}/docx-preview.min.js"></script>
	<script nonce="${nonce}">
		(async () => {
			const DOCX_URL = ${JSON.stringify(docxUrl)};
			const statusEl = document.getElementById('status');
			const contentEl = document.getElementById('content');
			try {
				if (!window.docx || !window.JSZip) {
					throw new Error('レンダリングライブラリの読み込みに失敗しました');
				}
				const buf = await (await fetch(DOCX_URL)).arrayBuffer();
				await window.docx.renderAsync(buf, contentEl, undefined, {
					className: 'docx',
					inWrapper: true,
					ignoreWidth: false,
					ignoreHeight: false,
					breakPages: true,
					renderHeaders: true,
					renderFooters: true,
					renderFootnotes: true,
					renderEndnotes: true,
					useBase64URL: true
				});
				statusEl.remove();
			} catch (err) {
				statusEl.textContent = 'Word 文書を表示できませんでした: ' + (err && err.message ? err.message : err);
			}
		})();
	</script>
</body>
</html>`;
	}

	private _updateWebviewPlacement(): void {
		const resource = this._currentResource;
		const shouldShow = this._editorVisible && !!resource;
		if (!shouldShow) {
			if (this._webview && this._webviewClaimed) {
				this._webview.release(this);
				this._webviewClaimed = false;
			}
			return;
		}
		const webview = this._ensureWebview(resource);
		const justClaimed = !this._webviewClaimed;
		if (justClaimed) {
			webview.claim(this, this.window, undefined);
			this._webviewClaimed = true;
		}
		dom.setParentFlowTo(webview.container, this._webviewContainer!);
		webview.setAnchorElement(this._webviewContainer!, this._layoutService.getContainer(this.window, Parts.EDITOR_PART));
		if (justClaimed) {
			this._renderResource(resource);
		}
	}

	override clearInput(): void {
		this._inputDisposables.clear();
		this._currentResource = undefined;
		if (this._webview && this._webviewClaimed) {
			this._webview.release(this);
			this._webviewClaimed = false;
		}
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		if (visible !== this._editorVisible) {
			this._editorVisible = visible;
			this._updateWebviewPlacement();
		}
		super.setEditorVisible(visible);
	}

	override focus(): void {
		super.focus();
		this._webview?.focus();
	}

	override layout(dimension: dom.Dimension): void {
		if (this._rootElement) {
			this._rootElement.style.width = `${dimension.width}px`;
			this._rootElement.style.height = `${dimension.height}px`;
		}
		this.setEditorVisible(dimension.width > 0 && dimension.height > 0);
	}
}
