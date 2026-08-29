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
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../base/common/network.js';
import { basename, dirname, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService, type IConfigurationValue } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ParadisWebviewOriginPool } from '../browser/paradisWebviewOriginPool.js';
import { paradisPreviewOrigins, resolveParadisViewerDocumentUrl, resolveParadisViewerLibBase } from './paradisViewerAssets.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IOverlayWebview, IWebviewService, WebviewContentPurpose } from '../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { extractParadisWordRenderableObjects } from '../common/word/paradisWordRenderableExtractor.js';
import { readWordRenderablePackageParts } from '../browser/word/paradisWordPackageParts.js';
import { buildParadisWordOverlayItems } from './word/paradisWordObjectOverlayHtml.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ParadisDocxInput } from './paradisDocxInput.js';
import { PARADIS_DOCX_EDITOR_ID } from '../browser/paradisFileViewers.js';
import { ParadisOfficeAccessibility, applyParadisOfficeWebviewAccessibility } from '../browser/paradisOfficeAccessibility.js';
import { ParadisOfficeFindWidget } from '../browser/paradisOfficeFindWidget.js';
import { PARADIS_DOCX_MAX_BYTES, type IParadisDocxOutline } from '../common/paradisDocx.js';
import { createParadisOfficeSearchPrintCallbacks, snapshotParadisOfficeRuntimeConfiguration, type ParadisOfficeConfigurationReader, type ParadisOfficeRuntimeConfiguration } from '../common/paradisOfficeCapabilities.js';
import { createParadisOfficeWordPrintModel, type ParadisOfficeWordPrintItem } from '../common/paradisOfficePrint.js';
import { buildParadisOfficeWordCsp, paradisOfficeWebviewResourceOrigin } from '../common/paradisOfficeSanitizer.js';
import type { ParadisOfficeCompletenessManifest, ParadisOfficePlaceholder, ParadisOfficePrintModel, ParadisOfficeRenderCoverage, ParadisOfficeSourceDescriptor } from '../common/paradisOfficeProtocol.js';
import { beginParadisOfficeRecovery, createParadisOfficeRecoveryState, reduceParadisOfficeRecovery, type IParadisOfficeRecoveryState, type ParadisOfficeRecoveryEffect } from '../common/paradisOfficeRecovery.js';
import { ParadisOfficeViewerProbe } from '../common/paradisOfficeProbe.js';
import type { ParadisOfficeDiagnosticEngine } from '../common/paradisOfficeDiagnostics.js';
import { sanitizeParadisDocxBytesForRenderer } from './paradisDocxDiffWebview.js';
import { localize } from '../../../../nls.js';
import { PARADIS_WORD_CHANGE_CATEGORIES, ParadisWordChangeInspector, restoreParadisWordViewState, type ParadisWordViewState } from './word/paradisWordChangeInspector.js';
import { renderWordDiagnosticsRibbon } from './word/paradisWordDiagnostics.js';
import { printParadisOfficeModelInBrowser, withParadisOfficePrintResult } from './paradisOfficePrintService.js';

/** vendored docx-preview / jszip 成果物の配置ディレクトリ（AppResourcePath）。 */
const DOCX_MEDIA_ROOT = 'vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview' as const;
const DOCX_HEADER_BYTES = 4;
const DOCX_WATCH_RERENDER_DELAY_MS = 50;

const INCOMPLETE_WORD_MANIFEST: ParadisOfficeCompletenessManifest = Object.freeze({
	expectedParts: 1, visitedParts: 0, parsedParts: 0, opaqueParts: 0, failedParts: 0, omittedParts: 0,
	expectedSemanticUnits: 1, visitedSemanticUnits: 0, terminal: false,
});

export function isParadisWordV1Enabled(configuration: ParadisOfficeRuntimeConfiguration): boolean {
	return configuration.engine !== 'legacy' && configuration.platformBackend && configuration.semanticWord;
}

export function createParadisWordSourceDescriptor(resource: URI, side?: 'original' | 'modified'): ParadisOfficeSourceDescriptor {
	const kind: ParadisOfficeSourceDescriptor['kind'] = resource.scheme === Schemas.vscodeRemote
		? 'remote'
		: resource.scheme === 'git'
			? 'gitCommit'
			: resource.scheme === Schemas.untitled
				? 'untitled'
				: side === 'modified'
					? 'workingTree'
					: 'file';
	return { kind, uri: resource.toString(true), displayName: basename(resource), ...(side ? { side } : {}) };
}

/** Bounded compatibility projection used only when the semantic print callback is unavailable. */
export function createLegacyWordPrintModel(title: string, placeholders: readonly ParadisOfficePlaceholder[], outline?: IParadisDocxOutline): ParadisOfficePrintModel {
	const contentPlaceholder: ParadisOfficePlaceholder | undefined = outline ? undefined : {
		nodeId: 'legacy-word-content',
		feature: 'word.legacyProjection',
		reason: 'notEvaluated',
		title: localize('paradis.word.printContentPlaceholder', "Word 文書の内容"),
		detail: localize('paradis.word.printContentPlaceholderDetail', "従来の表示方法では文字情報を取り出せないため、印刷内容は代替のコンテンツとして表示します。"),
	};
	const retainedPlaceholders = [...placeholders, ...(contentPlaceholder ? [contentPlaceholder] : [])];
	const items: ParadisOfficeWordPrintItem[] = outline
		? outline.blocks.map(block => ({
			kind: 'block',
			block: {
				kind: 'text',
				nodeId: `legacy-word:block:${block.index}`,
				runs: block.runs.length ? block.runs.map(run => ({ text: run.text })) : [{ text: block.text }],
			},
		}))
		: [];
	const model = createParadisOfficeWordPrintModel({
		title,
		sections: [{ nodeId: 'legacy-word:section:0', widthPoints: 612, heightPoints: 792, items, placeholders: retainedPlaceholders }],
	});
	const approximationWarnings = [...model.approximationWarnings, {
		code: 'word.legacyPrintProjection',
		message: localize('paradis.word.legacyPrintProjection', "印刷には、範囲を限定した従来の表示方法を使用します。"),
	}];
	if (outline?.truncated) {
		approximationWarnings.push({
			code: 'word.legacyPrintLimit',
			message: localize('paradis.word.legacyPrintLimit', "互換表示の印刷内容は途中までしか含まれていません。"),
		});
	}
	return { ...model, approximationWarnings };
}

function snapshotWordRuntimeConfiguration(configurationService: IConfigurationService): ParadisOfficeRuntimeConfiguration {
	const reader: ParadisOfficeConfigurationReader = {
		getValue: <T>(key: string) => configurationService.getValue<T>(key),
		inspect: <T>(key: string) => configurationService.inspect<T>(key) as IConfigurationValue<T> | undefined,
	};
	return snapshotParadisOfficeRuntimeConfiguration(reader);
}

function wordViewStateFromOptions(value: object | undefined, fallback: ParadisWordViewState): ParadisWordViewState {
	const nested = value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'viewState')
		? (value as { readonly viewState?: unknown }).viewState
		: value;
	return restoreParadisWordViewState(nested, fallback);
}

