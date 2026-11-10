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
import { disposableTimeout, RunOnceScheduler } from '../../../../base/common/async.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../base/common/network.js';
import { basename, dirname, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService, type IConfigurationValue } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { readParadisFileHead } from '../../../../platform/files/common/paradisReadFileHead.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ParadisOverlayWebviewPane } from '../browser/paradisOverlayWebviewPane.js';
import { paradisPreviewOrigins, resolveParadisViewerLibBase } from './paradisViewerAssets.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IOverlayWebview, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { extractParadisWordRenderableObjects } from '../common/word/paradisWordRenderableExtractor.js';
import type { ParadisWordRenderableObject } from '../common/word/paradisWordRenderableObjects.js';
import { readWordRenderablePackageParts } from '../browser/word/paradisWordPackageParts.js';
import { buildParadisWordOverlayItems } from './word/paradisWordObjectOverlayHtml.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ParadisDocxInput } from './paradisDocxInput.js';
import { PARADIS_DOCX_EDITOR_ID } from '../browser/paradisFileViewers.js';
import { ParadisOfficeAccessibility, applyParadisOfficeWebviewAccessibility } from '../browser/paradisOfficeAccessibility.js';
import { ParadisOfficeFindWidget } from '../browser/paradisOfficeFindWidget.js';
import { PARADIS_DOCX_MAX_BYTES, type IParadisDocxOutline } from '../common/paradisDocx.js';
import { createParadisOfficeSearchPrintCallbacks, snapshotParadisOfficeRuntimeConfiguration, type ParadisOfficeConfigurationReader, type ParadisOfficeRuntimeConfiguration } from '../common/paradisOfficeCapabilities.js';
import { createParadisOfficeWordPrintModel, type ParadisOfficeWordPrintItem } from '../common/paradisOfficePrint.js';
import { buildParadisOfficeWordCsp, paradisOfficeBrokenImagePlaceholderSvg, paradisOfficeWebviewResourceOrigin } from '../common/paradisOfficeSanitizer.js';
import type { ParadisOfficeCompletenessManifest, ParadisOfficePlaceholder, ParadisOfficePrintModel, ParadisOfficeSearchResult, ParadisOfficeSourceDescriptor } from '../common/paradisOfficeProtocol.js';
import { PARADIS_WEBVIEW_HOST_MESSAGE_CHECK } from '../common/paradisWebviewHostMessage.js';
import { beginParadisOfficeRecovery, createParadisOfficeRecoveryState, reduceParadisOfficeRecovery, type IParadisOfficeRecoveryState, type ParadisOfficeRecoveryEffect } from '../common/paradisOfficeRecovery.js';
import { IParadisViewerOpenTiming, startParadisViewerOpenTiming } from '../common/paradisViewerOpenTiming.js';
import type { IParadisShownDocument } from '../common/paradisViewerShownDocument.js';
import { ParadisOfficeViewerProbe } from '../common/paradisOfficeProbe.js';
import { ParadisOfficeOpenCache, readParadisOfficeFile } from '../common/paradisOfficeOpenCache.js';
import type { ParadisOfficeDiagnosticEngine } from '../common/paradisOfficeDiagnostics.js';
import { PARADIS_DOCX_MEDIA_ROOT, sanitizeParadisDocxBytesForRenderer } from './word/paradisDocxSanitize.js';
import { escape } from '../../../../base/common/strings.js';
import { localize } from '../../../../nls.js';
import { PARADIS_WORD_CHANGE_CATEGORIES, ParadisWordChangeInspector, paradisWordStoryLabel, paradisWordExclusionItems, restoreParadisWordViewState, wordChangeText, type ParadisWordNavigationTarget, type ParadisWordViewState } from './word/paradisWordChangeInspector.js';
import { EMPTY_PARADIS_WORD_PACKAGE_EXCLUSIONS, paradisWordPackageExclusions, renderWordSemanticRibbon, summarizeParadisWordBlockedParts, wordSemanticFailureMessage, type ParadisWordPackageExclusions, type ParadisWordSemanticRibbonState } from './word/paradisWordDiagnostics.js';
import { analyzeParadisWordDocument, extractParadisWordRenderableObjectsInWorker } from './word/paradisWordSemanticClient.js';
import { PARADIS_WORD_ANCHOR_RUNTIME, PARADIS_WORD_ANCHOR_STYLE } from './word/paradisWordAnchorRuntime.js';
import { alignParadisWordParagraphs, type IParadisWordParagraphOutline } from '../common/word/paradisWordRenderOutline.js';
import { ParadisOfficeSemanticSearch } from '../common/paradisOfficeSearch.js';
import type { IParadisWordAnalysis, IParadisWordAnalysisResult, IParadisWordRenderableObjectsResult } from '../common/word/paradisWordSemanticSummary.js';
import type { ParadisWordStoryKind } from '../common/word/paradisWordSemantic.js';
import { printParadisOfficeModelInBrowser, withParadisOfficePrintResult } from './paradisOfficePrintService.js';
import { PARADIS_VIEWER_WEBVIEW_STATE_STYLE, paradisViewerWebviewFailureHtml, paradisViewerWebviewFailureScript, paradisViewerWebviewStatusHtml } from '../common/paradisViewerWebviewState.js';
import { appendParadisViewerToolbarGroup, appendParadisViewerToolbarIconButton, appendParadisViewerToolbarPanelToggle, appendParadisViewerToolbarPercent, appendParadisViewerToolbarSeparator, createParadisViewerToolbar, PARADIS_VIEWER_TOOLBAR_HEIGHT, setParadisViewerToolbarHeight } from '../browser/paradisViewerToolbar.js';
import { PARADIS_OFFICE_CHANGE_PANEL_CLASS, PARADIS_OFFICE_PANEL_SURFACE_CLASS } from './paradisOfficeInspectorParts.js';

const DOCX_HEADER_BYTES = 4;
const DOCX_WATCH_RERENDER_DELAY_MS = 50;

/** Word 単体が、戻ったときに描き直さないために覚えておく記録（{@link IParadisShownDocument} に Word の欄を足したもの）。 */
type IParadisDocxShownDocument = IParadisShownDocument<IOverlayWebview> & {
	readonly recoveryGeneration: number;
	readonly rendered: boolean;
	readonly objectsSettled: boolean;
	readonly assetPlaceholderCount: number;
	readonly bytes: number;
	readonly placeholders: readonly ParadisOfficePlaceholder[];
	readonly exclusions: ParadisWordPackageExclusions;
	readonly paragraphs: Record<string, string[]> | undefined;
};

/** 覚えておく 1 件分。消毒した文書と、その後の処理（図形・詳しい解析）に渡すバイト列。 */
interface IParadisDocxOpenCacheValue {
	/** 元のファイルの中身（詳しい解析に渡す）。 */
	readonly source: Uint8Array;
	/** 消毒した文書（表示のために webview へ渡し、図形の取り出しにも渡す）。 */
	readonly sanitized: Uint8Array;
	readonly placeholders: readonly ParadisOfficePlaceholder[];
	readonly exclusions: ParadisWordPackageExclusions;
}

/**
 * 消毒した文書を、ウィンドウにつき 1 つ覚えておく。タブを戻したとき・表示の切り替え（倍率・表示モード）で
 * 描き直すときに、読み込みと消毒を省く。文書は小さい（無圧縮で中央値 120 KB ほど）ので、最近の 8 件まで、
 * 合計 48 MiB まで。Word のタブがどれも何も表示しなくなって 10 分たったら全部手放す。
 */
const DOCX_OPEN_CACHE = new ParadisOfficeOpenCache<IParadisDocxOpenCacheValue>({ maxEntries: 8, maxBytes: 48 * 1024 * 1024, idleMs: 10 * 60 * 1000 });

const INCOMPLETE_WORD_MANIFEST: ParadisOfficeCompletenessManifest = Object.freeze({
	expectedParts: 1, visitedParts: 0, parsedParts: 0, opaqueParts: 0, failedParts: 0, omittedParts: 0,
	expectedSemanticUnits: 1, visitedSemanticUnits: 0, terminal: false,
});

/** 混み合っていて解析できなかったときに、頼み直すまでの時間と回数。 */
export const PARADIS_WORD_SEMANTIC_BUSY_RETRY_MS = 5_000;
export const PARADIS_WORD_SEMANTIC_BUSY_RETRIES = 3;

/** ツールバーが 1 行のときの高さ。まだ描かれていなくて高さが測れないときに使う。 */
const PARADIS_WORD_TOOLBAR_MIN_OFFSET = PARADIS_VIEWER_TOOLBAR_HEIGHT;

/** バーの拡大縮小の 1 段の倍率と範囲（文書の描画が受け付ける 0.25〜4 倍）。 */
const PARADIS_WORD_ZOOM_STEP = 1.2;
const PARADIS_WORD_ZOOM_MIN = 0.25;
const PARADIS_WORD_ZOOM_MAX = 4;

/** 解析が最後まで通った文書の、文書内の変更履歴とコメントの一覧の完全さ。 */
function analyzedWordManifest(analysis: IParadisWordAnalysis): ParadisOfficeCompletenessManifest {
	const parts = analysis.counts.parts;
	return {
		expectedParts: parts.expected, visitedParts: parts.visited, parsedParts: parts.parsed, opaqueParts: 0, failedParts: 0,
		omittedParts: analysis.changesTruncated ? 1 : 0,
		expectedSemanticUnits: analysis.changes.length, visitedSemanticUnits: analysis.changes.length, terminal: !analysis.changesTruncated,
	};
}

