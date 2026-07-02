/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown / HTML の Rendered ビューアが共有する EditorPane 基底クラス。
// 対象ファイルを読み込み、サブクラスが生成する完全な HTML ドキュメント文字列を
// IWebviewService の webview 要素に流し込んで表示する。ディスク上でファイルが
// 更新されたら correlated watcher（fileService.createWatcher）経由で自動再レンダリングする。

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { dirname, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../../../workbench/contrib/webview/browser/webview.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ParadisFileViewerInput } from './paradisFileViewerInput.js';

import './media/paradisFileViewer.css';

/**
 * Rendered ビューア共通の EditorPane。webview 要素のライフサイクル管理・ファイル読込・
 * 自動再レンダリングを担い、実際のドキュメント生成はサブクラスの {@link renderDocument} に委ねる。
 */
export abstract class ParadisRenderedFileEditor extends EditorPane {

	private _rootElement: HTMLElement | undefined;
	private _contentElement: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;

	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private _currentResource: URI | undefined;

	constructor(
		id: string,
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super(id, group, telemetryService, themeService, storageService);
	}

	/** webview 内でスクリプト実行を許可するか（HTML=true / Markdown=false）。 */
	protected abstract get allowScripts(): boolean;

	/** 読み込んだテキストから webview に表示する完全な HTML ドキュメント文字列を生成する。 */
	protected abstract renderDocument(text: string, resource: URI, webview: IWebviewElement): Promise<string> | string;

	/** webview 要素の生成直後に呼ばれるフック（サブクラスがメッセージ購読等を行う）。 */
	protected onWebviewCreated(_webview: IWebviewElement): void { }

	/** オーバーレイツールバー等をルート要素へ追加するためのフック。 */
	protected onCreateOverlay(_rootElement: HTMLElement): void { }

	/** 現在アクティブな webview（存在すれば）。 */
	protected get webview(): IWebviewElement | undefined {
		return this._webview;
	}

	protected override createEditor(parent: HTMLElement): void {
		this._rootElement = dom.append(parent, dom.$('.paradis-file-viewer'));
		this._contentElement = dom.append(this._rootElement, dom.$('.paradis-file-viewer-content'));
		this.onCreateOverlay(this._rootElement);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		const resource = (input as ParadisFileViewerInput).resource;
		this._currentResource = resource;

		const store = new DisposableStore();
		this._inputDisposables.value = store;

		// ディスク上のファイル変更を監視し、変更されたら自動再レンダリングする。
		try {
			const watcher = this._fileService.createWatcher(resource, { recursive: false, excludes: [] });
			store.add(watcher);
			store.add(watcher.onDidChange(e => {
				if (e.contains(resource) && isEqual(this._currentResource, resource)) {
					void this.renderResource(resource, CancellationToken.None);
				}
			}));
		} catch {
			// watcher の生成に失敗しても表示自体は継続できるため致命的ではない。
		}

		await this.renderResource(resource, token);
	}

	private async renderResource(resource: URI, token: CancellationToken): Promise<void> {
		let text: string;
		try {
			const content = await this._textFileService.read(resource, { acceptTextOnly: false });
			text = content.value;
		} catch {
			text = '';
		}
		if (token.isCancellationRequested || !isEqual(this._currentResource, resource)) {
			return;
		}

		const webview = this.ensureWebview(resource);
		webview.contentOptions = {
			allowScripts: this.allowScripts,
			localResourceRoots: [dirname(resource)]
		};

		const html = await this.renderDocument(text, resource, webview);
		if (token.isCancellationRequested || !isEqual(this._currentResource, resource)) {
			return;
		}
		webview.setHtml(html);
	}

	private ensureWebview(resource: URI): IWebviewElement {
		if (this._webview) {
			return this._webview;
		}
		const webview = this._webviewService.createWebviewElement({
			title: undefined,
			options: {
				purpose: WebviewContentPurpose.CustomEditor,
				enableFindWidget: true,
				tryRestoreScrollPosition: true
			},
			contentOptions: {
				allowScripts: this.allowScripts,
				localResourceRoots: [dirname(resource)]
			},
			extension: undefined
		});
		this._webview = webview;
		this._register(webview);
		webview.mountTo(this._contentElement!, this.window);
		this.onWebviewCreated(webview);
		return webview;
	}

	override clearInput(): void {
		this._inputDisposables.clear();
		this._currentResource = undefined;
		this._webview?.setHtml('');
		super.clearInput();
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
	}
}