/** DOCX(Zip)の先頭ローカルファイルヘッダを検証する。 */
export function isParadisDocxHeader(bytes: Uint8Array): boolean {
	return bytes.length === DOCX_HEADER_BYTES && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function readParadisDocxHeader(fileService: IFileService, resource: URI): Promise<boolean | undefined> {
	try {
		return isParadisDocxHeader((await fileService.readFile(resource, { length: DOCX_HEADER_BYTES })).value.buffer);
	} catch {
		return undefined;
	}
}

export type ParadisDocxRenderDecision = 'rejected' | 'viewer' | 'stale';

export function getParadisDocxRenderDecision(isValid: boolean | undefined, resource: URI, currentResource: URI | undefined, generation: number, currentGeneration: number): ParadisDocxRenderDecision {
	if (generation !== currentGeneration || !isEqual(currentResource, resource)) {
		return 'stale';
	}
	return isValid === false ? 'rejected' : 'viewer';
}

export class ParadisDocxFileEditor extends EditorPane {

	static readonly ID = PARADIS_DOCX_EDITOR_ID;

	private _rootElement: HTMLElement | undefined;
	private _semanticToolbar: HTMLElement | undefined;
	private _diagnosticsElement: HTMLElement | undefined;
	private _inspectorToggle: HTMLButtonElement | undefined;
	private _inspectorPanel: HTMLElement | undefined;
	private _webviewContainer: HTMLElement | undefined;
	private _webview: IOverlayWebview | undefined;
	private _webviewSupportsRecoveryMessages = false;
	/** webview の origin の貸し出し元（service worker の登録を開き直しで増やさないため）。 */
	private readonly _originPool: ParadisWebviewOriginPool;
	private _webviewClaimed = false;
	private _editorVisible = false;
	private _currentResource: URI | undefined;
	private _renderGeneration = 0;
	private _inputEpoch = 0;
	private _disposed = false;
	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _assetSanitization = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly _changeInspector = this._register(new MutableDisposable<ParadisWordChangeInspector>());
	private readonly _findWidget = this._register(new MutableDisposable<ParadisOfficeFindWidget>());
	private _accessibility: ParadisOfficeAccessibility | undefined;
	private _assetPlaceholders: readonly ParadisOfficePlaceholder[] = [];
	private _runtimeConfiguration: ParadisOfficeRuntimeConfiguration | undefined;
	private _wordViewState: ParadisWordViewState = Object.freeze({ zoom: 1, displayMode: 'final', activeStory: 'all', categories: PARADIS_WORD_CHANGE_CATEGORIES });
	private _recoveryState: IParadisOfficeRecoveryState = createParadisOfficeRecoveryState();
	private _renderSnapshot: { readonly resource: URI; readonly inlineData: string | undefined; readonly assetPlaceholderCount: number; readonly viewState: ParadisWordViewState } | undefined;
	/**
	 * 表示の見張りと観測。
	 * 状態機械は `rendered` を受けて初めて動くので、一度も答えが来ない経路はこれでしか拾えない。
	 */
	private readonly _probe = this._register(new ParadisOfficeViewerProbe('word-view', generation => this._onRenderTimeout(generation)));
	private _recreatingForRecovery = false;

	constructor(group: IEditorGroup, sharedProcessService: ISharedProcessService, telemetryService: ITelemetryService, themeService: IThemeService, storageService: IStorageService, webviewService: IWebviewService, fileService: IFileService, layoutService: IWorkbenchLayoutService);
	constructor(group: IEditorGroup, sharedProcessService: ISharedProcessService, telemetryService: ITelemetryService, themeService: IThemeService, storageService: IStorageService, webviewService: IWebviewService, fileService: IFileService, layoutService: IWorkbenchLayoutService, configurationService: IConfigurationService);
	constructor(
		group: IEditorGroup,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly _configurationService: IConfigurationService = undefined!,
		@INativeHostService private readonly _nativeHostService: INativeHostService = undefined!,
	) {
		super(PARADIS_DOCX_EDITOR_ID, group, telemetryService, themeService, storageService);
		// ライブラリの置き場は入力に依らないので、ここで先に決めておく。開く操作が
		// 共有プロセスの応答を待たされる最悪値が、そのぶん短くなる。
		void this._resolveLibBase();
		this._originPool = ParadisWebviewOriginPool.getShared(storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._rootElement = dom.append(parent, dom.$('.paradis-docx-viewer'));
		this._rootElement.style.position = 'relative';
		this._rootElement.style.overflow = 'hidden';
		this._accessibility = this._register(new ParadisOfficeAccessibility(this._rootElement, {
			label: localize('paradis.word.viewer', "Word 文書ビューアー"),
		}));
		this._findWidget.value = new ParadisOfficeFindWidget(this._rootElement, {
			unavailableMessage: localize('paradis.word.searchUnavailableAdapter', "この形式では検索を利用できません。"),
			isActive: () => !!this._webview?.isFocused,
		});
		this._semanticToolbar = dom.append(this._rootElement, dom.$('.paradis-word-semantic-toolbar'));
		this._semanticToolbar.setAttribute('role', 'toolbar');
		this._semanticToolbar.setAttribute('aria-label', localize('paradis.word.toolbar', "Word 文書のツールバー"));
		this._semanticToolbar.style.position = 'absolute';
		this._semanticToolbar.style.inset = '0 0 auto 0';
		this._semanticToolbar.style.minHeight = '32px';
		this._semanticToolbar.style.zIndex = '10';
		this._semanticToolbar.style.display = 'none';
		this._semanticToolbar.style.alignItems = 'center';
		this._semanticToolbar.style.gap = '8px';
		this._semanticToolbar.style.padding = '2px 8px';
		this._semanticToolbar.style.background = 'var(--vscode-editor-background)';
		this._diagnosticsElement = dom.append(this._semanticToolbar, dom.$('.paradis-word-diagnostics-host'));
		this._inspectorToggle = dom.append(this._semanticToolbar, dom.$('button.paradis-word-inspector-toggle')) as HTMLButtonElement;
		this._inspectorToggle.type = 'button';
		this._inspectorToggle.textContent = localize('paradis.word.inspector', "変更点");
		this._accessibility.labelButton(this._inspectorToggle, localize('paradis.word.inspector', "変更点"));
		this._inspectorToggle.setAttribute('aria-expanded', 'false');
		this._register(dom.addDisposableListener(this._inspectorToggle, dom.EventType.CLICK, () => {
			if (!this._inspectorPanel || !this._inspectorToggle) {
				return;
			}
			const visible = this._inspectorPanel.style.display === 'none';
			this._inspectorPanel.style.display = visible ? 'block' : 'none';
			this._inspectorToggle.setAttribute('aria-expanded', String(visible));
		}));
		this._inspectorPanel = dom.append(this._rootElement, dom.$('.paradis-word-inspector-panel'));
		this._inspectorPanel.style.position = 'absolute';
		this._inspectorPanel.style.top = '36px';
		this._inspectorPanel.style.right = '8px';
		this._inspectorPanel.style.zIndex = '20';
		this._inspectorPanel.style.width = '360px';
		this._inspectorPanel.style.maxHeight = '70%';
		this._inspectorPanel.style.overflow = 'auto';
		this._inspectorPanel.style.background = 'var(--vscode-editorWidget-background)';
		this._inspectorPanel.style.display = 'none';
		// overlay webview を重ねる位置合わせ用アンカー（paradisPdfFileEditor と同方式）。
		this._webviewContainer = dom.append(this._rootElement, dom.$('.paradis-docx-viewer-webview'));
		this._webviewContainer.setAttribute('role', 'region');
		this._webviewContainer.setAttribute('aria-label', localize('paradis.word.documentContent', "Word 文書の内容"));
		this._webviewContainer.style.position = 'absolute';
		this._webviewContainer.style.inset = '0';
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		const invocationEpoch = ++this._inputEpoch;
		const previousInput = this._input;
		const previousOptions = this._options;
		const previousDocumentUrl = this._documentUrl;
		// 配信先はここで決めておく（描画経路で待つと追い越し制御の順序が変わる）。失敗しても
		// 従来の webview リソース経路に倒れるだけなので、結果は見ずに済ませる。
		if (input instanceof ParadisDocxInput && input.resource) {
			const resource = input.resource;
			await this._resolveLibBase();
			const documentUrl = this._canServe(resource) ? await resolveParadisViewerDocumentUrl(this._sharedProcessService, resource) : undefined;
			if (this._canServe(resource) && documentUrl === undefined) {
				// 文書だけ載らなかった。この webview の作り方では読めないので、以後サーバを使わない。
				this._documentServeFailed = true;
			}
			// **エポックで守ること。** 追い越された古い入力の URL を後から代入すると、
			// 新しく開いたファイルの位置に前のファイルが表示される。
			if (invocationEpoch !== this._inputEpoch) {
				return;
			}
			this._documentUrl = documentUrl;
		}
		await super.setInput(input, options, context, token);
		if (this._disposed || invocationEpoch !== this._inputEpoch) {
			return;
		}
		if (token.isCancellationRequested) {
			this._input = previousInput;
			this._options = previousOptions;
			this._documentUrl = previousDocumentUrl;
			return;
		}

		const resource = (input as ParadisDocxInput).resource;
		this._runtimeConfiguration = this._configurationService ? snapshotWordRuntimeConfiguration(this._configurationService) : undefined;
		// 母数は「利用者が1つの文書を開いた」回数。同じ文書ならタブを往復しても増えない。
		this._probe.beginOpen(input.resource?.toString() ?? '', this._diagnosticEngine());

		this._wordViewState = wordViewStateFromOptions(options?.viewState, this._currentWordViewState());
		this._clearSemanticUi();
		this._currentResource = resource;
		this._recoveryState = beginParadisOfficeRecovery(this._recoveryState, {
			source: { mode: 'document', source: createParadisWordSourceDescriptor(resource) },
			viewState: {
				zoom: this._wordViewState.zoom,
				displayMode: this._wordViewState.displayMode,
				activeStory: this._wordViewState.activeStory,
				categories: [...this._wordViewState.categories],
				...(this._wordViewState.selectedChangeId ? { selectedChangeId: this._wordViewState.selectedChangeId } : {}),
			},
		}).state;

		const store = new DisposableStore();
		this._inputDisposables.value = store;
		let watchInvalidationGeneration: number | undefined;
		const rerenderScheduler = store.add(new RunOnceScheduler(() => {
			const expectedGeneration = watchInvalidationGeneration;
			watchInvalidationGeneration = undefined;
			if (expectedGeneration === this._renderGeneration && isEqual(this._currentResource, resource) && this._webviewClaimed) {
				if (this._webview && !this._webviewSupportsRecoveryMessages) {
					// Legacy overlays cannot acknowledge a renderer probe. Keep their existing
					// preflight concurrency and let _renderGeneration fence stale completions.
					this._renderResource(resource);
					return;
				}
				const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'watchChanged' });
				this._recoveryState = transition.state;
				this._applyRecoveryEffects(transition.effects, resource);
			}
		}, DOCX_WATCH_RERENDER_DELAY_MS));
		const scheduleWatchRerender = () => {
			if (!isEqual(this._currentResource, resource) || !this._webviewClaimed) {
				return;
			}
			watchInvalidationGeneration = this._renderGeneration;
			if (!rerenderScheduler.isScheduled()) {
				rerenderScheduler.schedule();
			}
		};

		// ディスク上の .docx が差し替わったら表示中なら再レンダリングする。
		try {
			const watcher = this._fileService.createWatcher(resource, { recursive: false, excludes: [] });
			store.add(watcher);
			store.add(watcher.onDidChange(e => {
				if (e.contains(resource)) {
					scheduleWatchRerender();
				}
			}));
		} catch {
			// watcher が作れなくても表示は継続できる。
		}

		if (this._webviewClaimed) {
			this._renderResource(resource);
		}
		this._updateWebviewPlacement();
	}

	/**
	 * 同梱ライブラリの置き場。**ペインにつき一度だけ**決める（アプリの中にあるので入力に依らない）。
	 * 文書の URL は入力ごとに解決する（使い回されるペインで焼き付けると、2件目に1件目が出る）。
	 *
	 * 解決は**描画経路からは待たない。** 描画の入口で待つと、そこにある世代・エポックによる
	 * 追い越し制御の順序が変わってしまう（実際にテストが落ちた）。入力を受け取った時点と
	 * placement から先に決めておき、描画中は結果を同期で読むだけにする。
	 */
	private _libBase: Promise<string | undefined> | undefined;
	private _libBaseResolved = false;
	private _resolvedLibBase: string | undefined;
	/** いまの webview を作ったときに service worker を切ったか。要否が変わったら作り直す。 */
	private _webviewServiceWorkerDisabled = false;
	/** 入力ごとに解決した文書の URL（配信サーバから出せないときは undefined）。 */
	private _documentUrl: string | undefined;
	/** webview とその貸し出し origin。作り直せるようにまとめて捨てられる形で持つ。 */
	private readonly _webviewStore = this._register(new MutableDisposable<DisposableStore>());

	private async _resolveLibBase(): Promise<string | undefined> {
		this._libBase ??= resolveParadisViewerLibBase(this._sharedProcessService, FileAccess.asFileUri(DOCX_MEDIA_ROOT));
		const libBase = await this._libBase;
		this._resolvedLibBase = libBase;
		this._libBaseResolved = true;
		return libBase;
	}

	/**
	 * 文書だけ載せられなかったことがあるか。
	 *
	 * ライブラリは載ったが文書の mount だけ失敗すると、「service worker を切った webview に、
	 * service worker でしか解決できない URL を渡す」状態になり、ライブラリすら読めなくなる。
	 * **真偽値を毎回計算し直すと placement 側（文書 URL を知らない）と食い違って作り直しが
	 * 往復する**ので、一度失敗したらラッチして以後はサーバを使わない。
	 */
	private _documentServeFailed = false;

	/** このリソースを配信サーバから出せるか（ライブラリを載せられて、文書が手元にある）。 */
	private _canServe(resource: URI): boolean {
		return !!this._resolvedLibBase && !this._documentServeFailed && resource.scheme === Schemas.file;
	}

	private _disposeWebview(): void {
		if (this._webview && this._webviewClaimed) {
			this._webview.release(this);
		}
		this._webviewClaimed = false;
		this._webview = undefined;
		this._webviewSupportsRecoveryMessages = false;
		this._webviewStore.clear();
	}

	// ── 表示失敗の観測 ────────────────────────────────────────────────────

	/** Sentry へ載せる、いま有効な処理エンジン。設定が読めない間は既定側に倒す。 */
	private _diagnosticEngine(): ParadisOfficeDiagnosticEngine {
		return this._runtimeConfiguration?.engine === 'legacy' || !this._runtimeConfiguration ? 'legacy' : 'v1';
	}

	/**
	 * 予算内に描き終わりが来なかった。作り直し→作り直し→エラー表示の決まった順で畳ませる。
	 * **ここでは送らない**（途中経過を送るとレートリミットの枠を使い切る）。送るのは終端だけ。
	 */
	private _onRenderTimeout(generation: number): void {
		const resource = this._currentResource;
		if (!resource) {
			return;
		}
		// 時間切れにしたのに読み出しが走り続けていると、遅れて届いた結果が古い世代で
		// setHtml され、画面は出るのに状態機械は `loading` に取り残される。経路を1本に畳む。
		this._assetSanitization.value?.cancel();
		const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'renderTimedOut', generation });
		if (transition.effects.length === 0) {
			// 状態機械が受理しなかった時計。原因として記録すると、後で起きる本当の失敗の
			// 理由が `timeout` に置き換わってしまう。
			return;
		}
		this._probe.noteAcceptedTimeout();
		this._recoveryState = transition.state;
		this._applyRecoveryEffects(transition.effects, resource);
	}

	private _finishRecoveryWithoutProbe(recoveryGeneration: number): void {
		this._probe.disarmFor(recoveryGeneration);
		const transition = reduceParadisOfficeRecovery(this._recoveryState, {
			type: 'rendered', generation: recoveryGeneration, hasExpectedRoot: true,
		});
		if (transition.state.phase === 'ready') {
			this._probe.noteSuccess();
		}
		this._recoveryState = transition.state;
		if (this._currentResource) {
			this._applyRecoveryEffects(transition.effects, this._currentResource);
		}
	}

	private _onRecoveryMessage(message: unknown): void {
		if (!message || typeof message !== 'object') {
			return;
		}
		const candidate = message as { readonly type?: unknown; readonly generation?: unknown; readonly hasExpectedRoot?: unknown; readonly action?: unknown };
		if (candidate.type === 'paradisOfficeRecovery' && typeof candidate.generation === 'number' && typeof candidate.hasExpectedRoot === 'boolean') {
			// **いま待っている世代の応答だけが見張りを解ける。** 読み直しをまたいで届いた
			// 古い応答で解くと、新しい世代が無防備になり、そちらが黙っても誰も気づかない。
			this._probe.disarmFor(candidate.generation);
			if (!candidate.hasExpectedRoot) {
				// 白紙も梯子を1周ぶん進める。ここで記録しないと `attempt` の意味が
				// 時間切れ経路とずれる（同じ3周でも 4 と 1 になる）。
				this._probe.note({ cause: 'blank', stage: 'render' });
			}
			const transition = reduceParadisOfficeRecovery(this._recoveryState, {
				type: 'rendered', generation: candidate.generation, hasExpectedRoot: candidate.hasExpectedRoot,
			});
			if (transition.state.phase === 'ready') {
				this._probe.noteSuccess();
			}
			this._recoveryState = transition.state;
			if (this._currentResource) {
				this._applyRecoveryEffects(transition.effects, this._currentResource);
			}
			return;
		}
		if (candidate.type !== 'paradisOfficeRecoveryAction' || typeof candidate.action !== 'string' || !this._currentResource) {
			return;
		}
		if (candidate.action === 'retry') {
			// 再試行は新しい1回。前回送った記録を畳んでおかないと、また失敗しても無言になる。
			this._probe.beginRetry();
			const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'retry' });
			this._recoveryState = transition.state;
			this._applyRecoveryEffects(transition.effects, this._currentResource);
		} else if (candidate.action === 'openExternally') {
			void this._nativeHostService?.openExternal(this._currentResource.toString(true));
		}
	}

	private _applyRecoveryEffects(effects: readonly ParadisOfficeRecoveryEffect[], resource: URI): void {
		for (const effect of effects) {
			switch (effect.type) {
				case 'load':
					this._renderResource(resource, effect.generation);
					break;
				case 'remount':
					if (!this._mountRenderSnapshot(effect.generation)) {
						this._escalateUnmountable(effect.generation, resource);
					}
					break;
				case 'recreate':
					this._disposeWebview();
					this._recreatingForRecovery = true;
					this._updateWebviewPlacement();
					this._recreatingForRecovery = false;
					if (!this._mountRenderSnapshot(effect.generation)) {
						this._escalateUnmountable(effect.generation, resource);
					}
					break;
				case 'restore':
					// 直前に確定していた表示を戻すだけの経路。ラダーの一部ではない
					// （状態は `loading` ではないので、進めようとしても状態機械が無視する）。
					this._mountRenderSnapshot(effect.generation);
					break;
				case 'showError':
					this._probe.disarm();
					// 梯子を使い切った終端。ここが利用者の見る失敗なので、溜めた観測を1件だけ送る。
					// 原因は既に記録済み（白紙も時間切れも観測した場所で1件ずつ積んである）。
					this._probe.reportFailure();
					this._webview?.setHtml(applyParadisOfficeWebviewAccessibility(this._buildBlankFileHtml()));
					break;
			}
		}
	}

	/**
	 * 解析済みの中身を webview へ載せ直す。**載せる素材が無ければ `false`**。
	 *
	 * 素材が入るのは読み出しが成功した後だけなので、「読み出しが返ってこないまま時間切れ」の
	 * 場合はここへ来ても何もできない。呼び出し側はその場合ラダーを1段進めること。黙って戻ると
	 * 状態は `loading` のまま誰も次を蹴らず、**再試行の導線にも到達しない永久停止になる**。
	 */
	private _mountRenderSnapshot(recoveryGeneration: number): boolean {
		const snapshot = this._renderSnapshot;
		if (!snapshot || !isEqual(snapshot.resource, this._currentResource) || !this._webviewClaimed) {
			return false;
		}
		this._webview?.setHtml(applyParadisOfficeWebviewAccessibility(this._buildHtml(
			snapshot.resource,
			snapshot.inlineData,
			snapshot.assetPlaceholderCount,
			snapshot.viewState,
			recoveryGeneration,
		)));
		this._probe.armRender(recoveryGeneration);
		return true;
	}

	/**
	 * 作り直す素材が無かったときに、ラダーを1段進めて最終的にエラー表示まで落とす。
	 * 深さは retryCount が2で頭打ちになるぶんだけなので、高々3段で必ず止まる。
	 *
	 * ここも梯子の1周なので観測を1つ積む。積まないと `attempt` が実際に試した回数より
	 * 少なく出て、「1回目で必ず落ちるのか、作り直しで直ることがあるのか」が読めなくなる。
	 */
	private _escalateUnmountable(recoveryGeneration: number, resource: URI): void {
		this._probe.noteAcceptedTimeout();
		const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'renderTimedOut', generation: recoveryGeneration });
		this._recoveryState = transition.state;
		this._applyRecoveryEffects(transition.effects, resource);
	}

	private _ensureWebview(resource: URI): IOverlayWebview {
		const wantsServiceWorkerDisabled = this._canServe(resource);
		if (this._webview && this._webviewServiceWorkerDisabled !== wantsServiceWorkerDisabled) {
			// 生成時オプションなので、要否が変わったら作り直すしかない（別のファイルを開いたとき等）。
			this._disposeWebview();
		}
		if (this._webview) {
			return this._webview;
		}
		const store = new DisposableStore();
		this._webviewStore.value = store;
		this._webviewServiceWorkerDisabled = wantsServiceWorkerDisabled;
		// origin を渡さないと webview ごとに新しい service worker 登録が増え、二度と消えない。
		const originLease = store.add(this._originPool.acquire(PARADIS_DOCX_EDITOR_ID));
		const webview = this._webviewService.createWebviewOverlay({
			origin: originLease.origin,
			title: undefined,
			options: {
				purpose: WebviewContentPurpose.CustomEditor,
				enableFindWidget: false,
				tryRestoreScrollPosition: true,
				// 非表示になるたびに service worker 登録からやり直すと、白紙で止まる窓が毎回でき直す
				// （paradisRenderedFileEditor.ts と同じ「間欠的に白紙になる」フィールド報告の主因）。
				// 生かしたまま隠すことでその窓を無くす。
				retainContextWhenHidden: true,
				// ローカルサーバから配れるなら service worker は要らない（60秒待ちの経路に入らない）。
				disableServiceWorker: wantsServiceWorkerDisabled
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: this._localResourceRoots(resource)
			},
			extension: undefined
		});
		this._webview = webview;
		store.add(webview);
		this._webviewSupportsRecoveryMessages = typeof webview.onMessage === 'function';
		if (this._webviewSupportsRecoveryMessages) {
			store.add(webview.onMessage(event => this._onRecoveryMessage(event.message)));
		}
		return webview;
	}

	private _localResourceRoots(resource: URI): URI[] {
		return [dirname(resource), FileAccess.asFileUri(DOCX_MEDIA_ROOT)];
	}

	protected _renderResource(resource: URI, recoveryGeneration = this._recoveryState.generation): void {
		this._assetPlaceholders = [];
		const generation = ++this._renderGeneration;
		const inputEpoch = this._inputEpoch;
		this._assetSanitization.value?.cancel();
		const source = new CancellationTokenSource(); this._assetSanitization.value = source;
		// ヘッダーの下読み・本体の読み出し・消毒も返ってこないことがある区間なので、ここから見張る。
		this._probe.armSource(recoveryGeneration);
		void this._renderResourceAfterPreflight(resource, generation, inputEpoch, recoveryGeneration, source.token);
	}

	private async _renderResourceAfterPreflight(resource: URI, generation: number, inputEpoch: number, recoveryGeneration: number, token: CancellationToken): Promise<void> {
		const webview = this._ensureWebview(resource);
		// `_ensureWebview` は要否が変わると webview を捨てるので、claim を取り戻しておく
		// （PDF と同じ。setInput の呼び出し順に頼らない）。
		this._updateWebviewPlacement();
		webview.contentOptions = {
			allowScripts: true,
			localResourceRoots: this._localResourceRoots(resource)
		};
		const isValid = await readParadisDocxHeader(this._fileService, resource);
		let decision = getParadisDocxRenderDecision(isValid, resource, this._currentResource, generation, this._renderGeneration);
		if (decision === 'stale' || inputEpoch !== this._inputEpoch || !this._webviewClaimed || token.isCancellationRequested) {
			// **何も走らせずに戻るので、見張りも解くこと。** 残すと、走っていない読み込みが
			// 予算切れで時間切れ扱いになり、作り直しの梯子が空回りする。
			this._probe.disarm();
			return;
		}
		let inlineData: string | undefined;
		// 図形の取り出しは本文表示より後にやる(表示を待たせない)。
		let overlaySource: Uint8Array | undefined;
		if (decision === 'viewer') {
			try {
				const content = await this._fileService.readFile(resource, { limits: { size: PARADIS_DOCX_MAX_BYTES } });
				this._probe.setBytes(content.value.byteLength);
				const sanitized = await sanitizeParadisDocxBytesForRenderer(content.value.buffer, `docx_${generation}`, token);
				inlineData = encodeBase64(VSBuffer.wrap(sanitized.bytes));
				this._assetPlaceholders = sanitized.placeholders;
				overlaySource = sanitized.bytes;
			} catch (error) {
				// 理由を覚えておく。この先 `rejected` として画面に出るときに、これが原因欄になる
				// （記録しないと「読めなかった」だけが残り、なぜ読めなかったのかが失われる）。
				this._probe.note({ cause: 'source', stage: 'source', error });
				if (isValid === undefined && this._recoveryState.committed) {
					// 直前の表示が残っているので利用者には失敗が見えない。監視の再読み込みを待つ。
					this._probe.disarm();
					const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'sourceUnavailable', generation: recoveryGeneration });
					this._recoveryState = transition.state;
					// Keep the previously committed webview DOM mounted until the correlated watcher sees the file again.
					return;
				}
				decision = 'rejected';
			}
			if (generation !== this._renderGeneration || inputEpoch !== this._inputEpoch || !this._webviewClaimed) {
				return;
			}
		}
		switch (decision) {
			case 'rejected':
				// **記録があるときだけ送る。** ここへ来る経路は意味が正反対の2つがあり、
				// 「ヘッダーが .docx ではなかった」は拡張子だけ .docx の別形式を開いただけの
				// 通常操作。これを失敗として送ると、正常系でレート枠を食い潰し、以後10分間
				// この面の**本物の失敗が無言で落ちる**。読み出しが例外で落ちた場合だけ、
				// その理由が catch で記録されているので、それが原因欄になって送られる。
				this._probe.reportFailure();
				webview.setHtml(applyParadisOfficeWebviewAccessibility(this._buildRejectedFileHtml()));
				// A rejected-file page has no renderer root probe, but it is still a completed load.
				this._finishRecoveryWithoutProbe(recoveryGeneration);
				return;
			case 'viewer':
				this._renderSnapshot = {
					resource, inlineData, assetPlaceholderCount: this._assetPlaceholders.length,
					viewState: this._currentWordViewState(),
				};
				webview.setHtml(applyParadisOfficeWebviewAccessibility(this._buildHtml(resource, inlineData, this._assetPlaceholders.length, this._renderSnapshot.viewState, recoveryGeneration)));
				this._renderSemanticUi();
				// 表示を出したあとで図形を作り、出来たものだけ webview へ送る。
				// 途中で別の文書へ切り替わったら送らない(古い文書の図が残らないようにする)。
				if (overlaySource) {
					this._deliverWordObjects(webview, overlaySource, generation, inputEpoch, token);
				}
				// Older/fake overlay implementations do not expose messages. Preserve their
				// established watcher lifecycle while modern overlays report the real probe.
				if (!this._webviewSupportsRecoveryMessages) {
					this._finishRecoveryWithoutProbe(recoveryGeneration);
				} else {
					// 応答を待つのはこの経路だけ。応答を返さない webview まで見張ると、
					// 既に畳んだ読み込みを時間切れで作り直してしまう。
					this._probe.armRender(recoveryGeneration);
				}
				return;
		}
	}

	private _currentWordViewState(): ParadisWordViewState {
		return this._changeInspector.value?.getViewState() ?? this._wordViewState;
	}

	private _clearSemanticUi(): void {
		this._changeInspector.clear();
		this._findWidget.value?.setSearchProvider(undefined, localize('paradis.word.searchDisabledOrUnavailable', "この文書では検索を利用できません。"));
		if (this._diagnosticsElement) {
			dom.clearNode(this._diagnosticsElement);
		}
		if (this._semanticToolbar) {
			this._semanticToolbar.style.display = 'none';
		}
		if (this._inspectorPanel) {
			dom.clearNode(this._inspectorPanel);
			this._inspectorPanel.style.display = 'none';
		}
		if (this._inspectorToggle) {
			this._inspectorToggle.setAttribute('aria-expanded', 'false');
		}
		if (this._webviewContainer) {
			this._webviewContainer.style.top = '0';
		}
	}

	private _renderSemanticUi(): void {
		const configuration = this._runtimeConfiguration;
		if (!configuration) {
			this._clearSemanticUi();
			return;
		}
		const v1Enabled = isParadisWordV1Enabled(configuration);
		const callbacks = createParadisOfficeSearchPrintCallbacks(configuration, v1Enabled, {
			search: () => undefined,
			print: () => async () => {
				const model = createLegacyWordPrintModel(basename(this._currentResource ?? URI.file('document.docx')), this._assetPlaceholders);
				const result = await printParadisOfficeModelInBrowser(model, this.window);
				return withParadisOfficePrintResult(model, result);
			},
		});
		if (!v1Enabled) {
			this._clearSemanticUi();
			return;
		}
		this._findWidget.value?.setSearchProvider(callbacks.search, callbacks.print
			? localize('paradis.word.searchUnavailableAdapter', "この形式では検索を利用できません。")
			: localize('paradis.word.searchDisabled', "検索は設定で無効になっています。"));
		if (this._semanticToolbar) {
			this._semanticToolbar.style.display = 'flex';
		}
		if (this._webviewContainer) {
			this._webviewContainer.style.top = '36px';
		}
		const coverages: ParadisOfficeRenderCoverage[] = ['approximated', ...this._assetPlaceholders.map(() => 'placeholder' as const)];
		if (this._diagnosticsElement) {
			renderWordDiagnosticsRibbon(this._diagnosticsElement, {
				outcome: 'degraded',
				coverages,
				warnings: [{
					code: 'word.legacyProjection',
					message: localize('paradis.word.legacyProjection', "この形式では詳細な解析に対応していないため、従来の表示方法で開いています。"),
				}],
			});
		}
		if (!this._inspectorPanel || !this._inspectorToggle) {
			return;
		}
		this._inspectorToggle.style.display = '';
		dom.clearNode(this._inspectorPanel);
		const inspector = new ParadisWordChangeInspector(this._inspectorPanel, {
			searchUnavailable: callbacks.print
				? localize('paradis.word.searchUnavailableAdapter', "この形式では検索を利用できません。")
				: localize('paradis.word.searchDisabled', "検索は設定で無効になっています。"),
			...(callbacks.print ? {
				getPrintModel: callbacks.print,
			} : { printUnavailable: localize('paradis.word.printDisabled', "印刷プレビューは設定で無効になっています。") }),
			onDidChangeViewState: state => {
				const changed = state.zoom !== this._wordViewState.zoom || state.displayMode !== this._wordViewState.displayMode;
				this._wordViewState = state;
				if (changed && this._currentResource && this._webviewClaimed) {
					const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'watchChanged' });
					this._recoveryState = transition.state;
					this._applyRecoveryEffects(transition.effects, this._currentResource);
				}
			},
		});
		this._changeInspector.value = inspector;
		inspector.setViewState(this._wordViewState);
		inspector.setComparison([], INCOMPLETE_WORD_MANIFEST, 'degraded');
		inspector.setPlaceholders(this._assetPlaceholders);
	}

	private _buildRejectedFileHtml(): string {
		return '<!DOCTYPE html><html><body>Word 文書を表示できませんでした: ファイルが空または破損しています</body></html>';
	}

	private _buildBlankFileHtml(): string {
		const nonce = generateUuid();
		return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}';"></head><body>
			<p>Word 文書の表示結果が空でした。</p>
			<button id="retry" type="button">再試行</button>
			<button id="open" type="button">既定のアプリで開く</button>
			<script nonce="${nonce}">
				const vscode = acquireVsCodeApi();
				document.getElementById('retry').addEventListener('click', () => vscode.postMessage({ type: 'paradisOfficeRecoveryAction', action: 'retry' }));
				document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'paradisOfficeRecoveryAction', action: 'openExternally' }));
			</script>
		</body></html>`;
	}

	/**
	 * docx-preview が描かない図形(グラフ・SmartArt・図形・テキストボックス)を SVG にして webview へ送る。
	 *
	 * 本文の表示より後に走らせる。zip の再展開と XML 走査はレンダラのメインスレッドで動くので、
	 * 表示の前に待つと、悪意あるファイル1つでウィンドウ全体が固まる。
	 * 送る直前に世代を確認し、別の文書へ切り替わっていたら捨てる。
	 */
	private async _deliverWordObjects(webview: IOverlayWebview, bytes: Uint8Array, generation: number, inputEpoch: number, token: CancellationToken): Promise<void> {
		const isCurrent = () => generation === this._renderGeneration && inputEpoch === this._inputEpoch
			&& this._webviewClaimed && !token.isCancellationRequested;
		try {
			const parts = await readWordRenderablePackageParts(bytes, token);
			if (parts.size === 0 || !isCurrent()) {
				return;
			}
			const objects = extractParadisWordRenderableObjects({ parts, token });
			if (objects.length === 0 || !isCurrent()) {
				return;
			}
			// 表示中の文書とは別の切り離した Document 上で組み立て、本文の DOM に触れないようにする。
			const scratch = dom.getWindow(this._webviewContainer).document.implementation.createHTMLDocument('');
			const items = buildParadisWordOverlayItems(objects, scratch);
			if (items.length === 0 || !isCurrent()) {
				return;
			}
			webview.postMessage({ type: 'paradisWordObjects', items });
		} catch {
			// 図形が出ないだけで本文の表示には影響しないので、黙って諦める。
		}
	}

	private _buildHtml(resource: URI, inlineData?: string, assetPlaceholderCount = 0, viewState: ParadisWordViewState = this._wordViewState, recoveryGeneration = this._recoveryState.generation): string {
		// 配信サーバを使うかどうかは webview の作り方と揃える。片方だけサーバにすると、
		// service worker を切った webview に解決できない URL を渡すことになる。
		const served = this._webviewServiceWorkerDisabled && this._documentUrl !== undefined;
		const nonce = generateUuid();
		const remoteInfo = resource.scheme === Schemas.vscodeRemote ? { isRemote: true, authority: resource.authority } : undefined;
		const docxUrl = inlineData
			? `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${inlineData}`
			: (served ? this._documentUrl! : asWebviewUri(resource, remoteInfo).toString(true));
		const libBase = served && this._resolvedLibBase ? this._resolvedLibBase : asWebviewUri(FileAccess.asFileUri(DOCX_MEDIA_ROOT)).toString(true);
		// CSP は実際に使うポートまで絞る（`http://127.0.0.1:*` だと他プロセスのサーバまで許してしまう）。
		const serverOrigin = served ? paradisPreviewOrigins(libBase, docxUrl) : '';
		const csp = serverOrigin
			? buildParadisOfficeWordCsp(nonce, { kind: 'mountedLoopback', origins: serverOrigin.split(' ') })
			: buildParadisOfficeWordCsp(nonce, {
				kind: 'webviewResource',
				cspSources: [
					paradisOfficeWebviewResourceOrigin(libBase),
					...(docxUrl.startsWith('data:') ? [] : [paradisOfficeWebviewResourceOrigin(docxUrl)]),
				],
			});
		const zoom = Math.min(4, Math.max(0.25, viewState.zoom));
		const displayMode = viewState.displayMode;

		// CSP: スクリプトは nonce 付き inline と webview リソース(https:)のみ。docx-preview が本文中に
		// 埋め込む style は要素インライン + 動的 <style> なので style-src に 'unsafe-inline' を許可する
		// （docx-preview は文書ごとに動的生成する CSS を nonce 無しの <style> で挿入するため）。img は
		// 埋め込み画像の blob:/data: を許可。connect-src は .docx 本体の fetch のため webview リソースを許可。
		return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<!-- style-src: docx-preview は文書の見た目（フォント/色/罫線/numbering等)のほぼ全てを
	document.createElement('style') による動的な <style> 要素(nonce無し)として注入する。
	CSPの style-src は「nonce-source が1つでもあると 'unsafe-inline' は無視される」という
	後方互換ルールがあるため、nonce と unsafe-inline を併記しても nonce の無い動的 style は
	ブロックされる(sheet=null になり書式が丸ごと無効化される)。ここでは nonce を使わず
	'unsafe-inline' のみを指定し、docx-preview 由来のスタイルも含めて確実に適用させる。 -->
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<style nonce="${nonce}">
		/* docx-preview はページ要素(section.docx)に「width(=ページ幅) + padding(=左右余白)」を設定する
		("createPageElement": ignoreWidth未指定時に r.style.width = pageSize.width、余白は paddingLeft/Right)。
		これは box-sizing:border-box（余白がwidthに含まれる = 用紙の外形がpageSize通りになる）を前提にした値であり、
		既定の content-box のままだと「width + 左右padding」が単純加算されて実際の用紙が
		本来より左右合計の余白分だけ横に広がってしまう（例: A4 + 上下左右1inch余白で約35%増）。
		これが原因で用紙自体が過大サイズになり、テーブルが本来収まる余地まではみ出しやすくなっていた。 */
		*, *::before, *::after { box-sizing: border-box; }
		html, body { margin: 0; padding: 0; height: 100%; }
		body {
			background-color: var(--vscode-editor-background);
			font-family: var(--vscode-font-family);
			font-size: 13px;
		}
		#scroller { position: absolute; inset: 0; overflow: auto; }
		#content { padding: 32px 16px 48px; display: flex; flex-direction: column; align-items: center; zoom: ${zoom}; }
		body.paradis-word-original ins { display: none; }
		body.paradis-word-original del { text-decoration: none; }
		body.paradis-word-final del { display: none; }
		/* docx-preview のページ要素（.docx-wrapper > section.docx）に PDF ビューア風の白紙＋影を付ける。 */
		#content .docx-wrapper { background: transparent; padding: 0; display: flex; flex-direction: column; align-items: center; gap: 16px; }
		/* allow-any-unicode-next-line */
		/* docx-preview が空のまま残した図形の枠へ、こちらで描いた SVG を敷く。 */
		.paradis-word-object-slot > svg { display: block; width: 100%; height: 100%; overflow: visible; color: #333333; }
		.paradis-word-chart-bar { opacity: 0.85; }
		#content .docx-wrapper > section.docx {
			background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.35); margin: 0;
			/* ページ基準(mso-position-*-relative:page)で絶対配置されるVML図形(斜線コネクタ等)の
			基準点をこのページ要素にする。これが無いと絶対配置の基準が祖先側に逃げてしまい、
			ページ座標で指定された図形が別ページの内容の上に描かれる。 */
			position: relative;
			/* Word の実書式は「明示的な色指定が無い文字は黒」が既定。この既定を app のエディタ配色
			（var(--vscode-editor-foreground)、ダークテーマでは白紙上でほぼ読めない薄色になる）に
			委ねてしまわないよう、用紙自体に黒を明示する。docx-preview は色指定のある文字だけ
			個別に(インラインstyleで)色を上書きするため、そちらは引き続き優先される。 */
			color: #000;
		}
		/* table-layout:fixed の表（幅固定）で、折り返し不可能な内容（プレースホルダ変数名等の
		連続した英数字トークン）がセル幅を超えると、既定では折り返されずセルの外・隣接セルの
		上にオーバーフローして重なって表示されてしまう。fixedレイアウトは「列幅は固定するが、
		中身は溢れさせない」という直感的な挙動を期待されるため、必ず折り返して高さ側に逃がす。 */
		#content table td, #content table th { overflow-wrap: break-word; }
		#status { position: absolute; top: 45%; width: 100%; text-align: center; opacity: .75; }
	</style>