/** 表示中の文書の中で、検索結果や変更の位置を探すための手がかり（段落の文字と、その中で強調する文字）。 */
export interface ParadisWordRevealRequest {
	readonly type: 'paradisWordReveal';
	readonly context: string;
	readonly focus: string;
	/** context のうち focus より前の文字。同じ文字が段落に何度も出るときの取り違えを防ぐ。 */
	readonly prefix?: string;
	readonly matchCase: boolean;
	/** 表示の中に見つからなかったときに出す文。 */
	readonly notFound?: string;
	/** 対応の取れた表示の段落の目印。あればその段落の中だけを探す。 */
	readonly marker?: string;
}

/** 検索結果から、webview で位置を探すための手がかりを作る。 */
export function createParadisWordSearchReveal(result: ParadisOfficeSearchResult, matchCase: boolean): ParadisWordRevealRequest {
	return { type: 'paradisWordReveal', context: `${result.preview.before}${result.preview.match}${result.preview.after}`, focus: result.preview.match, prefix: result.preview.before, matchCase };
}

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

/** webview が報告した表示の段落ごとの文字。形と大きさを確かめてから受け取る。 */
export function acceptRenderedParagraphs(value: unknown): Record<string, string[]> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	// 鍵は文書の部品名から来るので、`__proto__` などで既定の性質を書き換えられないよう素の入れ物にする。
	const result: Record<string, string[]> = Object.create(null);
	let total = 0;
	for (const [key, texts] of Object.entries(value as Record<string, unknown>)) {
		if (key.length > 1024 || !Array.isArray(texts) || texts.length > 100_000) {
			return undefined;
		}
		const owned: string[] = [];
		for (const text of texts) {
			const string = typeof text === 'string' ? text : '';
			total += string.length;
			owned.push(string);
		}
		if (total > 16 * 1024 * 1024) {
			return undefined;
		}
		result[key] = owned;
	}
	return result;
}

/** 同じ中身かどうか（同じ中身を描き直しただけなら解析を頼み直さないために使う）。 */
export function equalParadisWordBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left === right) {
		return true;
	}
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) {
			return false;
		}
	}
	return true;
}

