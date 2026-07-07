/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown / HTML ビューアが共有する EditorPane 基底クラス（単一ペイン内蔵方式）。
// 1つのペイン内に Rendered（webview）と Raw（埋め込み CodeEditorWidget = フル機能のテキストエディタ）を内蔵し、
// 上部ツールバーの Rendered/Raw トグルで内部切替する（エディタを開き直さないのでタブは常に1つ）。
// Raw は ITextModelService のモデル参照で言語機能/ハイライトが効き、編集可能・保存可能（dirty は EditorInput が委譲）。
// ディスク上の変更は correlated watcher で Rendered を自動再レンダリングする。
//
// Rendered は upstream の webviewPanel と同じ WebviewOverlay + claim/release 方式で表示する
// （src/vs/workbench/contrib/webviewPanel/browser/webviewEditor.ts 参照）。overlay は workbench の
// webview レイヤーに生き続けるため、タブ切替・ペインの hide/再表示・グループ移動でも webview のコンテンツ
// プロセスが破棄されない。ペインが可視かつ Rendered のときだけ claim + setAnchorElement でアンカーへ重ね、
// Raw / 非可視のときは release する。claim 直後は下地が作り直され内容が失われ得るため、復帰時は必ず再 setHtml する。

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, IReference, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { dirname, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IEditorConstructionOptions } from '../../../../editor/browser/config/editorConfiguration.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IOverlayWebview, IWebviewService, WebviewContentPurpose } from '../../../../workbench/contrib/webview/browser/webview.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { clampParadisTransparencyOpacity, PARADIS_TRANSPARENCY_ENABLED_KEY, PARADIS_TRANSPARENCY_OPACITY_KEY, PARADIS_TRANSPARENT_CLASS } from '../../windowTransparency/common/paradisTransparency.js';
import { ParadisFileViewerInput, ParadisFileViewerMode } from './paradisFileViewerInput.js';

import './media/paradisFileViewer.css';

const RAW_EDITOR_OPTIONS: IEditorConstructionOptions = {
	automaticLayout: true,
	scrollBeyondLastLine: false,
	readOnly: false,
};

/**
 * Rendered/Raw を内蔵する EditorPane 基底。webview と埋め込みコードエディタのライフサイクル管理・
 * ファイル読込・自動再レンダリング・モード切替を担い、Rendered の HTML 生成はサブクラスの {@link renderDocument} に委ねる。
 */
export abstract class ParadisRenderedFileEditor extends EditorPane {

	private _rootElement: HTMLElement | undefined;
	private _webviewContainer: HTMLElement | undefined;
	private _editorContainer: HTMLElement | undefined;
	private _toolbarRightElement: HTMLElement | undefined;
	private _renderedBtn: HTMLButtonElement | undefined;
	private _rawBtn: HTMLButtonElement | undefined;

	private _webview: IOverlayWebview | undefined;
	private _webviewClaimed = false;
	private _editorVisible = false;
	private _codeEditor: ICodeEditor | undefined;
	private readonly _modelRef = this._register(new MutableDisposable<IReference<IResolvedTextEditorModel>>());

	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private _currentResource: URI | undefined;
	private _mode: ParadisFileViewerMode = 'rendered';