</head>
<body class="paradis-word-${displayMode}">
	${assetPlaceholderCount > 0 ? `<div role="status" id="asset-placeholders">Office assets unavailable: ${assetPlaceholderCount}</div>` : ''}
	<div id="scroller"><div id="content"></div></div>
	<div id="status">読み込み中…</div>
	<script nonce="${nonce}" src="${libBase}/jszip.min.js"></script>
	<script nonce="${nonce}" src="${libBase}/docx-preview.min.js"></script>
	<script nonce="${nonce}">
		(async () => {
			const vscode = acquireVsCodeApi();
			const DOCX_URL = ${JSON.stringify(docxUrl)};
			// docx-preview が描かない図形(グラフ・SmartArt 等)。本文表示のあとに送られてくる。
			let PARADIS_WORD_OBJECTS = [];
			let paradisDocumentRendered = false;
			// 差し込みの本体は描画完了後に入れ替える。受け取りだけ先に構えておく
			// (送信は本文表示の直後に来るので、リスナーが後だと取りこぼす)。
			let placeParadisWordObjects = () => { };
			window.addEventListener('message', event => {
				const message = event.data;
				if (!message || message.type !== 'paradisWordObjects' || !Array.isArray(message.items)) {
					return;
				}
				PARADIS_WORD_OBJECTS = message.items;
				placeParadisWordObjects();
			});
			const statusEl = document.getElementById('status');
			const contentEl = document.getElementById('content');
			try {
				if (!window.docx || !window.JSZip) {
					throw new Error('レンダリングライブラリの読み込みに失敗しました');
				}
				const buf = await (await fetch(DOCX_URL)).arrayBuffer();
				const renderDocument = () => window.docx.renderAsync(buf.slice(0), contentEl, undefined, {
					className: 'docx',
					inWrapper: true,
					ignoreWidth: false,
					ignoreHeight: false,
					breakPages: true,
					// docx-preview は明示的な改ページ(<w:br type="page">)にしか反応せず、
					// 文中の折返しによる自動改ページの計算(テキストレイアウトエンジン)を持たない。
					// 唯一の代替情報が w:lastRenderedPageBreak — Word がその文書を最後に保存した
					// 時点の実際のページ割りを記録したキャッシュで、docx-preview はこれを改ページとして
					// 扱う実装を持つが既定では無視する(ignoreLastRenderedPageBreak の既定値は true)。
					// 明示的な改ページが無い文書(実務でよくある複数ページの契約書・重説等)がまるごと
					// 1ページの巨大な連続体として描画されてしまっていたため、明示的に false にして
					// このキャッシュ値を改ページとして使う(内容編集後は古い値になり得るが、
					// 明示的な改ページが無い以上、実際のWordのページ割りに最も近づく唯一の手段)。
					ignoreLastRenderedPageBreak: false,
					// タブストップの実座標計算を有効にする(docx-preview の「experimental」機能だが
					// 実体はタブ位置の計算+リーダー線の描画で、これが無いとタブが単なる全角空白1つに
					// なり、目次の「見出し……ページ番号」のような右揃えタブ+点線リーダーが、
					// 左詰め+リーダー無しのレイアウト崩れとして描かれる)。
					experimental: true,
					renderHeaders: true,
					renderFooters: true,
					renderFootnotes: true,
					renderEndnotes: true,
					useBase64URL: true,
					// Raw embedded fonts stay outside the legacy renderer. Safe WOFF2 subsets are supplied
					// only by the typed Office asset path, so this view deliberately uses fallback fonts.
					ignoreFonts: true,
					// Arbitrary altChunk HTML is represented by a semantic placeholder, never an iframe.
					renderAltChunks: false,
					renderChanges: ${displayMode !== 'final'}
				});
				await renderDocument();
				vscode.postMessage({
					type: 'paradisOfficeRecovery',
					generation: ${recoveryGeneration},
					hasExpectedRoot: !!contentEl.querySelector('.docx-wrapper > section.docx')
				});
				// docx-preview はページ幅を固定値(width、grow不可)で設定する一方、高さは
				// min-height(可変)にしている。本文（表など）がページの本文幅より広い場合、
				// 高さと違って幅は伸びず、白紙の外へそのままはみ出して背後の(暗い)背景が
				// 直接見えてしまう。各ページを実際のコンテンツ幅に合わせて伸ばし、はみ出し分も
				// 白紙の中に収める（ページ自体を「用紙が足りない分だけ大きい用紙」にする）。
				for (const section of contentEl.querySelectorAll('.docx-wrapper > section.docx')) {
					const needed = section.scrollWidth;
					if (needed > section.clientWidth) {
						section.style.width = needed + 'px';
					}
				}
				// docx-preview はグラフ・SmartArt・図形を描かないが、その drawing の枠は残す。
				// 枠には wp:docPr@id を出させてあるので(vendored docx-preview へのパッチ)、
				// その値だけで対応づけて SVG を流し込む。出現順には頼らない。
				placeParadisWordObjects = () => {
					if (!paradisDocumentRendered || !Array.isArray(PARADIS_WORD_OBJECTS) || PARADIS_WORD_OBJECTS.length === 0) {
						return;
					}
					// 同じ id の枠が複数あるのは正常(ヘッダーの図はページごとに複製される)。
					// その全部へ同じ図を描く。
					const byDrawingId = new Map();
					for (const item of PARADIS_WORD_OBJECTS) {
						if (!item.drawingId) {
							continue;
						}
						// 同じ id の図が複数ある文書は曖昧なので、その id はまとめて描かない。
						byDrawingId.set(item.drawingId, byDrawingId.has(item.drawingId) ? null : item);
					}
					let placed = 0;
					for (const slot of contentEl.querySelectorAll('[data-paradis-drawing-id]')) {
						const item = byDrawingId.get(slot.getAttribute('data-paradis-drawing-id'));
						if (!item || slot.childElementCount > 0) {
							continue;
						}
						slot.classList.add('paradis-word-object-slot');
						slot.setAttribute('data-paradis-object-kind', item.kind);
						slot.innerHTML = item.svg;
						placed++;
					}
					vscode.postMessage({ type: 'paradisWordObjects', expected: PARADIS_WORD_OBJECTS.length, placed });
				};
				paradisDocumentRendered = true;
				placeParadisWordObjects();
				// Word の「箇条書き」既定スタイルは通常 Symbol/Wingdings フォントの専用コードポイント
				// (Private Use Area、例: bullet は U+F0B7) で記号を描画する。実機のWordがあるWindows/Mac
				// にはこれらのフォントが入っているため正しく見えるが、Symbol/Wingdingsを持たない環境
				// （本アプリのElectron/Chromiumなど）では該当グリフが無く豆腐(□)になる。
				// font-family が Symbol 系のルールに限定し、既知の主要コードポイントだけ
				// 環境非依存の標準Unicode記号へ差し替える（該当しないものは元のまま＝現状維持）。
				const SYMBOL_FONT_GLYPH_MAP = {
					'\uF0B7': '\u2022', // Symbol: bullet -> •
					'\uF0A7': '\u25AA', // Symbol: black small square -> ▪
					'\uF0E0': '\u2192', // Symbol: arrow -> →
					'\uF0FC': '\u2713', // Wingdings: check -> ✓
					'\uF06C': '\u25CF', // Wingdings: solid circle -> ●
				};
				const symbolGlyphClass = '[' + Object.keys(SYMBOL_FONT_GLYPH_MAP).join('') + ']';
				// test 用(g無し)と replace 用(g付き)を分ける。同一パターンに g を付けて
				// 両方に使い回すと、test() が lastIndex を持ち越して次回以降の判定を誤る罠がある。
				const symbolGlyphPattern = new RegExp(symbolGlyphClass);
				const symbolGlyphReplaceAll = new RegExp(symbolGlyphClass, 'g');
				// 注意: このコードは TypeScript のテンプレートリテラル(_buildHtmlの戻り値文字列)に
				// 埋め込まれた「webview内で実行されるJS文字列」であり、外側のテンプレートリテラルの
				// 文字列パース時に \s のような「正規表現専用の無効なエスケープシーケンス」は
				// バックスラッシュごと消えて s のような裸の文字になってしまう(実際にこれで
				// \s* が s* に化けて全く別の意味の正規表現になるバグを踏んだ)。ここでは
				// \\s のように二重にエスケープし、生成されるJS文字列側で正しく \s が残るようにする。
				const symbolFontPattern = /font-family:\\s*[^;]*(?:symbol|wingdings|webdings)/i;
				for (const styleEl of document.querySelectorAll('style')) {
					const text = styleEl.textContent;
					if (!text || !symbolGlyphPattern.test(text)) {
						continue;
					}
					// ルールブロック(selector { ... })単位で処理し、そのブロックに Symbol/Wingdings 系の
					// font-family が含まれる場合だけ content: "..." 内の該当コードポイントを置換する
					// (content と font-family の宣言順序はどちらが先でも良いようブロック全体を見る)。
					const patched = text.replace(/[^{}]+\\{[^{}]*\\}/g, block => {
						if (!symbolFontPattern.test(block)) {
							return block;
						}
						return block.replace(/(content:\\s*")([^"]*)(")/gi,
							(all, before, glyphs, after) => before + glyphs.replace(symbolGlyphReplaceAll, ch => SYMBOL_FONT_GLYPH_MAP[ch] ?? ch) + after);
					});
					if (patched !== text) {
						styleEl.textContent = patched;
					}
				}
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
		if (!this._webview && !this._libBaseResolved) {
			// 配信先が決まる前に作ると service worker の要否を間違える。**ここで自分で解決を蹴ること。**
			// 描画側に任せると、描画は claim 済みでないと走らないので、初回は誰も蹴らずに白紙のまま止まる。
			void this._resolveLibBase().then(() => this._updateWebviewPlacement());
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
		if (justClaimed && !this._recreatingForRecovery) {
			this._renderResource(resource);
		}
	}

	override clearInput(): void {
		this._probe.endOpen();
		this._assetSanitization.value?.cancel();
		this._inputEpoch++;
		this._inputDisposables.clear();
		this._clearSemanticUi();
		this._currentResource = undefined;
		this._runtimeConfiguration = undefined;
		this._renderSnapshot = undefined;
		this._recoveryState = createParadisOfficeRecoveryState();
		if (this._webview && this._webviewClaimed) {
			this._webview.release(this);
			this._webviewClaimed = false;
		}
		super.clearInput();
	}

	override getViewState(): object | undefined {
		if (!this._currentResource) {
			return undefined;
		}
		return {
			source: createParadisWordSourceDescriptor(this._currentResource),
			viewState: this._currentWordViewState(),
		};
	}

	override dispose(): void {
		this._assetSanitization.value?.cancel();
		this._disposed = true;
		this._inputEpoch++;
		this._currentResource = undefined;
		super.dispose();
	}

	protected override setEditorVisible(visible: boolean): void {
		if (visible !== this._editorVisible) {
			this._editorVisible = visible;
			if (!visible) {
				// 非表示になると webview の貸し出しを返すので、描き終わりは**原理的に来ない**。
				// 見張ったままにすると、裏に置いただけの表示が時間切れとして扱われる。
				// 表示に戻ると claim し直して読み込みからやり直すので、そこで張り直る。
				this._probe.disarm();
			}
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