/** DOCX(Zip)の先頭ローカルファイルヘッダを検証する。 */
export function isParadisDocxHeader(bytes: Uint8Array): boolean {
	return bytes.length === DOCX_HEADER_BYTES && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function readParadisDocxHeader(fileService: IFileService, resource: URI): Promise<boolean | undefined> {
	try {
		return isParadisDocxHeader((await readParadisFileHead(fileService, resource, { length: DOCX_HEADER_BYTES })).value.buffer);
	} catch {
		return undefined;
	}
}

/**
 * Word の worker で図形を取り出した結果から、次にすることを決める。`worker`: その結果を使う。`none`: 図形を出さない
 * （上限を超える文書。renderer で取り出すとウィンドウが固まる）。`cancelled`: 取り消された。`renderer`: worker を使えなかった
 * （つながらない・落ちた・混んでいる・期限切れ）ので renderer で取り出す。
 */
export function paradisWordObjectsAfterWorker(result: IParadisWordRenderableObjectsResult | undefined, cancelled: boolean): 'worker' | 'none' | 'cancelled' | 'renderer' {
	if (result?.ok) {
		return 'worker';
	}
	if (cancelled || result?.code === 'cancelled') {
		return 'cancelled';
	}
	return result?.code === 'tooLarge' ? 'none' : 'renderer';
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
	/**
	 * overlay webview（作り方・配置・同梱ライブラリの置き場と、戻ったときに描き直さないための記録は部品が持つ）。
	 * 記録（`shown`）は webview に残っている文書と、そこから作った状態。タブを離れると clearInput を通るので、入力ではなく
	 * ペインに持つ。同じ消毒結果（キャッシュの同じ etag）・同じ倍率と表示モードへ戻ったときは描き直さない。
	 * `confirmed` は描き終わりの応答（rendered）と図形の送り終わりの両方が揃ってから立てる。
	 * **文書の中身（元の docx・消毒結果）は持たない。** 使い回すときはキャッシュから引く（キャッシュが捨てたら使い回さない）。
	 */
	private readonly _pane: ParadisOverlayWebviewPane<IParadisDocxShownDocument>;
	private _webviewSupportsRecoveryMessages = false;
	private _editorVisible = false;
	private _currentResource: URI | undefined;
	private _renderGeneration = 0;
	private _inputEpoch = 0;
	private _disposed = false;
	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _assetSanitization = this._register(new MutableDisposable<CancellationTokenSource>());
	/** 文書を表示しているあいだ、覚えておいた消毒済みの文書を手放させない。 */
	private readonly _openCacheLease = this._register(new MutableDisposable());
	/** 開いてから文書が描かれるまでの計測（`setInput` で始め、最初に描けたら送る）。 */
	private readonly _openTiming = this._register(new MutableDisposable<IParadisViewerOpenTiming>());
	/** いま開いている文書の大きさ（計測に添える）。 */
	private _openBytes = 0;
	private readonly _changeInspector = this._register(new MutableDisposable<ParadisWordChangeInspector>());
	private readonly _findWidget = this._register(new MutableDisposable<ParadisOfficeFindWidget>());
	private _accessibility: ParadisOfficeAccessibility | undefined;
	private _assetPlaceholders: readonly ParadisOfficePlaceholder[] = [];
	/** 描画用のパッケージから外した部品（無視したもの・安全のために外したもの）。 */
	private _packageExclusions: ParadisWordPackageExclusions = EMPTY_PARADIS_WORD_PACKAGE_EXCLUSIONS;
	/** 詳しい解析（shared process）。表示を出した後に裏で走らせ、表示は待たせない。 */
	private readonly _semanticRequest = this._register(new MutableDisposable<CancellationTokenSource>());
	/** 混み合っていて解析できなかったときの、頼み直しの予約。 */
	private readonly _semanticRetry = this._register(new MutableDisposable());
	private _semanticRetries = 0;
	/** 混み合って断られた中身。違う中身を頼むときに、頼み直しの回数を数え直すために覚える。 */
	private _semanticBusyBytes: Uint8Array | undefined;
	/** リボンのボタンのリスナー。描き直すたびに外す。 */
	private readonly _ribbonDisposables = this._register(new DisposableStore());
	private readonly _openAppDisposables = this._register(new MutableDisposable<DisposableStore>());
	private _zoomPercent: HTMLButtonElement | undefined;
	private _openAppElement: HTMLElement | undefined;
	private _semanticBytes: Uint8Array | undefined;
	private _semanticResult: IParadisWordAnalysisResult | undefined;
	private _semanticSearch: ParadisOfficeSemanticSearch | undefined;
	private _semanticSearchHandle = 0;
	private _findMatchCase = false;
	/** いま表示している docx-preview の段落ごとの文字（webview が描いた後に報告する）。 */
	private _renderedParagraphs: Record<string, string[]> | undefined;
	/** 解析結果の段落の位置 → 表示の段落の目印。 */
	private _markerByLocator: Map<string, string> | undefined;
	private _runtimeConfiguration: ParadisOfficeRuntimeConfiguration | undefined;
	private _wordViewState: ParadisWordViewState = Object.freeze({ zoom: 1, displayMode: 'final', activeStory: 'all', categories: PARADIS_WORD_CHANGE_CATEGORIES });
	private _recoveryState: IParadisOfficeRecoveryState = createParadisOfficeRecoveryState();
	private _renderSnapshot: { readonly resource: URI; readonly sanitized: Uint8Array | undefined; readonly assetPlaceholderCount: number; readonly viewState: ParadisWordViewState } | undefined;
	/**
	 * いまのページに渡す消毒済みの文書。ページが受け口を用意したと知らせたら（`paradisWordDocumentReady`）、写しを
	 * transfer 付きで送る（HTML に base64 で埋めない）。ページが読み直されても送り直せるよう、次に描くまで持つ。
	 */
	private _pendingDocument: { readonly id: string; readonly resource: URI; readonly webview: IOverlayWebview; readonly bytes: Uint8Array } | undefined;

	/**
	 * 表示の見張りと観測。
	 * 状態機械は `rendered` を受けて初めて動くので、一度も答えが来ない経路はこれでしか拾えない。
	 */
	private readonly _probe = this._register(new ParadisOfficeViewerProbe('word-view', generation => this._onRenderTimeout(generation)));
	private _recreatingForRecovery = false;

	constructor(
		group: IEditorGroup,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
	) {
		super(PARADIS_DOCX_EDITOR_ID, group, telemetryService, themeService, storageService);
		this._pane = this._register(new ParadisOverlayWebviewPane<IParadisDocxShownDocument>(this, {
			originKey: PARADIS_DOCX_EDITOR_ID,
			enableFindWidget: false,
			allowScripts: true,
			resolveLibBase: () => resolveParadisViewerLibBase(this._sharedProcessService, FileAccess.asFileUri(PARADIS_DOCX_MEDIA_ROOT)),
			onDidCreate: (webview, store) => {
				this._webviewSupportsRecoveryMessages = typeof webview.onMessage === 'function';
				if (this._webviewSupportsRecoveryMessages) {
					store.add(webview.onMessage(event => this._onRecoveryMessage(event.message)));
				}
			},
			onDidDispose: () => {
				this._webviewSupportsRecoveryMessages = false;
				this._pendingDocument = undefined;
			},
			reportFatalErrorAs: PARADIS_DOCX_EDITOR_ID,
		}, webviewService, layoutService, storageService));
		// ライブラリの置き場は入力に依らないので、ここで先に決めておく。開く操作が
		// 共有プロセスの応答を待たされる最悪値が、そのぶん短くなる。
		void this._pane.resolveLibBase();
	}

	protected override createEditor(parent: HTMLElement): void {
		// タブを閉じたら、戻るための記録と描画を捨てる。
		this._register(this.group.onDidCloseEditor(e => {
			if (e.editor instanceof ParadisDocxInput) {
				// 戻るために残していた描画（docx-preview の DOM）も捨てる。閉じた後まで抱えない。
				this._pane.clearContentFor(e.editor.resource);
				// ページへ送るために覚えていた消毒済みの文書も手放す。
				if (this._pendingDocument && isEqual(this._pendingDocument.resource, e.editor.resource)) {
					this._pendingDocument = undefined;
				}
			}
		}));
		this._rootElement = dom.append(parent, dom.$('.paradis-docx-viewer'));
		this._rootElement.style.position = 'relative';
		this._rootElement.style.overflow = 'hidden';
		this._accessibility = this._register(new ParadisOfficeAccessibility(this._rootElement, {
			label: localize('paradis.word.viewer', "Word 文書ビューアー"),
		}));
		this._findWidget.value = new ParadisOfficeFindWidget(this._rootElement, {
			unavailableMessage: localize('paradis.word.searchUnavailableAdapter', "この形式では検索を利用できません。"),
			isActive: () => !!this._pane.webview?.isFocused,
			onNavigate: result => this._postReveal(createParadisWordSearchReveal(result, this._findMatchCase), result.navigableAnchor),
		});
		// 全ビューア共通のバー。解析の結果（リボン）は幅が狭いと折り返すので、高さは中身に合わせる。
		const semanticToolbar = createParadisViewerToolbar(this._rootElement, 'paradis-word-semantic-toolbar.paradis-viewer-toolbar-wrap', localize('paradis.word.toolbar', "Word 文書のツールバー"));
		this._semanticToolbar = semanticToolbar.element;
		this._semanticToolbar.style.position = 'absolute';
		this._semanticToolbar.style.inset = '0 0 auto 0';
		this._semanticToolbar.style.zIndex = '10';
		this._diagnosticsElement = dom.append(semanticToolbar.start, dom.$('.paradis-word-diagnostics-host'));
		this._diagnosticsElement.style.flex = '1 1 auto';
		this._diagnosticsElement.style.minWidth = '0';
		// 右: 変更点（解析の結果があるときだけ）｜拡大縮小｜既定のアプリで開く。
		this._inspectorToggle = appendParadisViewerToolbarPanelToggle(semanticToolbar.end, localize('paradis.word.inspector', "変更点"), Codicon.listUnordered);
		this._inspectorToggle.classList.add('paradis-word-inspector-toggle');
		this._inspectorToggle.style.display = 'none';
		appendParadisViewerToolbarSeparator(semanticToolbar.end);
		const zoom = appendParadisViewerToolbarGroup(semanticToolbar.end);
		const zoomOut = appendParadisViewerToolbarIconButton(zoom, Codicon.zoomOut, localize('paradis.word.zoomOut', "ズームアウト"));
		this._register(dom.addDisposableListener(zoomOut, dom.EventType.CLICK, () => this._setWordZoom(this._currentWordViewState().zoom / PARADIS_WORD_ZOOM_STEP)));
		this._zoomPercent = appendParadisViewerToolbarPercent(zoom, localize('paradis.word.resetZoom', "ズームをリセット"));
		this._register(dom.addDisposableListener(this._zoomPercent, dom.EventType.CLICK, () => this._setWordZoom(1)));
		const zoomIn = appendParadisViewerToolbarIconButton(zoom, Codicon.zoomIn, localize('paradis.word.zoomIn', "ズームイン"));
		this._register(dom.addDisposableListener(zoomIn, dom.EventType.CLICK, () => this._setWordZoom(this._currentWordViewState().zoom * PARADIS_WORD_ZOOM_STEP)));
		appendParadisViewerToolbarSeparator(semanticToolbar.end);
		this._openAppElement = appendParadisViewerToolbarGroup(semanticToolbar.end);
		this._accessibility.labelButton(this._inspectorToggle, localize('paradis.word.inspector', "変更点"));
		this._register(dom.addDisposableListener(this._inspectorToggle, dom.EventType.CLICK, () => {
			if (!this._inspectorPanel) {
				return;
			}
			this._setInspectorVisible(this._inspectorPanel.style.display === 'none');
		}));
		this._inspectorPanel = dom.append(this._rootElement, dom.$(`.paradis-word-inspector-panel.${PARADIS_OFFICE_PANEL_SURFACE_CLASS}.${PARADIS_OFFICE_CHANGE_PANEL_CLASS}`));
		this._inspectorPanel.style.display = 'none';
		// overlay webview を重ねる位置合わせ用アンカー（paradisPdfFileEditor と同方式）。
		this._webviewContainer = dom.append(this._rootElement, dom.$('.paradis-docx-viewer-webview'));
		this._webviewContainer.setAttribute('role', 'region');
		this._webviewContainer.setAttribute('aria-label', localize('paradis.word.documentContent', "Word 文書の内容"));
		this._webviewContainer.style.position = 'absolute';
		this._webviewContainer.style.inset = `${PARADIS_WORD_TOOLBAR_MIN_OFFSET}px 0 0 0`;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		const invocationEpoch = ++this._inputEpoch;
		// 配信先の登録を待つ時間も含めたいので、最初に始める。
		this._openTiming.value = startParadisViewerOpenTiming('word');
		this._openBytes = 0;
		const previousInput = this._input;
		const previousOptions = this._options;
		// 同梱ライブラリの置き場はここで決めておく（描画経路で待つと追い越し制御の順序が変わる）。失敗しても
		// 従来の webview リソース経路に倒れるだけなので、結果は見ずに済ませる。文書そのものは data: で渡すので配信サーバへ載せない。
		if (input instanceof ParadisDocxInput && input.resource) {
			await this._pane.resolveLibBase();
			if (invocationEpoch !== this._inputEpoch) {
				return;
			}
		}
		await super.setInput(input, options, context, token);
		if (this._disposed || invocationEpoch !== this._inputEpoch) {
			return;
		}
		if (token.isCancellationRequested) {
			this._input = previousInput;
			this._options = previousOptions;
			// 取り消された入力の計測は捨てる（残すと、前の文書の次の描画がこの時刻からの時間として送られる）。
			this._openTiming.clear();
			return;
		}

		const resource = (input as ParadisDocxInput).resource;
		this._runtimeConfiguration = snapshotWordRuntimeConfiguration(this._configurationService);
		// 母数は「利用者が1つの文書を開いた」回数。同じ文書ならタブを往復しても増えない。
		this._probe.beginOpen(input.resource?.toString() ?? '', this._diagnosticEngine());

		this._wordViewState = wordViewStateFromOptions(options?.viewState, this._currentWordViewState());
		this._clearSemanticUi();
		this._updateZoomLabel();
		this._renderOpenInApp(resource);
		if (!isEqual(this._currentResource, resource)) {
			this._resetSemanticAnalysis();
		}
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
			if (expectedGeneration === this._renderGeneration && isEqual(this._currentResource, resource) && this._pane.claimed) {
				if (this._pane.webview && !this._webviewSupportsRecoveryMessages) {
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
			if (!isEqual(this._currentResource, resource) || !this._pane.claimed) {
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
					// 変わったファイルの消毒結果は使わない（更新時刻と大きさが変わらない書き換えもあるので、etag に頼らない）。
					DOCX_OPEN_CACHE.delete(resource);
					scheduleWatchRerender();
				}
			}));
		} catch {
			// watcher が作れなくても表示は継続できる。
		}

		if (this._pane.claimed) {
			this._renderResource(resource);
		}
		this._updateWebviewPlacement();
	}

	/**
	 * 同梱ライブラリをローカルの配信サーバから出せるか（置き場を決められて、文書が手元にある）。出せるなら
	 * service worker を切った webview にする。文書は data: で渡すので、配信サーバに載せるのはライブラリだけ。
	 */
	private _canServe(resource: URI): boolean {
		return !!this._pane.libBase && resource.scheme === Schemas.file;
	}

	private _disposeWebview(): void {
		this._pane.disposeWebview();
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

	/**
	 * 残っている表示を使い回せるかを決める値。消毒結果はキャッシュの etag（変わったファイルの値は watcher が捨てる）、
	 * 表示は HTML に焼き込む倍率と表示モードだけ（変更点の選択などでは描き直さない。倍率と表示モードを変えたときも描き直している）。
	 */
	private _shownKeys(etag: string, viewState: ParadisWordViewState): readonly unknown[] {
		return [etag, viewState.zoom, viewState.displayMode];
	}

	private _noteShownRendered(recoveryGeneration: number): void {
		const shown = this._pane.shown;
		if (shown && shown.recoveryGeneration === recoveryGeneration && !shown.rendered) {
			this._pane.shown = { ...shown, rendered: true, confirmed: shown.objectsSettled };
		}
	}

	private _noteShownObjectsSettled(webview: IOverlayWebview, recoveryGeneration: number): void {
		const shown = this._pane.shown;
		if (shown && shown.webview === webview && shown.recoveryGeneration === recoveryGeneration && !shown.objectsSettled) {
			this._pane.shown = { ...shown, objectsSettled: true, confirmed: shown.rendered };
		}
	}

	/**
	 * タブへ戻ったとき、同じ文書が webview に残っていれば送り直さずに、clearInput で捨てた側の状態だけを戻す。
	 * 使い回したら `true`。図形・段落の報告は webview に残っているので、覚えておいた値を使う。
	 */
	private _reuseShownDocument(resource: URI, webview: IOverlayWebview, document: IParadisDocxOpenCacheValue, inputEpoch: number, recoveryGeneration: number): boolean {
		const shown = this._pane.shown;
		const etag = DOCX_OPEN_CACHE.get(resource)?.etag;
		const viewState = this._currentWordViewState();
		if (!shown || !etag || webview !== this._pane.webview || !this._pane.canReuseShown(resource, this._shownKeys(etag, viewState))) {
			return false;
		}
		this._assetPlaceholders = shown.placeholders;
		this._packageExclusions = shown.exclusions;
		this._renderedParagraphs = shown.paragraphs;
		this._openBytes = shown.bytes;
		this._probe.setBytes(shown.bytes);
		this._renderSnapshot = { resource, sanitized: document.sanitized, assetPlaceholderCount: shown.assetPlaceholderCount, viewState };
		this._openCacheLease.value ??= DOCX_OPEN_CACHE.acquire();
		this._pane.shown = { ...shown, recoveryGeneration };
		// 前の表示がそのまま見えている。描くのにかかった時間ではないので、開くまでの計測も使わない。
		this._openTiming.clear();
		// 回復の状態は clearInput で初めに戻っているので、描けた表示として確定させる（読めなくなったときに前の表示を残す分岐が効く）。
		this._finishRecoveryWithoutProbe(recoveryGeneration);
		this._requestSemanticAnalysis(resource, document.source, inputEpoch);
		this._renderSemanticUi();
		this._publishAnnotations();
		return true;
	}

	private _finishRecoveryWithoutProbe(recoveryGeneration: number): void {
		this._probe.disarmFor(recoveryGeneration);
		const transition = reduceParadisOfficeRecovery(this._recoveryState, {
			type: 'rendered', generation: recoveryGeneration, hasExpectedRoot: true,
		});
		if (transition.state.phase === 'ready') {
			this._probe.noteSuccess();
			this._noteShownRendered(recoveryGeneration);
		}
		this._recoveryState = transition.state;
		if (this._currentResource) {
			this._applyRecoveryEffects(transition.effects, this._currentResource);
		}
	}

	/**
	 * 検査を通ったのに描画側で読めなかった画像。webview が代わりの箱に替えたので、その枚数を代替表示に足す。
	 * いま表示している世代の知らせだけを受ける。
	 */
	private _onBrokenImages(generation: number, count: number): void {
		if (generation !== this._recoveryState.generation || !Number.isSafeInteger(count) || count < 0 || count > 256) {
			return;
		}
		const broken = Array.from({ length: count }, (_, index): ParadisOfficePlaceholder => ({
			nodeId: `broken_image_${index}`, feature: 'unsafeMedia', reason: 'unsafe', title: 'Office asset unavailable', detail: 'decode-failed',
		}));
		this._assetPlaceholders = [...this._assetPlaceholders.filter(placeholder => !placeholder.nodeId.startsWith('broken_image_')), ...broken];
		if (this._pane.shown?.recoveryGeneration === generation) {
			this._pane.shown = { ...this._pane.shown, placeholders: this._assetPlaceholders };
		}
		this._renderSemanticUi();
	}

	private _onRecoveryMessage(message: unknown): void {
		if (!message || typeof message !== 'object') {
			return;
		}
		const candidate = message as { readonly type?: unknown; readonly generation?: unknown; readonly hasExpectedRoot?: unknown; readonly action?: unknown; readonly count?: unknown; readonly stories?: unknown; readonly id?: unknown };
		if (candidate.type === 'paradisWordDocumentReady' && typeof candidate.id === 'string') {
			this._postPendingDocument(candidate.id);
			return;
		}
		if (candidate.type === 'paradisWordBrokenImages' && typeof candidate.generation === 'number' && typeof candidate.count === 'number') {
			this._onBrokenImages(candidate.generation, candidate.count);
			return;
		}
		if (candidate.type === 'paradisWordParagraphs') {
			// いま表示している世代の報告だけを使う（作り直しをまたいで届いた古い報告は、目印の番号が違いうる）。
			if (candidate.generation === this._recoveryState.generation) {
				this._renderedParagraphs = acceptRenderedParagraphs(candidate.stories);
				if (this._pane.shown?.recoveryGeneration === candidate.generation) {
					this._pane.shown = { ...this._pane.shown, paragraphs: this._renderedParagraphs };
				}
				this._publishAnnotations();
			}
			return;
		}
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
				this._noteShownRendered(candidate.generation);
				// 開いてから最初に描けたところ（2 回目以降の描き直しでは何もしない）。
				this._openTiming.value?.painted({ safe_size_kb: Math.round(this._openBytes / 1024) });
				this._openTiming.clear();
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
			void this._nativeHostService.openExternal(this._currentResource.toString(true));
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
					this._pane.shown = undefined;
					if (this._pane.webview) {
						this._pane.setDocumentHtml(this._pane.webview, resource, applyParadisOfficeWebviewAccessibility(this._buildBlankFileHtml()));
					}
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
		if (!snapshot || !isEqual(snapshot.resource, this._currentResource) || !this._pane.claimed) {
			return false;
		}
		this._renderedParagraphs = undefined;
		this._markerByLocator = undefined;
		// 載せ直した表示は、描き終わりを確かめるまで使い回さない。
		this._pane.shown = undefined;
		const webview = this._pane.webview;
		if (webview) {
			this._setDocumentPage(webview, snapshot.resource, snapshot.sanitized, snapshot.assetPlaceholderCount, snapshot.viewState, recoveryGeneration);
		}
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
		return this._pane.ensure(this._canServe(resource), this._localResourceRoots(resource));
	}

	private _localResourceRoots(resource: URI): URI[] {
		return [dirname(resource), FileAccess.asFileUri(PARADIS_DOCX_MEDIA_ROOT)];
	}

	/**
	 * @param reuseShown タブへ戻ったときの描画。同じ文書がまだ webview に残っていれば送り直さない。
	 * ファイルの変更・回復の読み直し・新しい入力では `false`（必ず描き直す）。
	 */
	protected _renderResource(resource: URI, recoveryGeneration = this._recoveryState.generation, reuseShown = false): void {
		this._assetPlaceholders = [];
		this._packageExclusions = EMPTY_PARADIS_WORD_PACKAGE_EXCLUSIONS;
		this._renderedParagraphs = undefined;
		this._markerByLocator = undefined;
		const generation = ++this._renderGeneration;
		const inputEpoch = this._inputEpoch;
		this._assetSanitization.value?.cancel();
		const source = new CancellationTokenSource(); this._assetSanitization.value = source;
		// ヘッダーの下読み・本体の読み出し・消毒も返ってこないことがある区間なので、ここから見張る。
		this._probe.armSource(recoveryGeneration);
		void this._renderResourceAfterPreflight(resource, generation, inputEpoch, recoveryGeneration, source.token, reuseShown);
	}

	private async _renderResourceAfterPreflight(resource: URI, generation: number, inputEpoch: number, recoveryGeneration: number, token: CancellationToken, reuseShown: boolean): Promise<void> {
		const webview = this._ensureWebview(resource);
		// `_ensureWebview` は要否が変わると webview を捨てるので、claim を取り戻しておく
		// （PDF と同じ。setInput の呼び出し順に頼らない）。
		this._updateWebviewPlacement();
		webview.contentOptions = {
			allowScripts: true,
			localResourceRoots: this._localResourceRoots(resource)
		};
		// ヘッダーの検査と etag 付きの本文読みを並べて出す（SSH 先で往復を直列に 2 回しない）。本文読みの失敗は
		// ここでは投げず、表示すると決まってから下で扱う（.docx でないと分かった文書の読み失敗は問わない）。
		// 表示しないと決まったら（.docx でない・古い・取り消された）本文の読みを止める。
		const bodyRead = new CancellationTokenSource(token);
		const reading = readParadisOfficeFile(this._fileService, resource, DOCX_OPEN_CACHE, PARADIS_DOCX_MAX_BYTES, bodyRead.token).then(
			read => ({ read, error: undefined }),
			(error: unknown) => ({ read: undefined, error }),
		).finally(() => bodyRead.dispose());
		const isValid = await readParadisDocxHeader(this._fileService, resource);
		let decision = getParadisDocxRenderDecision(isValid, resource, this._currentResource, generation, this._renderGeneration);
		if (decision !== 'viewer') {
			bodyRead.cancel();
		}
		if (decision === 'stale' || inputEpoch !== this._inputEpoch || !this._pane.claimed || token.isCancellationRequested) {
			bodyRead.cancel();
			// **何も走らせずに戻るので、見張りも解くこと。** 残すと、走っていない読み込みが
			// 予算切れで時間切れ扱いになり、作り直しの梯子が空回りする。自分の世代の見張りだけ解く
			// （遅れて戻った前の文書の読み込みが、次の文書の見張りを解かないように）
			this._probe.disarmFor(recoveryGeneration);
			return;
		}
		let sanitizedDocument: Uint8Array | undefined;
		// 図形の取り出しは本文表示より後にやる(表示を待たせない)。
		let overlaySource: Uint8Array | undefined;
		let semanticSource: Uint8Array | undefined;
		/** 描いた消毒結果（キャッシュの値）。戻ったときに同じ値かで、残っている表示を使えるか決める。 */
		let openedDocument: IParadisDocxOpenCacheValue | undefined;
		if (decision === 'viewer') {
			try {
				// 同じ文書を前に消毒していて、ファイルが変わっていなければ、覚えた結果を使う。
				const { read, error: readError } = await reading;
				if (read === undefined) {
					throw readError;
				}
				let document: IParadisDocxOpenCacheValue;
				if (reuseShown && read.kind === 'cached' && generation === this._renderGeneration && inputEpoch === this._inputEpoch && this._pane.claimed
					&& this._reuseShownDocument(resource, webview, read.value, inputEpoch, recoveryGeneration)) {
					return;
				}
				if (read.kind === 'cached') {
					document = read.value;
					this._probe.setBytes(document.source.byteLength);
					this._openBytes = document.source.byteLength;
				} else {
					const source = read.content.value.buffer;
					this._probe.setBytes(source.byteLength);
					this._openBytes = source.byteLength;
					const sanitized = await sanitizeParadisDocxBytesForRenderer(source, `docx_${generation}`, token);
					document = { source, sanitized: sanitized.bytes, placeholders: sanitized.placeholders, exclusions: paradisWordPackageExclusions(sanitized) };
					DOCX_OPEN_CACHE.set(resource, read.content.etag, document, source.byteLength + sanitized.bytes.byteLength);
				}
				semanticSource = document.source;
				openedDocument = document;
				sanitizedDocument = document.sanitized;
				this._assetPlaceholders = document.placeholders;
				this._packageExclusions = document.exclusions;
				overlaySource = document.sanitized;
				this._openCacheLease.value ??= DOCX_OPEN_CACHE.acquire();
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
			if (generation !== this._renderGeneration || inputEpoch !== this._inputEpoch || !this._pane.claimed) {
				return;
			}
		}
		// 覚えられなかった（大きすぎる・etag が無い）文書は使い回さない（戻ったときに引ける中身が無い）。
		const cached = openedDocument && DOCX_OPEN_CACHE.get(resource);
		const cachedEtag = cached && cached.value === openedDocument ? cached.etag : undefined;
		switch (decision) {
			case 'rejected':
				this._pane.shown = undefined;
				// **記録があるときだけ送る。** ここへ来る経路は意味が正反対の2つがあり、
				// 「ヘッダーが .docx ではなかった」は拡張子だけ .docx の別形式を開いただけの
				// 通常操作。これを失敗として送ると、正常系でレート枠を食い潰し、以後10分間
				// この面の**本物の失敗が無言で落ちる**。読み出しが例外で落ちた場合だけ、
				// その理由が catch で記録されているので、それが原因欄になって送られる。
				this._probe.reportFailure();
				this._pane.setDocumentHtml(webview, resource, applyParadisOfficeWebviewAccessibility(this._buildRejectedFileHtml()));
				// A rejected-file page has no renderer root probe, but it is still a completed load.
				this._finishRecoveryWithoutProbe(recoveryGeneration);
				return;
			case 'viewer':
				this._renderSnapshot = {
					resource, sanitized: sanitizedDocument, assetPlaceholderCount: this._assetPlaceholders.length,
					viewState: this._currentWordViewState(),
				};
				this._pane.shown = cachedEtag ? {
					resource, webview, keys: this._shownKeys(cachedEtag, this._renderSnapshot.viewState),
					confirmed: false, rendered: false, objectsSettled: !overlaySource, recoveryGeneration,
					assetPlaceholderCount: this._assetPlaceholders.length, bytes: this._openBytes,
					placeholders: this._assetPlaceholders, exclusions: this._packageExclusions, paragraphs: undefined,
				} : undefined;
				this._setDocumentPage(webview, resource, sanitizedDocument, this._assetPlaceholders.length, this._renderSnapshot.viewState, recoveryGeneration);
				// 詳しい解析は表示を出した後に頼む（表示を待たせない）。同じ中身なら頼み直さない。
				if (semanticSource) {
					this._requestSemanticAnalysis(resource, semanticSource, inputEpoch);
				}
				this._renderSemanticUi();
				// 表示を出したあとで図形を作り、出来たものだけ webview へ送る。
				// 途中で別の文書へ切り替わったら送らない(古い文書の図が残らないようにする)。
				if (overlaySource) {
					void this._deliverWordObjects(webview, overlaySource, generation, inputEpoch, token).then(settled => {
						if (settled) {
							this._noteShownObjectsSettled(webview, recoveryGeneration);
						}
					});
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

	/** バーの拡大縮小。変更点パネルの倍率と同じ状態を変え、文書を描き直す。 */
	private _setWordZoom(zoom: number): void {
		const current = this._currentWordViewState();
		const next: ParadisWordViewState = Object.freeze({ ...current, zoom: Math.min(PARADIS_WORD_ZOOM_MAX, Math.max(PARADIS_WORD_ZOOM_MIN, zoom)) });
		if (next.zoom === current.zoom) {
			return;
		}
		this._wordViewState = next;
		this._changeInspector.value?.setViewState(next);
		this._updateZoomLabel();
		if (this._currentResource && this._pane.claimed) {
			const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'watchChanged' });
			this._recoveryState = transition.state;
			this._applyRecoveryEffects(transition.effects, this._currentResource);
		}
	}

	private _updateZoomLabel(): void {
		if (this._zoomPercent) {
			this._zoomPercent.textContent = `${Math.round(this._currentWordViewState().zoom * 100)}%`;
		}
	}

	/** ローカルのファイルなら「既定のアプリで開く」を出す（入力ごとに作り直す）。 */
	private _renderOpenInApp(resource: URI): void {
		const element = this._openAppElement;
		if (!element) {
			return;
		}
		dom.clearNode(element);
		const store = new DisposableStore();
		this._openAppDisposables.value = store;
		if (resource.scheme !== Schemas.file) {
			return;
		}
		const button = appendParadisViewerToolbarIconButton(element, Codicon.linkExternal, localize('paradis.word.openInApp', "既定のアプリで開く"));
		store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => void this._nativeHostService.openExternal(resource.toString(true))));
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
		if (this._inspectorPanel) {
			dom.clearNode(this._inspectorPanel);
			this._inspectorPanel.style.display = 'none';
		}
		if (this._inspectorToggle) {
			this._inspectorToggle.setAttribute('aria-expanded', 'false');
			this._inspectorToggle.style.display = 'none';
		}
		this._syncSemanticToolbarOffset();
	}

	/**
	 * 文書の表示と変更点パネルを、ツールバーのすぐ下から始める。幅が狭いとリボンが折り返して
	 * ツールバーが高くなるので、決め打ちの高さではなく実際の高さを使う。
	 */
	private _syncSemanticToolbarOffset(): void {
		if (!this._semanticToolbar) {
			return;
		}
		const height = Math.max(PARADIS_WORD_TOOLBAR_MIN_OFFSET, this._semanticToolbar.offsetHeight);
		if (this._rootElement) {
			setParadisViewerToolbarHeight(this._rootElement, height);
		}
		const top = `${height}px`;
		if (this._webviewContainer) {
			this._webviewContainer.style.top = top;
		}
		if (this._inspectorPanel) {
			this._inspectorPanel.style.top = top;
		}
	}

	private _renderSemanticUi(): void {
		const configuration = this._runtimeConfiguration;
		if (!configuration) {
			this._clearSemanticUi();
			return;
		}
		const v1Enabled = isParadisWordV1Enabled(configuration);
		const analysis = this._semanticResult?.ok ? this._semanticResult : undefined;
		const callbacks = createParadisOfficeSearchPrintCallbacks(configuration, v1Enabled, {
			search: () => analysis && this._semanticSearch ? this._createFindProvider(this._semanticSearch) : undefined,
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
		const searchUnavailable = !callbacks.print
			? localize('paradis.word.searchDisabled', "検索は設定で無効になっています。")
			: this._semanticResult === undefined
				? localize('paradis.word.searchAnalyzing', "解析が終わると検索できます。")
				: localize('paradis.word.searchDisabledOrUnavailable', "この文書では検索を利用できません。");
		this._findWidget.value?.setSearchProvider(callbacks.search, searchUnavailable);
		if (this._semanticToolbar) {
			this._semanticToolbar.style.display = 'flex';
		}
		if (this._diagnosticsElement) {
			renderWordSemanticRibbon(this._diagnosticsElement, this._semanticRibbonState(), () => this._setInspectorVisible(true), this._ribbonDisposables);
		}
		this._syncSemanticToolbarOffset();
		if (!this._inspectorPanel || !this._inspectorToggle) {
			return;
		}
		this._inspectorToggle.style.display = '';
		const wasVisible = this._inspectorPanel.style.display !== 'none';
		dom.clearNode(this._inspectorPanel);
		const semanticSearch = this._semanticSearch;
		const inspector = new ParadisWordChangeInspector(this._inspectorPanel, {
			// 見出しの「閉じる」は帯の「変更点」と同じ開け閉めを通し、フォーカスを帯のボタンへ戻す。
			onClose: () => {
				this._inspectorToggle?.click();
				this._inspectorToggle?.focus();
			},
			...(callbacks.search && semanticSearch ? { search: query => this._searchAll(semanticSearch, query) } : { searchUnavailable }),
			...(callbacks.print ? {
				getPrintModel: callbacks.print,
			} : { printUnavailable: localize('paradis.word.printDisabled', "印刷プレビューは設定で無効になっています。") }),
			onNavigate: target => this._navigateInspectorTarget(target),
			onDidChangeViewState: state => {
				const changed = state.zoom !== this._wordViewState.zoom || state.displayMode !== this._wordViewState.displayMode;
				this._wordViewState = state;
				this._updateZoomLabel();
				if (changed && this._currentResource && this._pane.claimed) {
					const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'watchChanged' });
					this._recoveryState = transition.state;
					this._applyRecoveryEffects(transition.effects, this._currentResource);
				}
			},
		});
		this._changeInspector.value = inspector;
		inspector.setViewState(this._wordViewState);
		if (analysis) {
			inspector.setComparison(analysis.changes, analyzedWordManifest(analysis), 'complete');
		} else {
			inspector.setComparison([], INCOMPLETE_WORD_MANIFEST, 'degraded');
		}
		inspector.setPlaceholders(this._assetPlaceholders);
		inspector.setAnalysis({
			...(analysis ? { counts: analysis.counts } : {}),
			...paradisWordExclusionItems(this._packageExclusions),
			...(this._semanticResult && !this._semanticResult.ok ? { failure: localize('paradis.word.analysisFailed', "解析できませんでした: {0}", wordSemanticFailureMessage(this._semanticResult.code, this._semanticRetrying())) } : {}),
		});
		if (wasVisible) {
			this._setInspectorVisible(true);
		}
	}

	private _semanticRibbonState(): ParadisWordSemanticRibbonState {
		const alternatives = this._assetPlaceholders.length;
		const ignoredParts = this._packageExclusions.ignored.length + this._packageExclusions.ignoredOmitted;
		const blocked = summarizeParadisWordBlockedParts(this._packageExclusions);
		const extra = blocked ? { blocked } : {};
		const result = this._semanticResult;
		if (!result) {
			return { kind: 'analyzing', alternatives, ignoredParts, ...extra };
		}
		return result.ok
			? { kind: 'analyzed', counts: result.counts, alternatives, ignoredParts, ...extra }
			: { kind: 'failed', code: result.code, alternatives, ignoredParts, retrying: this._semanticRetrying(), ...extra };
	}

	private _setInspectorVisible(visible: boolean): void {
		if (!this._inspectorPanel || !this._inspectorToggle) {
			return;
		}
		this._inspectorPanel.style.display = visible ? 'block' : 'none';
		this._inspectorToggle.setAttribute('aria-expanded', String(visible));
	}

	private _resetSemanticAnalysis(): void {
		this._semanticRequest.value?.cancel();
		this._semanticRequest.clear();
		this._semanticBytes = undefined;
		this._semanticResult = undefined;
		this._semanticSearch = undefined;
		this._markerByLocator = undefined;
		this._semanticRetry.clear();
		this._semanticRetries = 0;
		this._semanticBusyBytes = undefined;
	}

	/** 混み合って解析できなかった文書を、まだ頼み直す予定があるか。 */
	private _semanticRetrying(): boolean {
		return this._semanticRetries <= PARADIS_WORD_SEMANTIC_BUSY_RETRIES;
	}

	/**
	 * shared process に詳しい解析を頼む。表示とは別の流れで、結果が来たらリボン・変更点・検索だけを
	 * 作り直す（webview には触らない）。同じ中身をもう一度描いただけ（表示の切り替えなど）なら頼み直さない。
	 */
	private _requestSemanticAnalysis(resource: URI, bytes: Uint8Array, inputEpoch: number): void {
		const configuration = this._runtimeConfiguration;
		if (!configuration || !isParadisWordV1Enabled(configuration) || !this._sharedProcessService) {
			return;
		}
		if (this._semanticBytes && equalParadisWordBytes(this._semanticBytes, bytes)) {
			return;
		}
		// 混み合って断られた中身と違う文書なら、頼み直しの回数を数え直す。
		if (this._semanticBusyBytes && !equalParadisWordBytes(this._semanticBusyBytes, bytes)) {
			this._semanticRetries = 0;
			this._semanticBusyBytes = undefined;
		}
		this._semanticRequest.value?.cancel();
		const request = new CancellationTokenSource();
		this._semanticRequest.value = request;
		this._semanticBytes = bytes;
		this._semanticResult = undefined;
		this._semanticSearch = undefined;
		const isCurrent = () => !this._disposed && inputEpoch === this._inputEpoch && isEqual(this._currentResource, resource)
			&& this._semanticBytes === bytes && !request.token.isCancellationRequested;
		void (async () => {
			let result: IParadisWordAnalysisResult;
			try {
				result = await analyzeParadisWordDocument(this._sharedProcessService, bytes, request.token);
			} catch {
				result = { ok: false, code: request.token.isCancellationRequested ? 'cancelled' : 'failed' };
			}
			if (!isCurrent()) {
				return;
			}
			this._semanticResult = result;
			if (!result.ok && result.code === 'busy') {
				// 混み合っていただけなので、覚えた中身を捨てて、次の描き直しか少し後に頼み直す。
				this._semanticBytes = undefined;
				this._semanticBusyBytes = bytes;
				if (this._semanticRetries++ < PARADIS_WORD_SEMANTIC_BUSY_RETRIES) {
					this._semanticRetry.value = disposableTimeout(() => {
						if (isEqual(this._currentResource, resource) && inputEpoch === this._inputEpoch && !this._semanticBytes) {
							this._requestSemanticAnalysis(resource, bytes, inputEpoch);
						}
					}, PARADIS_WORD_SEMANTIC_BUSY_RETRY_MS);
				}
			} else {
				this._semanticRetries = 0;
				this._semanticBusyBytes = undefined;
			}
			if (result.ok) {
				this._semanticSearch = new ParadisOfficeSemanticSearch({
					ownerId: 'paradis-word-view',
					handleId: String(++this._semanticSearchHandle),
					revision: String(this._semanticSearchHandle),
					items: result.searchItems.map(item => ({
						...item,
						locationBadge: { kind: item.locationBadge.kind, label: paradisWordStoryLabel(item.locationBadge.label as ParadisWordStoryKind) },
					})),
				});
			}
			this._renderSemanticUi();
			this._publishAnnotations();
		})();
	}

	private _createFindProvider(search: ParadisOfficeSemanticSearch) {
		const handle = { ownerId: 'paradis-word-view', handleId: String(this._semanticSearchHandle) };
		return (query: { readonly text: string; readonly matchCase: boolean }, cursor: string | undefined, token: CancellationToken) => {
			this._findMatchCase = query.matchCase;
			return search.search(handle, { text: query.text, matchCase: query.matchCase }, cursor, token);
		};
	}

	private async _searchAll(search: ParadisOfficeSemanticSearch, query: string): Promise<readonly ParadisOfficeSearchResult[]> {
		const page = await search.search({ ownerId: 'paradis-word-view', handleId: String(this._semanticSearchHandle) }, { text: query, matchCase: false });
		return page.results;
	}

	/** 変更点パネルの項目から、表示中の文書の該当箇所へ移る。段落の文字を手がかりに webview の中で探す。 */
	private _navigateInspectorTarget(target: ParadisWordNavigationTarget): void {
		const analysis = this._semanticResult?.ok ? this._semanticResult : undefined;
		if (!analysis || target.kind === 'placeholder') {
			return;
		}
		const paragraph = target.anchor ? analysis.searchItems.find(item => item.navigableAnchor === target.anchor) : undefined;
		const context = paragraph?.fields.find(field => field.kind !== 'hidden')?.text ?? '';
		const change = target.kind === 'change' ? analysis.changes.find(candidate => target.changeId !== undefined
			? candidate.id === target.changeId
			: candidate.navigableAnchor === target.anchor && candidate.subject.locator === target.locator) : undefined;
		// コメントは本文に無いので、コメントの付いた段落そのものを示す。変更履歴は段落の中の変わった文字を示す。
		const focus = change && change.category !== 'annotation' ? wordChangeText(change) ?? context : context;
		if (!context && !focus) {
			return;
		}
		this._postReveal({ type: 'paradisWordReveal', context: context || focus, focus: focus || context, matchCase: true }, target.anchor);
	}

	private _postReveal(request: ParadisWordRevealRequest, paragraphLocator: string | undefined): void {
		const marker = paragraphLocator ? this._markerByLocator?.get(paragraphLocator) : undefined;
		const notFound = localize('paradis.word.revealNotFound', "表示の中で見つかりません。");
		void this._pane.webview?.postMessage(marker ? { ...request, notFound, marker } : { ...request, notFound });
	}

	/**
	 * 表示の段落と解析結果の段落の対応を取り、段落の中の要素（点線と吹き出し）とコメント（余白）を webview へ送る。
	 * 表示（webview が段落の文字を報告する）と解析（shared process）のどちらが後に届いても、ここで揃える。
	 */
	private _publishAnnotations(): void {
		const analysis = this._semanticResult?.ok ? this._semanticResult : undefined;
		const rendered = this._renderedParagraphs;
		if (!analysis || !rendered || !this._pane.webview) {
			this._markerByLocator = undefined;
			return;
		}
		const markers = alignParadisWordParagraphs(analysis.outline, rendered);
		this._markerByLocator = markers;
		const marks: { readonly marker: string; readonly marks: IParadisWordParagraphOutline['marks'] }[] = [];
		const comments: { readonly marker: string; readonly author: string; readonly date: string; readonly text: string }[] = [];
		const seenComments = new Set<string>();
		for (const story of analysis.outline.stories) {
			for (const paragraph of story.paragraphs) {
				const marker = markers.get(paragraph.locator);
				if (!marker || paragraph.marks.length === 0) {
					continue;
				}
				marks.push({ marker, marks: paragraph.marks });
				for (const mark of paragraph.marks) {
					const value = (name: string) => mark.rows.find(row => row[0] === name)?.[1] ?? '';
					if (mark.kind === 'comment' && !seenComments.has(value('commentId'))) {
						seenComments.add(value('commentId'));
						comments.push({ marker, author: value('author'), date: value('date'), text: value('text') });
					}
				}
			}
		}
		void this._pane.webview.postMessage({
			type: 'paradisWordAnnotations',
			marks,
			comments,
			labels: {
				title: localize('paradis.word.nodeInfo', "解析器が持っている情報"),
				close: localize('paradis.word.nodeInfoClose', "閉じる"),
			},
		});
	}




	private _buildRejectedFileHtml(): string {
		return paradisViewerWebviewFailureHtml(localize('paradis.word.failed', "Word 文書を表示できませんでした: {0}", localize('paradis.viewer.emptyOrBroken', "ファイルが空または破損しています")));
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
	 * 本文の表示より後に走らせる。zip の再展開と XML 走査は shared process の worker で行う（{@link _extractWordObjects}）が、
	 * worker を使えないときはレンダラのメインスレッドで動くので、表示の前に待つと、悪意あるファイル1つでウィンドウ全体が固まる。
	 * 送る直前に世代を確認し、別の文書へ切り替わっていたら捨てる。
	 * 送り終えた（送るものが無かった・作れなかったも含む）なら `true`。途中で別の表示へ移ったら `false`。
	 */
	private async _deliverWordObjects(webview: IOverlayWebview, bytes: Uint8Array, generation: number, inputEpoch: number, token: CancellationToken): Promise<boolean> {
		const isCurrent = () => generation === this._renderGeneration && inputEpoch === this._inputEpoch
			&& this._pane.claimed && !token.isCancellationRequested;
		try {
			const objects = await this._extractWordObjects(bytes, token);
			if (objects === undefined || objects.length === 0 || !isCurrent()) {
				return isCurrent();
			}
			// 表示中の文書とは別の切り離した Document 上で組み立て、本文の DOM に触れないようにする。
			const scratch = dom.getWindow(this._webviewContainer).document.implementation.createHTMLDocument('');
			const items = buildParadisWordOverlayItems(objects, scratch);
			if (items.length === 0 || !isCurrent()) {
				return isCurrent();
			}
			webview.postMessage({ type: 'paradisWordObjects', items });
			return true;
		} catch {
			// 図形が出ないだけで本文の表示には影響しないので、黙って諦める。
			return isCurrent();
		}
	}

	/**
	 * 本文の上に重ねる描画対象を取り出す。zip の展開と XML の走査は重いので、shared process の Word の worker で行い、
	 * renderer のメインスレッドを塞がない。worker を使えないとき（つながらない・落ちた・混んでいる）だけ、ここで取り出す。
	 * 取り消されたら undefined。
	 */
	private async _extractWordObjects(bytes: Uint8Array, token: CancellationToken): Promise<readonly ParadisWordRenderableObject[] | undefined> {
		const result = await extractParadisWordRenderableObjectsInWorker(this._sharedProcessService, bytes, token).catch(() => undefined);
		switch (paradisWordObjectsAfterWorker(result, token.isCancellationRequested)) {
			case 'worker': return result?.ok ? result.objects : [];
			case 'none': return [];
			case 'cancelled': return undefined;
		}
		const parts = await readWordRenderablePackageParts(bytes, token);
		return parts.size === 0 ? [] : extractParadisWordRenderableObjects({ parts, token });
	}

	/**
	 * 文書のページを webview へ書く。消毒済みの文書があれば HTML には埋めず、ページが受け口を用意したら transfer 付きで送る
	 * （{@link _pendingDocument}）。
	 */
	private _setDocumentPage(webview: IOverlayWebview, resource: URI, sanitized: Uint8Array | undefined, assetPlaceholderCount: number, viewState: ParadisWordViewState, recoveryGeneration: number): void {
		const documentId = sanitized ? generateUuid() : undefined;
		this._pendingDocument = sanitized && documentId ? { id: documentId, resource, webview, bytes: sanitized } : undefined;
		this._pane.setDocumentHtml(webview, resource, applyParadisOfficeWebviewAccessibility(this._buildHtml(resource, documentId, assetPlaceholderCount, viewState, recoveryGeneration)));
		if (!this._webviewSupportsRecoveryMessages) {
			// ページからの知らせを受けられない webview には、書いた直後に送っておく（ページが読み込んでから受け取る）。
			this._postPendingDocument(documentId);
		}
	}

	/** ページが受け口を用意した。いま待っている文書なら、写しを transfer 付きで送る（覚えている文書は手放さない）。 */
	private _postPendingDocument(id: string | undefined): void {
		const pending = this._pendingDocument;
		if (!pending || pending.id !== id || pending.webview !== this._pane.webview) {
			return;
		}
		const copy = pending.bytes.slice();
		void pending.webview.postMessage({ type: 'paradisWordDocument', id: pending.id, bytes: copy.buffer }, [copy.buffer]);
	}

	private _buildHtml(resource: URI, documentId?: string, assetPlaceholderCount = 0, viewState: ParadisWordViewState = this._wordViewState, recoveryGeneration = this._recoveryState.generation): string {
		// 配信サーバを使うかどうかは webview の作り方と揃える。片方だけサーバにすると、
		// service worker を切った webview に解決できない URL を渡すことになる。
		// 文書は postMessage で渡すので、ライブラリを配信サーバから出す webview なら served。
		const served = this._pane.serviceWorkerDisabled;
		const nonce = generateUuid();
		const remoteInfo = resource.scheme === Schemas.vscodeRemote ? { isRemote: true, authority: resource.authority } : undefined;
		// 文書を postMessage で渡すときは URL を使わない（空）。
		const docxUrl = documentId ? '' : asWebviewUri(resource, remoteInfo).toString(true);
		const libBase = served && this._pane.libBase ? this._pane.libBase : asWebviewUri(FileAccess.asFileUri(PARADIS_DOCX_MEDIA_ROOT)).toString(true);
		// CSP は実際に使うポートまで絞る（`http://127.0.0.1:*` だと他プロセスのサーバまで許してしまう）。
		const serverOrigin = served ? paradisPreviewOrigins(libBase, docxUrl) : '';
		const csp = serverOrigin
			? buildParadisOfficeWordCsp(nonce, { kind: 'mountedLoopback', origins: serverOrigin.split(' ') })
			: buildParadisOfficeWordCsp(nonce, {
				kind: 'webviewResource',
				cspSources: [
					paradisOfficeWebviewResourceOrigin(libBase),
					...(docxUrl ? [paradisOfficeWebviewResourceOrigin(docxUrl)] : []),
				],
			});
		const zoom = Math.min(4, Math.max(0.25, viewState.zoom));
		const displayMode = viewState.displayMode;
		// ページの中で出す文も localize する。script の中に置くので `</script>` で閉じられないよう `<` をエスケープする。
		const libraryLoadFailed = JSON.stringify(localize('paradis.word.libraryLoadFailed', "レンダリングライブラリの読み込みに失敗しました")).replace(/</g, '\\u003c');

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
		${PARADIS_VIEWER_WEBVIEW_STATE_STYLE}
		${PARADIS_WORD_ANCHOR_STYLE}
	</style>
</head>
<body class="paradis-word-${displayMode}">
	${assetPlaceholderCount > 0 ? `<div role="status" id="asset-placeholders">${escape(localize('paradis.word.assetsUnavailable', "表示できない部品: {0} 件", assetPlaceholderCount))}</div>` : ''}
	<div id="scroller"><div id="content"></div></div>
	${paradisViewerWebviewStatusHtml()}
	<script nonce="${nonce}" src="${libBase}/jszip.min.js"></script>
	<script nonce="${nonce}" src="${libBase}/docx-preview.min.js"></script>
	<script nonce="${nonce}">
		${PARADIS_WORD_ANCHOR_RUNTIME}
		(async () => {
			const vscode = acquireVsCodeApi();
			const DOCX_URL = ${JSON.stringify(docxUrl)};
			// 消毒した文書は、HTML に埋めずにホストから受け取る（受け口を用意したと知らせると、transfer 付きで届く）。
			// webview の基盤（親のフレーム）から届いた、このページ宛ての文書だけを受ける。
			const DOCUMENT_ID = ${JSON.stringify(documentId ?? '')};
			// webview の基盤はページの window.parent を置き換えるので、送り主が本物の親のフレームかで見分ける。
			const paradisFromHost = ${PARADIS_WEBVIEW_HOST_MESSAGE_CHECK};
			const paradisDocument = DOCUMENT_ID ? new Promise(resolve => {
				window.addEventListener('message', event => {
					const data = event.data;
					if (paradisFromHost(event) && data && data.type === 'paradisWordDocument' && data.id === DOCUMENT_ID && data.bytes instanceof ArrayBuffer) {
						resolve(data.bytes);
					}
				});
				vscode.postMessage({ type: 'paradisWordDocumentReady', id: DOCUMENT_ID });
			}) : undefined;
			// 検査を通った画像でも、描画側で読めなかったら代わりの箱に替え、何枚あったかをホストへ知らせる
			// （代替表示に数える）。HTML の img と、VML の画像を描く SVG の image の両方を見る。
			const PARADIS_BROKEN_IMAGE = ${JSON.stringify(`data:image/svg+xml;base64,${encodeBase64(VSBuffer.wrap(paradisOfficeBrokenImagePlaceholderSvg()))}`)};
			const PARADIS_XLINK = 'http://www.w3.org/1999/xlink';
			const paradisBrokenImageSources = new Set();
			const paradisImageSource = el => el instanceof HTMLImageElement ? el.getAttribute('src') : el instanceof SVGImageElement ? (el.getAttribute('href') || el.getAttributeNS(PARADIS_XLINK, 'href')) : null;
			// docx-preview は画像を型の無い Blob から data URL にするので、SVG の部品（EMF・WMF を変換したもの、
			// 代わりの箱）は application/octet-stream になって描かれない。先頭が <svg のものだけ型を付け替える。
			const retypeParadisSvgImage = el => {
				const source = paradisImageSource(el);
				if (!source || el.dataset.paradisSvgImage || !/^data:(?:application[/]octet-stream)?;base64,PHN2Zy/.test(source)) {
					return false;
				}
				el.dataset.paradisSvgImage = '1';
				const typed = 'data:image/svg+xml;base64,' + source.slice(source.indexOf(',') + 1);
				if (el instanceof HTMLImageElement) {
					el.src = typed;
				} else {
					el.removeAttributeNS(PARADIS_XLINK, 'href');
					el.setAttribute('href', typed);
				}
				return true;
			};
			const replaceParadisBrokenImage = el => {
				if (retypeParadisSvgImage(el)) {
					return;
				}
				// 対象は PNG・JPEG・GIF の中身を持つ画像だけ（base64 の先頭で見分ける）。代わりの箱の SVG などは数えない。
				const source = paradisImageSource(el);
				if (!source || el.dataset.paradisBrokenImage || !/^data:[^,]*;base64,(?:iVBOR|[/]9j[/]|R0lG)/.test(source)) {
					return;
				}
				el.dataset.paradisBrokenImage = '1';
				paradisBrokenImageSources.add(source);
				if (el instanceof HTMLImageElement) {
					el.src = PARADIS_BROKEN_IMAGE;
				} else {
					el.removeAttributeNS(PARADIS_XLINK, 'href');
					el.setAttribute('href', PARADIS_BROKEN_IMAGE);
				}
				vscode.postMessage({ type: 'paradisWordBrokenImages', generation: ${recoveryGeneration}, count: paradisBrokenImageSources.size });
			};
			// 読み込みを終えて幅が 0 の img は読めなかった（decode を全部に掛けると、大きな画像をまとめて展開してしまう）。
			const checkParadisImage = img => {
				if (img.complete) {
					if (img.naturalWidth === 0) {
						replaceParadisBrokenImage(img);
					}
				} else {
					img.addEventListener('load', () => { if (img.naturalWidth === 0) { replaceParadisBrokenImage(img); } }, { once: true });
				}
			};
			// docx-preview が描かない図形(グラフ・SmartArt 等)。本文表示のあとに送られてくる。
			let PARADIS_WORD_OBJECTS = [];
			let paradisDocumentRendered = false;
			// 差し込みの本体は描画完了後に入れ替える。受け取りだけ先に構えておく
			// (送信は本文表示の直後に来るので、リスナーが後だと取りこぼす)。
			let placeParadisWordObjects = () => { };
			// 検索結果・変更点・押した要素の情報。表示の段落に付けた目印（paradisWordAnchorRuntime.ts）で位置を探す。
			// 描き終わる前に届いたものは覚えておき、描いた後に当てる。
			const anchors = window.paradisWordAnchors;
			let pendingParadisWordReveal;
			let pendingParadisWordAnnotations;
			const applyParadisWordAnnotations = message => {
				if (!paradisDocumentRendered || !anchors) {
					pendingParadisWordAnnotations = message;
					return;
				}
				anchors.setMarks(contentEl, Array.isArray(message.marks) ? message.marks : [], message.labels, ${JSON.stringify(displayMode)});
				anchors.setComments(contentEl, contentEl, Array.isArray(message.comments) ? message.comments : []);
			};
			const revealParadisWord = message => {
				if (!paradisDocumentRendered || !anchors) {
					pendingParadisWordReveal = message;
					return;
				}
				anchors.reveal(contentEl, message);
			};
			window.addEventListener('message', event => {
				const message = event.data;
				if (message && message.type === 'paradisWordReveal') {
					revealParadisWord(message);
					return;
				}
				if (message && message.type === 'paradisWordAnnotations') {
					applyParadisWordAnnotations(message);
					return;
				}
				if (!message || message.type !== 'paradisWordObjects' || !Array.isArray(message.items)) {
					return;
				}
				PARADIS_WORD_OBJECTS = message.items;
				placeParadisWordObjects();
			});
			const statusEl = document.getElementById('status');
			const contentEl = document.getElementById('content');
			// error は泡立たないので、捕捉の段階で拾う。
			contentEl.addEventListener('error', event => replaceParadisBrokenImage(event.target), true);
			try {
				if (!window.docx || !window.JSZip) {
					throw new Error(${libraryLoadFailed});
				}
				const buf = paradisDocument ? await paradisDocument : await (await fetch(DOCX_URL)).arrayBuffer();
				const renderOptions = {
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
				};
				// renderAsync と同じ 2 段（解析→描画）を自分で呼び、その間で段落に目印を付ける。
				// 目印は属性が 1 つ増えるだけで、描画の結果は変わらない。
				const parsed = await window.docx.parseAsync(buf.slice(0), renderOptions);
				if (anchors) {
					anchors.stamp(parsed);
				}
				await window.docx.renderDocument(parsed, contentEl, undefined, renderOptions);
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
				// 描画の途中（まだ文書に付いていない間）に失敗した画像は error を拾えないので、読み込みの結果を見る。
				for (const img of contentEl.querySelectorAll('img')) {
					if (img.getAttribute('src') && !img.dataset.paradisBrokenImage) {
						checkParadisImage(img);
					}
				}
				placeParadisWordObjects();
				if (anchors) {
					// 表示の段落ごとの文字をホストへ渡す。ホストはこれと解析結果の段落を対応づける。
					vscode.postMessage({ type: 'paradisWordParagraphs', generation: ${recoveryGeneration}, stories: anchors.collect(contentEl) });
				}
				if (pendingParadisWordAnnotations) {
					applyParadisWordAnnotations(pendingParadisWordAnnotations);
					pendingParadisWordAnnotations = undefined;
				}
				if (pendingParadisWordReveal) {
					revealParadisWord(pendingParadisWordReveal);
					pendingParadisWordReveal = undefined;
				}
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
				${paradisViewerWebviewFailureScript(localize('paradis.word.failed', "Word 文書を表示できませんでした: {0}"))}
			}
		})();
	</script>
</body>
</html>`;
	}

	private _updateWebviewPlacement(): void {
		const resource = this._currentResource;
		const justClaimed = this._pane.place(this._editorVisible && !!resource, this.window, this._webviewContainer!,
			() => ({ disableServiceWorker: this._canServe(resource!), localResourceRoots: this._localResourceRoots(resource!) }),
			() => this._updateWebviewPlacement());
		if (justClaimed && resource && !this._recreatingForRecovery) {
			this._renderResource(resource, undefined, true);
		}
	}

	override clearInput(): void {
		this._openTiming.clear();
		this._probe.endOpen();
		this._assetSanitization.value?.cancel();
		this._openCacheLease.clear();
		this._inputEpoch++;
		this._inputDisposables.clear();
		this._clearSemanticUi();
		this._resetSemanticAnalysis();
		this._currentResource = undefined;
		this._runtimeConfiguration = undefined;
		this._renderSnapshot = undefined;
		this._recoveryState = createParadisOfficeRecoveryState();
		// 描き終わったか分からない表示は、戻ったときに描き直す（白紙や図形の抜けを残さない）。
		this._pane.forgetUnconfirmedShown();
		this._pane.release();
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
		// 解析・比較の依頼も取り消す（MutableDisposable の dispose は取り消しを伝えない）。
		this._semanticRequest.value?.cancel();
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
		this._pane.webview?.focus();
	}

	override layout(dimension: dom.Dimension): void {
		if (this._rootElement) {
			this._rootElement.style.width = `${dimension.width}px`;
			this._rootElement.style.height = `${dimension.height}px`;
		}
		this._syncSemanticToolbarOffset();
		this.setEditorVisible(dimension.width > 0 && dimension.height > 0);
	}
}
