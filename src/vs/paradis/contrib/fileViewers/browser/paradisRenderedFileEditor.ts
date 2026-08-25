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
import { disposableTimeout, RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { DisposableStore, IDisposable, IReference, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { dirname, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IEditorConstructionOptions } from '../../../../editor/browser/config/editorConfiguration.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ParadisWebviewOriginPool } from './paradisWebviewOriginPool.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IOverlayWebview, IWebviewService, WebviewContentPurpose } from '../../../../workbench/contrib/webview/browser/webview.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { onParadisWebviewSignal, ParadisWebviewSignalCode } from '../../sentry/common/paradisWebviewSignals.js';
import { PARADIS_VIEWER_CONTENT_TIMEOUT_MS, PARADIS_VIEWER_SERVICE_WORKER_GRACE_MS, paradisViewerContentTimeout, ParadisViewerRecoveryPolicy } from '../common/paradisViewerRecovery.js';
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
	// webview 本体とその購読をまとめて捨てられるようにする（白紙からの復帰で作り直すため）。
	private readonly _webviewStore = this._register(new MutableDisposable<DisposableStore>());
	private _webviewClaimed = false;
	/** いまの webview を作ったときの {@link disableServiceWorkerFor} の答え。 */
	private _webviewServiceWorkerDisabled = false;
	private _editorVisible = false;
	// setHtml しても内容が届かない（白紙）ことを検知するウォッチドッグ。
	private readonly _contentWatchdog = this._register(new MutableDisposable<IDisposable>());
	// webview のイベント通知中に webview 自身を捨てないよう、立て直しは次のタイミングまで遅らせる。
	private readonly _deferredRecovery = this._register(new MutableDisposable<IDisposable>());
	private readonly _recoveryPolicy = new ParadisViewerRecoveryPolicy();
	private _watchdogGeneration = -1;
	private _watchdogTimeoutMs = PARADIS_VIEWER_CONTENT_TIMEOUT_MS;
	/**
	 * いまの描画で `setHtml` を呼んだ時刻と、そこから最後に届いたシグナル。
	 *
	 * 白紙の報告にこの2つが無いと、**「webview がそもそも起動していない」（content-started すら
	 * 来ない）のか「起動はしたが描画が止まった」（started/worker-ready の後で時間切れ）のかを
	 * Sentry から区別できない**。実際この区別が付かないまま、白紙34/35件がどちらなのか分からず
	 * 調査が止まった。待ち時間はシグナルのたびに張り直されるので、タイマーの値では代用できない。
	 */
	private _renderStartedAt = 0;
	private _lastContentSignal: string = 'none';
	private _codeEditor: ICodeEditor | undefined;
	private readonly _modelRef = this._register(new MutableDisposable<IReference<IResolvedTextEditorModel>>());

	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private _currentResource: URI | undefined;
	/**
	 * 直近の描画が「ファイルが無い」で失敗したリソース。
	 *
	 * プレビューのタブは、開いたファイルが消えても（エージェントが生成途中で消す、ブランチを切り替える等）
	 * 開いたままになる。ワークスペース全体の watch エラーはそのタブにも届くので、これを持たないと
	 * 「エラーが来る → 読み直す → 無いので失敗 → Sentry に送る」を延々と繰り返す。ファイル自身の
	 * 変更通知（作り直された合図）だけは受けたいので、タブを閉じるのではなく再描画の抑止に使う。
	 */
	private _missingResource: URI | undefined;
	private _mode: ParadisFileViewerMode = 'rendered';
	/**
	 * いま webview が保持している描画の元になったテキスト。
	 *
	 * ペインは可視性が変わるたびに overlay を claim し直し、そのたびに描き直していた。
	 * `retainContextWhenHidden` を入れた今は隠しても中身が生き残る（ウィンドウ間の移動で
	 * 作り直される場合も `OverlayWebview` が保持している HTML を自分で貼り直す）ので、内容が
	 * 変わっていないのに送り直す意味はない。**送り直すたびに iframe が作り直されてスクロール
	 * 位置が飛び、画像の埋め込みもやり直しになる**ため、同一なら黙って見送る。
	 */
	private _renderedSource: { readonly resource: URI; readonly text: string } | undefined;
	// watcher・claim・モード切替から始まった描画が逆順で完了しても、最後に開始した結果だけを反映する。
	private _renderGeneration = 0;
	/** webview の origin の貸し出し元（service worker の登録を開き直しで増やさないため）。 */
	private readonly _originPool: ParadisWebviewOriginPool;

	constructor(
		id: string,
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IFileService protected readonly _fileService: IFileService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IConfigurationService protected readonly _configurationService: IConfigurationService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super(id, group, telemetryService, themeService, storageService);
		this._originPool = ParadisWebviewOriginPool.getShared(storageService);

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

	/**
	 * テーマが変わったら Rendered を描き直す。
	 *
	 * コードブロックの配色は `generateTokensCSSForColorMap` で生成した CSS として **HTML に焼き
	 * 込んでいる**ため、webview へ配られるテーマ変数の更新だけでは追従しない。同じ内容の描き直しは
	 * 抑止しているので、ここで明示的に無効化しないと配色が古いまま残る。
	 */
	override updateStyles(): void {
		super.updateStyles();
		this._rerenderIfShowingRendered();
	}

	/** 透過状態の変化時、Rendered 表示中なら現在のリソースを描き直す。 */
	private _rerenderIfShowingRendered(): void {
		// 透過は HTML へ焼き込んでいるので、テキストが同じでも作り直す必要がある。
		this._renderedSource = undefined;
		const resource = this._currentResource;
		if (resource && this._webviewClaimed && this._mode === 'rendered') {
			this._renderResourceInBackground(resource);
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

	/**
	 * このリソースを表示する webview で service worker を止めるか。
	 *
	 * service worker は `vscode-resource` の URL（相対パスの画像など）を解決するためだけに要る。
	 * 一方で、origin に登録があるとその scope へのナビゲーションが worker の起動完了を待たされ、
	 * 実機では `index.html` / `fake.html` の読み込みが 60 秒止まるのを観測した（ビューアが白紙に
	 * なり Raw へ落ちる主因）。**リソースを自前で用意できるビューアは切ること。** upstream も
	 * 拡張機能の README・リリースノート・ウォークスルー・画像プレビューでは切っている。
	 *
	 * リソースごとに変わり得る（HTML はローカルファイルだけをローカルサーバから配れる）ので、
	 * 判断が前回と変わったときは webview を作り直す。生成時のオプションなので後から変えられない。
	 */
	protected disableServiceWorkerFor(_resource: URI): boolean {
		return false;
	}

	/** 読み込んだテキストから webview に表示する完全な HTML ドキュメント文字列を生成する。 */
	protected abstract renderDocument(text: string, resource: URI, webview: IOverlayWebview, token: CancellationToken): Promise<string> | string;

	/**
	 * webview 要素の生成直後に呼ばれるフック（サブクラスがメッセージ購読等を行う）。
	 *
	 * webview は白紙からの復帰で作り直されることがあるため、ここで足す購読は必ず `store` に
	 * 登録すること（`this._register` に足すと作り直すたびに溜まり、古い webview を掴んだままになる）。
	 */
	protected onWebviewCreated(_webview: IOverlayWebview, _store: DisposableStore): void { }

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
		this._renderedBtn.textContent = localize('paradis.fileViewer.rendered', "プレビュー");
		this._register(dom.addDisposableListener(this._renderedBtn, dom.EventType.CLICK, () => this.setViewMode('rendered')));
		this._rawBtn = dom.append(toggle, dom.$('button.paradis-file-viewer-toggle-item')) as HTMLButtonElement;
		this._rawBtn.textContent = localize('paradis.fileViewer.raw', "ソース");
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
		// 同じ URI の入力を設定し直す経路でも、旧入力から継続中の描画を無効化する。
		this._renderGeneration++;
		// ペインは別のファイルを開くときも使い回されるので、前のファイルの失敗回数を持ち越さない。
		this._recoveryPolicy.reset();
		this._currentResource = resource;
		// 別のファイルを開いたので、前のファイルが無かったことは引き継がない。
		this._missingResource = undefined;
		// 別ファイルに切り替わったので前のモデル参照を解放する。
		this._renderedSource = undefined;
		this._modelRef.clear();
		this._codeEditor?.setModel(null);

		const store = new DisposableStore();
		this._inputDisposables.value = store;
		let initialViewApplied = false;
		let rerenderAfterInitial = false;
		const rerender = () => {
			if (isEqual(this._currentResource, resource) && this._webviewClaimed && this._mode === 'rendered') {
				this._renderResourceInBackground(resource);
			}
		};
		const rerenderScheduler = store.add(new RunOnceScheduler(rerender, 50));
		// watch エラーはワークスペース全体から連続して届く場合があるため、通常の変更通知より長く抑制する。
		const watchRecoveryScheduler = store.add(new RunOnceScheduler(rerender, 1000));
		const scheduleRerender = (scheduler: RunOnceScheduler) => {
			// 初回描画より先に watcher 描画を開始すると、世代更新によって setInput が待つ描画を
			// 無効化してしまう。初回完了まで通知を記録し、直後に最新内容を読み直す。
			if (!initialViewApplied) {
				rerenderAfterInitial = true;
				return;
			}
			if (!scheduler.isScheduled()) {
				scheduler.schedule();
			}
		};

		// ディスク上のファイル変更を監視し、Rendered 表示中なら自動再レンダリングする（Raw は同一モデルなので自動反映。
		// 非表示/Raw のときは再描画不要 — 次に Rendered へ復帰(claim)する際に最新内容で描き直す）。
		try {
			const watcher = this._fileService.createWatcher(resource, { recursive: false, excludes: [] });
			store.add(watcher);
			store.add(watcher.onDidChange(e => {
				if (e.contains(resource)) {
					scheduleRerender(rerenderScheduler);
				}
			}));
		} catch {
			// watcher の生成に失敗しても表示自体は継続できるため致命的ではない。
		}
		// OS 側でイベントが欠落した場合は個別 watcher の onDidChange が来ないため、watch エラーを
		// 復旧用の再読込トリガーとして扱う。短時間のエラー連発は recovery scheduler で1回にまとめる。
		// ただし watch エラーはワークスペースのどこからでも届き、消えたファイルが戻った証拠には
		// ならない。無いと分かっているファイルまで読み直すと失敗を繰り返すだけなので見送る。
		store.add(this._fileService.onDidWatchError(() => {
			if (isEqual(this._missingResource, resource)) {
				return;
			}
			scheduleRerender(watchRecoveryScheduler);
		}));

		// Rendered の配置と実描画は _applyViewMode がまとめて担う。
		await this._applyViewMode(viewerInput.viewMode, resource, token);
		initialViewApplied = true;
		if (rerenderAfterInitial) {
			rerenderScheduler.schedule();
		}
	}

	private async renderResource(resource: URI, token: CancellationToken): Promise<void> {
		try {
			await this._doRenderResource(resource, token);
		} catch (err) {
			// ファイルが消えているのは不具合ではなくユーザー側の状態で、開いたままのタブがある限り
			// 何度でも再現する。エディタは読み取りエラーを自分で表示するので、診断としては送らない。
			if (toFileOperationResult(err) === FileOperationResult.FILE_NOT_FOUND) {
				this._missingResource = resource;
			} else if (!isCancellationError(err)) {
				// レンダリング経路の失敗(読み込み・変換・setHtml)も白紙表示の原因候補なので
				// Sentry へ送る(キャンセルは正常系)。呼出元のエラー処理はそのまま生かす。
				reportParadisDiagnosticError('owned', 'file-viewers', 'render', err, { safe_viewer: this.getId() });
			}
			throw err;
		}
	}

	private async _doRenderResource(resource: URI, token: CancellationToken): Promise<void> {
		const generation = ++this._renderGeneration;
		let text: string;
		// Raw で開いたモデルがあれば、その現在値(未保存の編集を含む)から Rendered を作る。
		const model = this._modelRef.value?.object.textEditorModel;
		if (model && !model.isDisposed() && isEqual(model.uri, resource)) {
			text = model.getValue();
		} else {
			const content = await this._textFileService.read(resource, { acceptTextOnly: false });
			text = content.value;
		}
		// 読めたので、消えていたファイルが戻った場合はここで抑止を解く。
		this._missingResource = undefined;
		if (!this._isRenderCurrent(generation, resource, token)) {
			return;
		}

		// service worker の要否が前回と変わっていたら、生成時オプションなので作り直すしかない。
		if (this._webview && this._webviewServiceWorkerDisabled !== this.disableServiceWorkerFor(resource)) {
			this._disposeWebview();
			this._updateWebviewPlacement();
		}

		// 既に同じ内容を表示している（可視化のたびの claim など）なら送り直さない。
		if (this._webview && this._renderedSource && isEqual(this._renderedSource.resource, resource) && this._renderedSource.text === text) {
			return;
		}

		const webview = this.ensureWebview(resource);
		webview.contentOptions = {
			allowScripts: this.allowScripts,
			localResourceRoots: [dirname(resource)]
		};

		const html = await this.renderDocument(text, resource, webview, token);
		if (!this._isRenderCurrent(generation, resource, token)) {
			return;
		}
		webview.setHtml(html);
		this._renderedSource = { resource, text };
		// setHtml は「送った」だけで「表示された」ことは保証しない。webview 側が内容を書き終えたら
		// content-applied シグナルが返るので、それが来なければ白紙とみなして立て直す。
		this._startContentWatchdog(generation, paradisViewerContentTimeout(html.length));
	}

	/** 内容が届かないまま時間切れになったら復帰処理へ回す。 */
	private _startContentWatchdog(generation: number, timeoutMs: number): void {
		this._watchdogGeneration = generation;
		this._watchdogTimeoutMs = timeoutMs;
		this._renderStartedAt = Date.now();
		this._lastContentSignal = 'none';
		// ここでは service worker の猶予を足さない。制御待ちは webview が内容を受け取ってから
		// 始まるので、その合図（content-started）が来た時点で足す。webview がそもそも動いていない
		// ケースまで長く待つと、読める状態に戻すのがいたずらに遅くなる。
		this._armContentWatchdog(timeoutMs);
	}

	private _armContentWatchdog(timeoutMs: number): void {
		const generation = this._watchdogGeneration;
		this._contentWatchdog.value = disposableTimeout(() => {
			if (generation !== this._renderGeneration) {
				return;
			}
			this._handleRenderFailure('content-timeout');
		}, timeoutMs);
	}

	/**
	 * 白紙を検知したときの立て直し。まずは webview を作り直し、繰り返すようなら中身が確実に読める
	 * Raw へ倒す（白紙のまま放置しない）。
	 */
	private _handleRenderFailure(reason: 'fatal-error' | 'content-timeout'): void {
		this._contentWatchdog.clear();
		this._deferredRecovery.clear();
		const resource = this._currentResource;
		// Raw 表示中や非表示のペインは描画していないので、失敗として数えない。
		if (!resource || this._mode !== 'rendered' || !this._editorVisible) {
			return;
		}

		const action = this._recoveryPolicy.recordFailure();
		reportParadisDiagnosticError('owned', 'file-viewers', 'blank-recovery', new Error(`Rendered view stayed blank (${reason})`), {
			safe_viewer: this.getId(),
			safe_reason: reason,
			safe_action: action,
			// `setHtml` からの実経過。`safe_last_signal` と併せて読むと、webview が起動して
			// いないのか（`none`）、起動後に描画が止まったのか（`content-started` 以降）が分かる。
			//
			// **`content-timeout` のときだけ載せる。** `fatal-error` は描画が成功して何時間も
			// 経った後にも来るので、そこで経過を出すと「最後の setHtml からの数時間」という
			// 誤読しか生まない（成功時にウォッチドッグは止まるが起点は残るため）。
			duration_ms: reason === 'content-timeout' && this._renderStartedAt !== 0 ? Date.now() - this._renderStartedAt : undefined,
			safe_last_signal: this._lastContentSignal,
		});

		// 壊れた webview は作り直す。Raw へ倒す場合も、掴めなくなったコンテンツプロセスを
		// タブが閉じるまで抱え続けないよう同じように捨てる。
		this._disposeWebview();

		if (action === 'retry') {
			// 直前に mode/可視性/リソースを確かめているので claim は必ず成立するが、状態が変わって
			// いた場合に描画だけ走らせないよう戻り値で確認する。
			if (this._updateWebviewPlacement()) {
				this._renderResourceInBackground(resource);
			}
			return;
		}

		this._notificationService.notify({
			severity: Severity.Warning,
			message: localize('paradis.fileViewer.blankFallback', "プレビューを表示できなかったため、ソース表示で開きました。"),
		});
		this._applyViewModeFromRecovery('raw');
	}

	/** 復帰処理から Raw へ倒す。失敗の記録は残す（ユーザーが Rendered を選び直すまでやり直さない）。 */
	private _applyViewModeFromRecovery(mode: ParadisFileViewerMode): void {
		if (this.input instanceof ParadisFileViewerInput) {
			this.input.setViewMode(mode);
		}
		const resource = this._currentResource;
		if (resource) {
			this._applyViewMode(mode, resource).catch(onUnexpectedError);
		}
	}

	/** webview 側から内容の反映を知らせるシグナルが来た。 */
	private _onContentApplied(): void {
		this._contentWatchdog.clear();
		this._recoveryPolicy.recordSuccess();
	}

	/**
	 * claim を解いてから webview 本体と購読を捨てる。次の描画で作り直される。
	 *
	 * 作り直すとスクロール位置や検索の状態は失われるが、これは白紙から立て直すときにしか通らない
	 * 経路なので、何も見えないままにするより読める状態に戻すことを優先する。
	 */
	private _disposeWebview(): void {
		if (this._webview && this._webviewClaimed) {
			this._webview.release(this);
		}
		this._webviewClaimed = false;
		this._webview = undefined;
		this._renderedSource = undefined;
		this._contentWatchdog.clear();
		this._webviewStore.clear();
	}

	private _isRenderCurrent(generation: number, resource: URI, token: CancellationToken): boolean {
		return generation === this._renderGeneration && !token.isCancellationRequested && isEqual(this._currentResource, resource);
	}

	/**
	 * サブクラスから描き直しを頼む口。
	 *
	 * 描画の途中で「この作り方では表示できない」と分かったとき（配信サーバに載せられなかった等）に
	 * 使う。**サブクラスが自分で蹴らないと誰も蹴らない** — 失敗しても `setHtml` 自体は成功するので、
	 * 白紙検知は鳴らないため。
	 */
	protected requestRerender(): void {
		// いまの内容は当てにならないので、同一内容の抑止を外してから描き直す。
		this._renderedSource = undefined;
		const resource = this._currentResource;
		if (resource && this._webviewClaimed && this._mode === 'rendered') {
			this._renderResourceInBackground(resource);
		}
	}

	/** UI イベント由来の再描画。失敗時は現在の HTML を保持し、未処理の Promise を残さない。 */
	private _renderResourceInBackground(resource: URI): void {
		this.renderResource(resource, CancellationToken.None).catch(onUnexpectedError);
	}

	private ensureWebview(resource: URI): IOverlayWebview {
		if (this._webview) {
			return this._webview;
		}
		const store = new DisposableStore();
		this._webviewStore.value = store;
		// origin を渡さないと webview ごとに新しい service worker 登録が増え、二度と消えない。
		// スロットを借りるので、同時に開いている他のビューアとは必ず別の origin になる
		// （下のシグナル照合が origin の一意性に依存している）。
		const originLease = store.add(this._originPool.acquire(this.getId()));
		this._webviewServiceWorkerDisabled = this.disableServiceWorkerFor(resource);
		const webview = store.add(this._webviewService.createWebviewOverlay({
			origin: originLease.origin,
			title: undefined,
			options: {
				purpose: WebviewContentPurpose.CustomEditor,
				enableFindWidget: true,
				tryRestoreScrollPosition: true,
				// 非表示になるたびに service worker 登録からやり直すと、白紙で止まる窓が毎回でき直す
				// （「Rendered だけ間欠的に白紙になる」フィールド報告の主因、下の onFatalError 参照）。
				// 生かしたまま隠すことでその窓を無くす。
				retainContextWhenHidden: true,
				disableServiceWorker: this._webviewServiceWorkerDisabled
			},
			contentOptions: {
				allowScripts: this.allowScripts,
				localResourceRoots: [dirname(resource)]
			},
			extension: undefined
		}));
		this._webview = webview;
		// 「Rendered だけ間欠的に白紙になる」フィールド報告の調査用: webview 基盤の致命
		// エラー(service worker 登録失敗等)を Sentry へ送る。リソースのパスは含めない
		// (エディタ種別 ID だけで Markdown/HTML ビューアのどちらかは判別できる)。
		store.add(webview.onFatalError(e => {
			// `safe_` 接頭辞はサニタイザの extra allowlist を通すために必須（素のキーは破棄される）。
			reportParadisDiagnosticError('owned', 'file-viewers', 'webview-fatal-error', new Error(e.message), { safe_viewer: this.getId() });
			// このコールバックは webview 自身のイベント配信中なので、その場で dispose せず一拍おく。
			this._deferredRecovery.value = disposableTimeout(() => this._handleRenderFailure('fatal-error'), 0);
		}));
		// webview 内から届く健全性シグナル。origin は overlay ごとに一意なので自分宛かを照合できる。
		store.add(onParadisWebviewSignal(signal => {
			// webview は世代をまたいで使い回されるので、いま待っている描画のシグナルだけを見る。
			// （古い描画のシグナルが遅れて届いても、次の描画の監視を解いてしまわないようにする）
			if (signal.origin !== webview.origin || this._watchdogGeneration !== this._renderGeneration) {
				return;
			}
			// **どのシグナルも記録する**。`sw-control-timeout` / `sw-register-timeout` のような
			// service worker 系こそが「起動後に描画が止まった」原因の本命なので、content 系だけを
			// 覚えていると、いちばん区別したかった状態が `content-started` に埋もれて落ちる。
			this._lastContentSignal = signal.code;
			switch (signal.code) {
				case ParadisWebviewSignalCode.ContentApplied:
					this._onContentApplied();
					break;
				case ParadisWebviewSignalCode.ContentStarted:
					// 内容が webview に届いたところから数え直す。webview の起動待ちで時間を使い切って
					// しまい、描画は正常なのに作り直す、という誤判定を避ける。
					this._armContentWatchdog(PARADIS_VIEWER_SERVICE_WORKER_GRACE_MS + this._watchdogTimeoutMs);
					break;
				case ParadisWebviewSignalCode.ContentWorkerReady:
					// service worker 待ちを抜けたので、あとは描画の時間だけを測る。
					this._armContentWatchdog(this._watchdogTimeoutMs);
					break;
			}
		}));
		this.onWebviewCreated(webview, store);
		return webview;
	}

	/**
	 * overlay webview を「可視 かつ Rendered」のときだけ claim してアンカーへ重ね、それ以外では release する。
	 * claim で下地要素が作り直され内容が失われ得るため、true を返した呼出元は必ず再描画する。
	 */
	private _updateWebviewPlacement(): boolean {
		const resource = this._currentResource;
		const shouldShow = this._editorVisible && this._mode === 'rendered' && !!resource;
		if (!shouldShow) {
			if (this._webview && this._webviewClaimed) {
				this._webview.release(this);
				this._webviewClaimed = false;
			}
			// 描画を見せていない間は白紙の監視も止める（復帰させる相手がいない）。
			// 世代も外しておかないと、遅れて届いたシグナルが監視を張り直してしまう。
			this._watchdogGeneration = -1;
			this._contentWatchdog.clear();
			return false;
		}
		const webview = this.ensureWebview(resource);
		const justClaimed = !this._webviewClaimed;
		if (justClaimed) {
			webview.claim(this, this.window, undefined);
			this._webviewClaimed = true;
		}
		dom.setParentFlowTo(webview.container, this._webviewContainer!);
		webview.setAnchorElement(this._webviewContainer!, this._layoutService.getContainer(this.window, Parts.EDITOR_PART));
		return justClaimed;
	}

	/** Rendered/Raw を内部切替する（エディタは開き直さない）。 */
	setViewMode(mode: ParadisFileViewerMode): void {
		if (mode === 'rendered') {
			// ユーザーが自分で Rendered を選んだ＝もう一度試したいということなので、
			// 直前までの失敗の記録を捨てる（さもないと押した瞬間また Raw へ戻される）。
			this._recoveryPolicy.reset();
		}
		if (this.input instanceof ParadisFileViewerInput) {
			this.input.setViewMode(mode);
		}
		const resource = this._currentResource;
		if (!resource) {
			return;
		}
		this._applyViewMode(mode, resource).catch(onUnexpectedError);
	}

	/** 現在の表示モード。 */
	getViewMode(): ParadisFileViewerMode {
		return this._mode;
	}

	private async _applyViewMode(mode: ParadisFileViewerMode, resource: URI, token: CancellationToken = CancellationToken.None): Promise<void> {
		this._mode = mode;
		this._renderedBtn?.classList.toggle('active', mode === 'rendered');
		this._rawBtn?.classList.toggle('active', mode === 'raw');

		if (mode === 'raw') {
			await this._ensureRawEditor(resource);
			// await 中に別ファイルへ切り替わっていたら、古い継続で DOM/フォーカスを触らない
			// (新入力側が設定した表示状態を古い mode のまま上書きしないようにする)。
			if (!isEqual(this._currentResource, resource) || this._mode !== mode) {
				return;
			}
		}
		// Raw エディタは active クラス(visibility)で表示切替。Rendered(webview overlay)は claim/release で制御する。
		this._editorContainer?.classList.toggle('active', mode === 'raw');
		this._updateWebviewPlacement();
		if (mode === 'rendered') {
			// setInput はこの描画を待つ。既に別経路で claim 済みでも必ず最新世代を開始し、
			// 非表示の入力も事前描画して、Raw の未保存編集やファイルの現在値を反映する。
			await this.renderResource(resource, token);
		}
		if (!isEqual(this._currentResource, resource) || this._mode !== mode) {
			return;
		}
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
		this._renderGeneration++;
		this._watchdogGeneration = -1;
		this._contentWatchdog.clear();
		this._recoveryPolicy.reset();
		this._currentResource = undefined;
		this._codeEditor?.setModel(null);
		this._modelRef.clear();
		// overlay の所有権を手放す（内容プロセスは webview レイヤー側で管理される）。
		if (this._webview && this._webviewClaimed) {
			this._webview.release(this);
			this._webviewClaimed = false;
		}
		// 次の入力を claim した直後に前ファイルの内容が一瞬表示されないよう、保持 HTML も消去する。
		this._webview?.setHtml('');
		this._renderedSource = undefined;
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		if (visible !== this._editorVisible) {
			this._editorVisible = visible;
			// 可視 かつ Rendered のときだけ overlay を claim、非可視では release する（webviewEditor と同じ挙動）。
			if (this._updateWebviewPlacement()) {
				const resource = this._currentResource;
				if (resource) {
					this._renderResourceInBackground(resource);
				}
			}
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
