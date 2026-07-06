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
	<!-- style-src: docx-preview は文書の見た目（フォント/色/罫線/numbering等)のほぼ全てを
	document.createElement('style') による動的な <style> 要素(nonce無し)として注入する。
	CSPの style-src は「nonce-source が1つでもあると 'unsafe-inline' は無視される」という
	後方互換ルールがあるため、nonce と unsafe-inline を併記しても nonce の無い動的 style は
	ブロックされる(sheet=null になり書式が丸ごと無効化される)。ここでは nonce を使わず
	'unsafe-inline' のみを指定し、docx-preview 由来のスタイルも含めて確実に適用させる。 -->
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https:; style-src 'unsafe-inline'; img-src blob: data: https:; font-src https: data: blob:; connect-src https: blob: data:;">
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
		#content { padding: 32px 16px 48px; display: flex; flex-direction: column; align-items: center; }
		/* docx-preview のページ要素（.docx-wrapper > section.docx）に PDF ビューア風の白紙＋影を付ける。 */
		#content .docx-wrapper { background: transparent; padding: 0; display: flex; flex-direction: column; align-items: center; gap: 16px; }
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
					useBase64URL: true
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
