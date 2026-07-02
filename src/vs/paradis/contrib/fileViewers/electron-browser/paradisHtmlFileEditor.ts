/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// HTML レンダリングビューア（Superset apps/desktop の HtmlPreviewWebview 相当）。
// ローカル HTML を webview に読み込み、スクリプト実行を許可しつつワークスペース外へ影響しないよう
// localResourceRoots を対象ファイルのディレクトリに限定する。相対リソースは <base href> で解決する。
// ズームは Superset 同様に倍率 1.2^level（範囲 -3〜+5）で、CSS zoom を webview 内に適用する。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Schemas } from '../../../../base/common/network.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { ParadisRenderedFileEditor } from '../browser/paradisRenderedFileEditor.js';
import { PARADIS_HTML_EDITOR_ID } from '../browser/paradisFileViewers.js';

const ZOOM_MIN = -3;
const ZOOM_MAX = 5;
const ZOOM_BASE = 1.2;

export class ParadisHtmlFileEditor extends ParadisRenderedFileEditor {

	static readonly ID = PARADIS_HTML_EDITOR_ID;

	private _zoomLevel = 0;
	private _zoomOutButton: HTMLButtonElement | undefined;
	private _zoomInButton: HTMLButtonElement | undefined;
	private _percentButton: HTMLButtonElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService webviewService: IWebviewService,
		@ITextFileService textFileService: ITextFileService,
		@IFileService fileService: IFileService,
		@ITextModelService textModelService: ITextModelService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(PARADIS_HTML_EDITOR_ID, group, telemetryService, themeService, storageService, webviewService, textFileService, fileService, textModelService, instantiationService);
	}

	protected override get allowScripts(): boolean {
		return true;
	}

	protected override onCreateToolbar(toolbar: HTMLElement): void {
		this._zoomOutButton = this._createIconButton(toolbar, Codicon.zoomOut, localize('paradis.html.zoomOut', "Zoom Out"));
		this._register(dom.addDisposableListener(this._zoomOutButton, dom.EventType.CLICK, () => this._applyZoom(this._zoomLevel - 1)));

		this._percentButton = dom.append(toolbar, dom.$('button.paradis-html-zoom-percent')) as HTMLButtonElement;
		this._percentButton.title = localize('paradis.html.resetZoom', "Reset Zoom");
		this._register(dom.addDisposableListener(this._percentButton, dom.EventType.CLICK, () => this._applyZoom(0)));

		this._zoomInButton = this._createIconButton(toolbar, Codicon.zoomIn, localize('paradis.html.zoomIn', "Zoom In"));
		this._register(dom.addDisposableListener(this._zoomInButton, dom.EventType.CLICK, () => this._applyZoom(this._zoomLevel + 1)));

		const refreshButton = this._createIconButton(toolbar, Codicon.refresh, localize('paradis.html.refresh', "Reload"));
		this._register(dom.addDisposableListener(refreshButton, dom.EventType.CLICK, () => this.webview?.reload()));

		this._updateZoomUI();
	}

	private _createIconButton(parent: HTMLElement, icon: ThemeIcon, title: string): HTMLButtonElement {
		const button = dom.append(parent, dom.$('button.paradis-html-zoom-button')) as HTMLButtonElement;
		button.title = title;
		dom.append(button, dom.$(`span${ThemeIcon.asCSSSelector(icon)}`));
		return button;
	}

	private get _zoomFactor(): number {
		return ZOOM_BASE ** this._zoomLevel;
	}

	private _applyZoom(level: number): void {
		const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
		if (clamped === this._zoomLevel) {
			this._updateZoomUI();
			return;
		}
		this._zoomLevel = clamped;
		void this.webview?.postMessage({ __paradisZoom: this._zoomFactor });
		this._updateZoomUI();
	}

	private _updateZoomUI(): void {
		if (this._percentButton) {
			this._percentButton.textContent = `${Math.round(this._zoomFactor * 100)}%`;
		}
		if (this._zoomOutButton) {
			this._zoomOutButton.disabled = this._zoomLevel <= ZOOM_MIN;
		}
		if (this._zoomInButton) {
			this._zoomInButton.disabled = this._zoomLevel >= ZOOM_MAX;
		}
	}

	protected override renderDocument(text: string, resource: URI, _webview: IWebviewElement): string {
		const dir = dirname(resource);
		const remoteInfo = resource.scheme === Schemas.vscodeRemote ? { isRemote: true, authority: resource.authority } : undefined;
		const baseHref = asWebviewUri(dir, remoteInfo).toString(true);

		// <base> で相対リソースを webview リソース URI に解決し、初期ズームを CSS zoom で焼き込む。
		const headInjection = `<base href="${baseHref}/"><style>html{zoom:${this._zoomFactor};}</style>`;
		// ライブなズーム変更（ボタン操作）を postMessage で受け取り、スクロール位置を保ったまま反映する。
		const zoomScript = `<script>(function(){try{window.addEventListener('message',function(e){var d=e.data;if(d&&typeof d.__paradisZoom==='number'){document.documentElement.style.zoom=String(d.__paradisZoom);}});}catch(err){}})();</script>`;

		let html = text;
		if (/<head[^>]*>/i.test(html)) {
			html = html.replace(/<head[^>]*>/i, match => `${match}${headInjection}`);
		} else if (/<html[^>]*>/i.test(html)) {
			html = html.replace(/<html[^>]*>/i, match => `${match}<head>${headInjection}</head>`);
		} else {
			html = `<head>${headInjection}</head>${html}`;
		}

		if (/<\/body>/i.test(html)) {
			html = html.replace(/<\/body>/i, `${zoomScript}</body>`);
		} else {
			html = `${html}${zoomScript}`;
		}

		return html;
	}
}