	constructor(
		id: string,
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IFileService private readonly _fileService: IFileService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super(id, group, telemetryService, themeService, storageService);

		// ウィンドウ透過（paradis.window.transparency.*）の状態変化に追従して Rendered を描き直す。
		// 透過背景は renderDocument が HTML へ焼き込む（webview 内からは --paradis-* カスタムプロパティを
		// 参照できないため）ので、設定変更時は再レンダリングが必要。
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_TRANSPARENCY_ENABLED_KEY) || e.affectsConfiguration(PARADIS_TRANSPARENCY_OPACITY_KEY)) {
				this._rerenderIfShowingRendered();
			}
		}));

		// セッション復元時はエディタのレンダリングが透過contribution（AfterRestored）による
		// `paradis-transparent` クラス付与より先に走ることがあるため、クラスの後付けも監視して描き直す。
		let lastTransparent = this._layoutService.mainContainer.classList.contains(PARADIS_TRANSPARENT_CLASS);
		const classObserver = new MutationObserver(() => {
			const transparent = this._layoutService.mainContainer.classList.contains(PARADIS_TRANSPARENT_CLASS);
			if (transparent !== lastTransparent) {
				lastTransparent = transparent;
				this._rerenderIfShowingRendered();
			}
		});
		classObserver.observe(this._layoutService.mainContainer, { attributes: true, attributeFilter: ['class'] });
		this._register(toDisposable(() => classObserver.disconnect()));
	}

	/** 透過状態の変化時、Rendered 表示中なら現在のリソースを描き直す。 */
	private _rerenderIfShowingRendered(): void {
		const resource = this._currentResource;
		if (resource && this._webviewClaimed && this._mode === 'rendered') {
			void this.renderResource(resource, CancellationToken.None);
		}
	}

	/**
	 * ウィンドウ透過が実際に有効なとき（設定ON かつ ネイティブウィンドウが透過生成済み＝workbenchルートに
	 * `paradis-transparent` クラスが付いているとき）、webview 内の HTML へ焼き込む半透明背景CSSルールを返す。
	 * 無効時は空文字。`--vscode-editor-background` は webview 内へエクスポートされるテーマ変数なのでそのまま
	 * 参照でき、opacity（パーセント値）だけを焼き込めばワークベンチ側の color-mix と同じ見た目になる。
	 */
	protected getTransparencyBackgroundCssRule(bodySelector: string): string {
		if (!this._layoutService.mainContainer.classList.contains(PARADIS_TRANSPARENT_CLASS)) {
			return '';
		}
		const percentage = Math.round(clampParadisTransparencyOpacity(this._configurationService.getValue<number>(PARADIS_TRANSPARENCY_OPACITY_KEY)) * 100);
		return `${bodySelector} { background-color: color-mix(in srgb, var(--vscode-editor-background) ${percentage}%, transparent); }`;
	}

	/** webview 内でスクリプト実行を許可するか（HTML=true / Markdown=false）。 */
	protected abstract get allowScripts(): boolean;

	/** 読み込んだテキストから webview に表示する完全な HTML ドキュメント文字列を生成する。 */
	protected abstract renderDocument(text: string, resource: URI, webview: IOverlayWebview): Promise<string> | string;

	/** webview 要素の生成直後に呼ばれるフック（サブクラスがメッセージ購読等を行う）。 */
	protected onWebviewCreated(_webview: IOverlayWebview): void { }

	/** ツールバー右側（トグルの隣）へサブクラス固有のコントロール（HTMLズーム等）を追加するためのフック。 */
	protected onCreateToolbar(_toolbarRight: HTMLElement): void { }

	/** 現在アクティブな webview（存在すれば）。 */
	protected get webview(): IOverlayWebview | undefined {
		return this._webview;
	}

	protected override createEditor(parent: HTMLElement): void {
		this._rootElement = dom.append(parent, dom.$('.paradis-file-viewer'));

		// ペイン内ツールバー（常時表示・両モード共通位置）。左=Rendered/Raw セグメントトグル、右=サブクラス固有（HTMLズーム等）。
		const toolbar = dom.append(this._rootElement, dom.$('.paradis-file-viewer-toolbar'));
		const toggle = dom.append(toolbar, dom.$('.paradis-file-viewer-toggle'));
		this._renderedBtn = dom.append(toggle, dom.$('button.paradis-file-viewer-toggle-item')) as HTMLButtonElement;
		this._renderedBtn.textContent = localize('paradis.fileViewer.rendered', "Rendered");
		this._register(dom.addDisposableListener(this._renderedBtn, dom.EventType.CLICK, () => this.setViewMode('rendered')));
		this._rawBtn = dom.append(toggle, dom.$('button.paradis-file-viewer-toggle-item')) as HTMLButtonElement;
		this._rawBtn.textContent = localize('paradis.fileViewer.raw', "Raw");
		this._register(dom.addDisposableListener(this._rawBtn, dom.EventType.CLICK, () => this.setViewMode('raw')));

		this._toolbarRightElement = dom.append(toolbar, dom.$('.paradis-file-viewer-toolbar-right'));
		this.onCreateToolbar(this._toolbarRightElement);

		const content = dom.append(this._rootElement, dom.$('.paradis-file-viewer-content'));
		// webview コンテナは overlay webview を重ねる「アンカー(位置合わせ用の空要素)」。overlay 自身は
		// workbench の webview レイヤーに属し、ここには描画されない。常にレイアウトさせておく(矩形が必要)。
		this._webviewContainer = dom.append(content, dom.$('.paradis-file-viewer-webview'));
		this._editorContainer = dom.append(content, dom.$('.paradis-file-viewer-editor'));
		// 既定は Rendered。Raw エディタコンテナは active クラス(visibility)でのみ切り替える。
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		const viewerInput = input as ParadisFileViewerInput;
		const resource = viewerInput.resource;
		this._currentResource = resource;
		// 別ファイルに切り替わったので前のモデル参照を解放する。
		this._modelRef.clear();
		this._codeEditor?.setModel(null);

		const store = new DisposableStore();
		this._inputDisposables.value = store;

		// ディスク上のファイル変更を監視し、Rendered 表示中なら自動再レンダリングする（Raw は同一モデルなので自動反映。
		// 非表示/Raw のときは再描画不要 — 次に Rendered へ復帰(claim)する際に最新内容で描き直す）。
		try {
			const watcher = this._fileService.createWatcher(resource, { recursive: false, excludes: [] });
			store.add(watcher);
			store.add(watcher.onDidChange(e => {
				if (e.contains(resource) && isEqual(this._currentResource, resource) && this._webviewClaimed && this._mode === 'rendered') {
					void this.renderResource(resource, CancellationToken.None);
				}
			}));
		} catch {
			// watcher の生成に失敗しても表示自体は継続できるため致命的ではない。
		}

		// Rendered の実描画は _applyViewMode → _updateWebviewPlacement(claim+setHtml)が担う。
		await this._applyViewMode(viewerInput.viewMode, resource);
	}

	private async renderResource(resource: URI, token: CancellationToken): Promise<void> {
		let text: string;
		// Raw で開いたモデルがあれば、その現在値(未保存の編集を含む)から Rendered を作る。
		const model = this._modelRef.value?.object.textEditorModel;
		if (model && !model.isDisposed() && isEqual(model.uri, resource)) {
			text = model.getValue();
		} else {
			try {
				const content = await this._textFileService.read(resource, { acceptTextOnly: false });
				text = content.value;
			} catch {
				text = '';
			}
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

	private ensureWebview(resource: URI): IOverlayWebview {
		if (this._webview) {
			return this._webview;
		}
		const webview = this._webviewService.createWebviewOverlay({
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
		this.onWebviewCreated(webview);
		return webview;
	}

	/**
	 * overlay webview を「可視 かつ Rendered」のときだけ claim してアンカーへ重ね、それ以外では release する。
	 * claim で下地要素が作り直され内容が失われ得るため、claim した直後は必ず setHtml を貼り直す（冪等）。
	 */
	private _updateWebviewPlacement(): void {
		const resource = this._currentResource;
		const shouldShow = this._editorVisible && this._mode === 'rendered' && !!resource;
		if (!shouldShow) {
			if (this._webview && this._webviewClaimed) {
				this._webview.release(this);
				this._webviewClaimed = false;
			}
			return;
		}
		const webview = this.ensureWebview(resource);
		const justClaimed = !this._webviewClaimed;
		if (justClaimed) {
			webview.claim(this, this.window, undefined);
			this._webviewClaimed = true;
		}
		dom.setParentFlowTo(webview.container, this._webviewContainer!);
		webview.setAnchorElement(this._webviewContainer!, this._layoutService.getContainer(this.window, Parts.EDITOR_PART));
		if (justClaimed) {
			void this.renderResource(resource, CancellationToken.None);
		}
	}

	/** Rendered/Raw を内部切替する（エディタは開き直さない）。 */
	setViewMode(mode: ParadisFileViewerMode): void {
		if (this.input instanceof ParadisFileViewerInput) {
			this.input.setViewMode(mode);
		}
		const resource = this._currentResource;
		if (!resource) {
			return;
		}
		// Rendered へ戻るときは Raw で編集された現在値を反映するため再レンダリングする（既に claim 済みの場合。
		// 未 claim なら _applyViewMode → _updateWebviewPlacement の claim 時に描き直される）。
		if (mode === 'rendered' && this._modelRef.value && this._webviewClaimed) {
			void this.renderResource(resource, CancellationToken.None);
		}
		void this._applyViewMode(mode, resource);
	}

	/** 現在の表示モード。 */
	getViewMode(): ParadisFileViewerMode {
		return this._mode;
	}

	private async _applyViewMode(mode: ParadisFileViewerMode, resource: URI): Promise<void> {
		this._mode = mode;
		this._renderedBtn?.classList.toggle('active', mode === 'rendered');
		this._rawBtn?.classList.toggle('active', mode === 'raw');

		if (mode === 'raw') {
			await this._ensureRawEditor(resource);
			// await 中に別ファイルへ切り替わっていたら、古い継続で DOM/フォーカスを触らない
			// (新入力側が設定した表示状態を古い mode のまま上書きしないようにする)。
			if (!isEqual(this._currentResource, resource)) {
				return;
			}
		}
		// Raw エディタは active クラス(visibility)で表示切替。Rendered(webview overlay)は claim/release で制御する。
		this._editorContainer?.classList.toggle('active', mode === 'raw');
		this._updateWebviewPlacement();
		if (mode === 'raw') {
			this._codeEditor?.focus();
		} else {
			this._webview?.focus();
		}
	}

	private async _ensureRawEditor(resource: URI): Promise<void> {
		if (!this._codeEditor) {
			this._codeEditor = this._register(this._instantiationService.createInstance(CodeEditorWidget, this._editorContainer!, RAW_EDITOR_OPTIONS, {}));
		}
		// 既に同じモデルを表示していれば何もしない。
		if (this._modelRef.value && isEqual(this._modelRef.value.object.textEditorModel.uri, resource)) {
			return;
		}
		const ref = await this._textModelService.createModelReference(resource);
		if (!isEqual(this._currentResource, resource)) {
			ref.dispose();
			return;
		}
		this._modelRef.value = ref;
		this._codeEditor.setModel(ref.object.textEditorModel);
	}

	override clearInput(): void {
		this._inputDisposables.clear();
		this._currentResource = undefined;
		this._codeEditor?.setModel(null);
		this._modelRef.clear();
		// overlay の所有権を手放す（内容プロセスは webview レイヤー側で管理される）。
		if (this._webview && this._webviewClaimed) {
			this._webview.release(this);
			this._webviewClaimed = false;
		}
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		if (visible !== this._editorVisible) {
			this._editorVisible = visible;
			// 可視 かつ Rendered のときだけ overlay を claim、非可視では release する（webviewEditor と同じ挙動）。
			this._updateWebviewPlacement();
		}
		super.setEditorVisible(visible);
	}

	override getControl(): ICodeEditor | undefined {
		return this._mode === 'raw' ? this._codeEditor : undefined;
	}

	override focus(): void {
		super.focus();
		if (this._mode === 'raw') {
			this._codeEditor?.focus();
		} else {
			this._webview?.focus();
		}
	}

	override layout(dimension: dom.Dimension): void {
		if (this._rootElement) {
			this._rootElement.style.width = `${dimension.width}px`;
			this._rootElement.style.height = `${dimension.height}px`;
		}
		// 可視性は寸法からも判定する（タブ切替でペインが 0x0 に畳まれる経路を確実に拾うため。webviewEditor と同方式）。
		this.setEditorVisible(dimension.width > 0 && dimension.height > 0);
		// CodeEditorWidget は automaticLayout: true なので自動追従する。
	}
}
