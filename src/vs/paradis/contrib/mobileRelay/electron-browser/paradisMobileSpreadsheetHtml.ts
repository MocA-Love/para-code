/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルアプリ向けの Excel(xlsx) 静的HTML生成。
// PC版ビューア(fileViewers)のパーサ・描画部品をそのまま使い、renderer の不可視コンテナで
// 実レイアウトを確定（shrinkToFit / セルまたぎオーバーフロー / 図形の行位置）させた上で
// HTML文字列に直列化する。モバイルはこれを WebView に表示するだけで、PC版と同じ見た目・
// ピンチ拡大縮小(ビューポートズーム)が得られる。

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { FileAccess } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisSheetData, IParadisWorkbookData } from '../../fileViewers/common/paradisSpreadsheet.js';
import { parseSpreadsheetResource } from '../../fileViewers/electron-browser/paradisSpreadsheetClient.js';
import { IParadisDiffCell, IParadisDiffRow, IParadisShapeRender, buildDiffSheets, buildShapeDiff } from '../../fileViewers/electron-browser/paradisSpreadsheetDiff.js';
import {
	IParadisOverflowItem,
	PARADIS_ROW_NUM_COL_WIDTH,
	appendDiagonalOverlay,
	applyBaseCellStyle,
	applyOverflow,
	applyShrinkToFit,
	buildShapeDiffOverlay,
	buildShapeOverlay,
	buildSheetTableDom,
	computeOverflowRoom,
	createOverflowSpan,
	overflowToward,
	setCellContent,
} from '../../fileViewers/electron-browser/paradisSpreadsheetRender.js';
// 不可視コンテナでの実測(shrink/overflow/行位置)をビューア本体と同じフォント/罫線条件で
// 行うため、ビューアのCSSをこのウィンドウにも読み込んでおく。
import '../../fileViewers/electron-browser/media/paradisSpreadsheet.css';

const $ = dom.$;

/**
 * 直列化サイズ上限(UTF-8バイト)。FrameMuxのチャンク分割転送によりリレーの
 * WebSocketメッセージ上限(1MiB)には縛られなくなったため、モバイルのWebViewが
 * 現実的に描画できる規模を上限とする。超過時は後方シートから省略する。
 */
const MOBILE_XLSX_HTML_MAX_BYTES = 6_000_000;

const encoder = new TextEncoder();

let cssPromise: Promise<string> | undefined;

const SPREADSHEET_CSS_MODULE = 'vs/paradis/contrib/fileViewers/electron-browser/media/paradisSpreadsheet.css' as const;

async function readSpreadsheetCss(fileService: IFileService): Promise<string> {
	try {
		const content = await fileService.readFile(FileAccess.asFileUri(SPREADSHEET_CSS_MODULE));
		return content.value.toString();
	} catch {
		// パッケージ形態によっては file スキームで読めないことがあるため fetch へフォールバック
		const url = FileAccess.asBrowserUri(SPREADSHEET_CSS_MODULE).toString(true);
		return (await fetch(url)).text();
	}
}

/**
 * ビューアのCSSをテキストで取得する(モバイルHTMLへのインライン用、成功時のみキャッシュ)。
 * CSSが無いと table-layout: fixed もグリッド罫線も斜線オーバーレイも効かず、
 * 「列が内容幅に広がって異様に横長」「罫線・斜線が消える」壊れたHTMLになるため、
 * 取得失敗時は空文字で描画を続けず明示的にエラーにする(モバイル側にエラー文言が出る)。
 */
function loadSpreadsheetCss(fileService: IFileService): Promise<string> {
	if (!cssPromise) {
		cssPromise = readSpreadsheetCss(fileService).then(css => {
			if (!css) {
				throw new Error('スプレッドシート表示用CSSの読み込みに失敗しました。再度お試しください');
			}
			return css;
		}).catch(err => {
			// 一過性の失敗を恒久キャッシュしない（次回の要求で再取得する）
			cssPromise = undefined;
			throw err instanceof Error ? err : new Error('スプレッドシート表示用CSSの読み込みに失敗しました。再度お試しください');
		});
	}
	return cssPromise;
}

/**
 * 直列化前にインラインstyleを共有クラスへ寄せてHTMLを圧縮する。
 * 数万セル規模のシートはセル毎のインラインstyleだけでサイズ上限(6MB)を超えて
 * 表示不能になるため、同一styleが2回以上現れる要素をクラス参照に置き換える。
 * インラインstyleは全CSSルールより優先されるため、生成ルールの各宣言に
 * !important を付けて元の優先順位を保つ(ビューアCSSは !important を使っていない)。
 */
class InlineStyleDeduper {
	private readonly classByStyle = new Map<string, string>();

	apply(root: HTMLElement): void {
		// eslint-disable-next-line no-restricted-syntax -- 自前構築した測定ホスト内DOMの全style付き要素の列挙(ライブDOMではない)
		const els = root.querySelectorAll('[style]');
		const counts = new Map<string, number>();
		els.forEach(el => {
			const style = el.getAttribute('style');
			if (style) {
				counts.set(style, (counts.get(style) ?? 0) + 1);
			}
		});
		els.forEach(el => {
			const style = el.getAttribute('style');
			if (!style || ((counts.get(style) ?? 0) < 2 && !this.classByStyle.has(style))) {
				return;
			}
			let cls = this.classByStyle.get(style);
			if (!cls) {
				cls = `pmx-${this.classByStyle.size}`;
				this.classByStyle.set(style, cls);
			}
			el.classList.add(cls);
			el.removeAttribute('style');
		});
	}

	cssText(): string {
		return this.buildCss(undefined);
	}

	/** 直列化済みHTML群に実際に現れるクラスのルールだけを生成する(シート省略時のサイズ再計算用)。 */
	cssTextForHtml(htmls: readonly string[]): string {
		const used = new Set<string>();
		for (const html of htmls) {
			for (const m of html.matchAll(/\bpmx-\d+\b/g)) {
				used.add(m[0]);
			}
		}
		return this.buildCss(used);
	}

	private buildCss(usedClasses: Set<string> | undefined): string {
		const rules: string[] = [];
		for (const [style, cls] of this.classByStyle) {
			if (usedClasses && !usedClasses.has(cls)) {
				continue;
			}
			// 注: split(';') は「値にセミコロンを含む宣言(url(data:...;base64,...) 等)が無い」前提。
			// 現状のセルstyleは色・幅・罫線・配置のみでこの前提を満たす。
			const decls = style.split(';').map(d => d.trim()).filter(d => d.length > 0).map(d => `${d} !important`).join('; ');
			rules.push(`.${cls} { ${decls}; }`);
		}
		return rules.join('\n');
	}
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * CSSが参照する `var(--vscode-*)` をPCの現在テーマの実値へ解決した :root ブロックを作る。
 * モバイルのWebViewにはワークベンチのCSS変数が存在せず、未解決だと背景・罫線色が
 * 消えてレイアウトが崩れて見えるため、生成時に固定値として焼き込む。
 */
function resolveCssVariables(css: string): string {
	const names = new Set<string>();
	for (const match of css.matchAll(/var\((--[A-Za-z0-9-]+)/g)) {
		names.add(match[1]);
	}
	if (names.size === 0) {
		return '';
	}
	const bodyStyle = mainWindow.getComputedStyle(mainWindow.document.body);
	const rootStyle = mainWindow.getComputedStyle(mainWindow.document.documentElement);
	const declarations: string[] = [];
	for (const name of names) {
		const value = (bodyStyle.getPropertyValue(name) || rootStyle.getPropertyValue(name)).trim();
		if (value.length > 0) {
			declarations.push(`${name}: ${value};`);
		}
	}
	return declarations.length > 0 ? `:root { ${declarations.join(' ')} }\n` : '';
}

/** 実レイアウト測定用の不可視ホストを body に一時的に作って fn を実行する。 */
function withMeasureHost<T>(fn: (host: HTMLElement, doc: Document) => T): T {
	const doc = mainWindow.document;
	const host = doc.createElement('div');
	host.style.position = 'fixed';
	host.style.left = '-100000px';
	host.style.top = '0';
	host.style.visibility = 'hidden';
	host.style.pointerEvents = 'none';
	doc.body.appendChild(host);
	try {
		return fn(host, doc);
	} finally {
		host.remove();
	}
}

/** 行DOMの実測位置から Excel行番号→Y座標のマップを作る(図形アンカー解決用)。 */
function measureRowY(dataRows: readonly { excelRow: number; tr: HTMLElement }[]): Map<number, number> {
	const rowY = new Map<number, number>();
	for (const { excelRow, tr } of dataRows) {
		rowY.set(excelRow, tr.offsetTop);
	}
	const last = dataRows[dataRows.length - 1];
	if (last) {
		rowY.set(last.excelRow + 1, last.tr.offsetTop + last.tr.offsetHeight);
	}
	return rowY;
}

// 分割描画: 初回表示ウィンドウを超える行数のシートは、残り行を <template> に退避して
// WebView側スクリプトがフレーム毎に追記する。巨大シートでも最初の画面がすぐ出る。
const PROGRESSIVE_ROW_WINDOW = 250;
const PROGRESSIVE_ROW_CHUNK = 250;

/**
 * tbody の行を先頭ウィンドウ + <template> チャンク群に分割する(直列化サイズ・最終DOMは不変)。
 * 実測とインラインstyle圧縮が終わった後に呼ぶこと。分割中は図形オーバーレイの位置が
 * テーブルの実高と合わないため、呼び出し側で全行追記完了まで非表示にする。
 */
function splitRowsForProgressiveReveal(wrap: HTMLElement, doc: Document): boolean {
	// eslint-disable-next-line no-restricted-syntax -- 自前構築した測定ホスト内DOM(テーブル1つ)のtbody取得(ライブDOMではない)
	const tbody = wrap.querySelector('tbody');
	if (!tbody || tbody.children.length <= PROGRESSIVE_ROW_WINDOW + PROGRESSIVE_ROW_CHUNK) {
		return false;
	}
	const rows: Element[] = [];
	for (let i = PROGRESSIVE_ROW_WINDOW; i < tbody.children.length; i++) {
		rows.push(tbody.children[i]);
	}
	for (let start = 0; start < rows.length; start += PROGRESSIVE_ROW_CHUNK) {
		const tpl = doc.createElement('template');
		tpl.setAttribute('data-pm-rows', '1');
		for (const row of rows.slice(start, start + PROGRESSIVE_ROW_CHUNK)) {
			tpl.content.appendChild(row);
		}
		wrap.appendChild(tpl);
	}
	return true;
}

/** 1シートを実測込みで構築し、直列化済みHTMLと自然幅を返す。 */
function buildSheetSectionHtml(sheet: IParadisSheetData, host: HTMLElement, doc: Document, deduper: InlineStyleDeduper, progressive: boolean): { html: string; naturalWidth: number } {
	const build = buildSheetTableDom(sheet);
	const wrap = doc.createElement('div');
	wrap.className = 'paradis-spreadsheet-inner';
	wrap.style.width = `${build.naturalWidth}px`;
	wrap.appendChild(build.table);
	host.appendChild(wrap);
	try {
		applyShrinkToFit(build.shrinkCells);
		applyOverflow(build.overflowCells);
		let overlay: HTMLElement | SVGElement | undefined;
		if (sheet.shapes && sheet.shapes.length > 0) {
			overlay = buildShapeOverlay(sheet.shapes, measureRowY(build.dataRows), sheet.columnWidths, sheet.minCol, doc) ?? undefined;
			if (overlay) {
				wrap.appendChild(overlay);
			}
		}
		// 実測(レイアウト参照)がすべて終わった後に圧縮する
		deduper.apply(wrap);
		if (progressive && splitRowsForProgressiveReveal(wrap, doc) && overlay) {
			// 全行が揃うまでオーバーレイの絶対座標がテーブル実高とずれるため隠す(揃い次第スクリプトが表示)
			overlay.style.visibility = 'hidden';
			overlay.setAttribute('data-pm-hidden-until-loaded', '1');
		}
		return { html: wrap.outerHTML, naturalWidth: build.naturalWidth };
	} finally {
		wrap.remove();
	}
}

/** 差分の片側ペイン(旧版or新版)のテーブルを構築する(ビューア本体の _buildDiffPane 相当)。 */
function buildDiffPaneDom(rows: readonly IParadisDiffRow[], columnWidths: readonly number[], naturalWidth: number, doc: Document): { table: HTMLTableElement; dataRows: { excelRow: number; tr: HTMLElement }[]; overflowCells: IParadisOverflowItem[] } {
	const table = $('table.paradis-spreadsheet-table.grid') as HTMLTableElement;
	table.style.width = `${naturalWidth}px`;

	const colgroup = dom.append(table, $('colgroup'));
	const rowNumCol = dom.append(colgroup, $('col')) as HTMLTableColElement;
	rowNumCol.style.width = `${PARADIS_ROW_NUM_COL_WIDTH}px`;
	for (const w of columnWidths) {
		const col = dom.append(colgroup, $('col')) as HTMLTableColElement;
		if (w) {
			col.style.width = `${w}px`;
		}
	}

	const tbody = dom.append(table, $('tbody'));
	const dataRows: { excelRow: number; tr: HTMLElement }[] = [];
	const overflowCells: IParadisOverflowItem[] = [];
	rows.forEach((row, rowIdx) => {
		const tr = dom.append(tbody, $('tr')) as HTMLTableRowElement;
		if (row.excelRow !== undefined) {
			dataRows.push({ excelRow: row.excelRow, tr });
		}
		tr.style.height = `${row.height}px`;
		const rowHead = dom.append(tr, $('td.paradis-spreadsheet-rowhead'));
		rowHead.textContent = String(rowIdx + 1);
		for (let ci = 0; ci < row.cells.length; ci++) {
			const cell = row.cells[ci];
			if (cell.hidden) {
				continue;
			}
			buildDiffCell(tr, cell, row.cells, ci, columnWidths, overflowCells);
		}
	});
	return { table, dataRows, overflowCells };
}

function buildDiffCell(tr: HTMLElement, cell: IParadisDiffCell, cells: readonly IParadisDiffCell[], index: number, columnWidths: readonly number[], overflowSink: IParadisOverflowItem[]): void {
	const td = dom.append(tr, $('td')) as HTMLTableCellElement;
	if (cell.colSpan && cell.colSpan > 1) {
		td.colSpan = cell.colSpan;
	}
	if (cell.rowSpan && cell.rowSpan > 1) {
		td.rowSpan = cell.rowSpan;
	}
	applyBaseCellStyle(td, cell);
	if (cell.diffStatus) {
		td.classList.add(`diff-${cell.diffStatus}`);
	}
	if (cell.diffSegments && cell.diffSegments.length > 0) {
		for (const seg of cell.diffSegments) {
			const span = dom.append(td, $('span')) as HTMLElement;
			span.textContent = seg.text;
			if (seg.type === 'added') {
				span.classList.add('diff-seg-added');
			} else if (seg.type === 'removed') {
				span.classList.add('diff-seg-removed');
			}
		}
	} else {
		const toward = overflowToward(cell);
		const room = toward !== 'none' ? computeOverflowRoom(cells, index, columnWidths) : undefined;
		if (toward !== 'none' && room && (room.left > 0 || room.right > 0)) {
			overflowSink.push({ td, span: createOverflowSpan(td, cell), toward, leftRoom: room.left, rightRoom: room.right, valign: (cell.style.verticalAlign as string) || 'bottom' });
		} else {
			setCellContent(td, cell);
		}
	}
	if (cell.diagonal) {
		appendDiagonalOverlay(td, cell.diagonal);
	}
}

interface ISectionEntry {
	readonly name: string;
	readonly html: string;
	readonly naturalWidth: number;
}

/** タブ切り替え付きのモバイル用HTML文書を組み立てる。scriptは自前生成のシート切替のみ。 */
function assembleMobileDoc(css: string, sections: readonly ISectionEntry[], notices: readonly string[], dedupedCss: string): string {
	const viewportWidth = Math.max(320, Math.min(4000, Math.ceil(Math.max(...sections.map(s => s.naturalWidth)) + 8)));
	const tabs = sections.length > 1
		? `<div class="pm-tabs">${sections.map((s, i) => `<button class="pm-tab${i === 0 ? ' active' : ''}" data-i="${i}">${escapeHtml(s.name)}</button>`).join('')}</div>`
		: '';
	const noticeHtml = notices.map(n => `<div class="pm-note">${escapeHtml(n)}</div>`).join('');
	const body = sections.map((s, i) => `<div class="pm-sheet${i === 0 ? ' active' : ''}" data-i="${i}">${s.html}</div>`).join('');
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=${viewportWidth}">
<style>${resolveCssVariables(css)}${css}
/* iOS WebViewのフォント自動拡大を無効化(広いビューポートで文字が勝手に拡大され、PC実測済みの列幅・縮小率と食い違う) */
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; background: #ffffff; }
.pm-tabs { position: sticky; top: 0; display: flex; overflow-x: auto; background: #f3f3f3; border-bottom: 1px solid #d0d0d0; z-index: 20; }
.pm-tab { border: none; background: transparent; padding: 10px 16px; font-size: 15px; color: #666666; white-space: nowrap; }
.pm-tab.active { color: #000000; font-weight: 600; box-shadow: inset 0 -2px 0 #0a84ff; }
.pm-note { padding: 8px 12px; background: #fff8e1; color: #7a5b00; font-size: 13px; border-bottom: 1px solid #f0e0b0; }
.pm-sheet { display: none; padding-bottom: 48px; }
.pm-sheet.active { display: block; }
.pm-pane-label { position: static; padding: 6px 10px; font-size: 13px; font-weight: 600; color: #666666; background: #f3f3f3; border-top: 1px solid #d0d0d0; border-bottom: 1px solid #d0d0d0; }
#pm-progress { position: fixed; left: 0; right: 0; bottom: 0; padding: 6px 12px; background: rgba(0,0,0,.7); color: #ffffff; font-size: 12px; z-index: 30; }
</style><style>${dedupedCss}</style></head><body>
${tabs}${noticeHtml}${body}
<script>
document.querySelectorAll('.pm-tab').forEach(function (btn) {
	btn.addEventListener('click', function () {
		document.querySelectorAll('.pm-tab').forEach(function (b) { b.classList.toggle('active', b === btn); });
		document.querySelectorAll('.pm-sheet').forEach(function (s) { s.classList.toggle('active', s.getAttribute('data-i') === btn.getAttribute('data-i')); });
		window.scrollTo(0, 0);
	});
});
// 分割描画: template に退避された行チャンクをフレーム毎に tbody へ追記する。
// 追記完了後に、位置がテーブル実高へ依存する図形オーバーレイを表示する。
(function () {
	var tpls = Array.prototype.slice.call(document.querySelectorAll('template[data-pm-rows]'));
	if (tpls.length === 0) { return; }
	var progress = document.createElement('div');
	progress.id = 'pm-progress';
	progress.textContent = '残りの行を描画中…';
	document.body.appendChild(progress);
	var total = tpls.length;
	function next() {
		var tpl = tpls.shift();
		if (!tpl) {
			progress.remove();
			document.querySelectorAll('[data-pm-hidden-until-loaded]').forEach(function (el) {
				el.style.visibility = '';
				el.removeAttribute('data-pm-hidden-until-loaded');
			});
			return;
		}
		var inner = tpl.closest('.paradis-spreadsheet-inner');
		var tbody = inner ? inner.querySelector('tbody') : null;
		if (tbody) { tbody.appendChild(tpl.content); }
		tpl.remove();
		progress.textContent = '残りの行を描画中… ' + Math.round(((total - tpls.length) / total) * 100) + '%';
		// requestAnimationFrame はWebViewが非表示だと発火せず追記が止まるため setTimeout で刻む
		setTimeout(next, 0);
	}
	setTimeout(next, 0);
})();
</script>
</body></html>`;
}

/** サイズ上限に収まるまで末尾のシートを落として文書を組み立てる。1シートでも超えるならエラー。 */
function assembleWithinBudget(css: string, sections: ISectionEntry[], notices: string[], deduper: InlineStyleDeduper): string {
	const kept = [...sections];
	for (; ;) {
		const omitted = sections.length - kept.length;
		const allNotices = omitted > 0 ? [...notices, `サイズ上限のため後方の${omitted}シートを省略しています`] : notices;
		// 省略後に残るシートが参照するクラスのCSSだけを載せる(省略してもCSSが縮まらず上限超過し続けるのを防ぐ)
		const docHtml = assembleMobileDoc(css, kept, allNotices, deduper.cssTextForHtml(kept.map(s => s.html)));
		if (encoder.encode(docHtml).length <= MOBILE_XLSX_HTML_MAX_BYTES) {
			return docHtml;
		}
		if (kept.length <= 1) {
			throw new Error('このExcelファイルは大きすぎるため、モバイルでは表示できません');
		}
		kept.pop();
	}
}

/** renderSpreadsheetMobileSheet の結果(1シート分のHTML + シート一覧)。 */
export interface IParadisMobileSheetResult {
	readonly html: string;
	/** ブックの全シート名(モバイルのネイティブタブ用)。 */
	readonly sheets: string[];
	/** 今回レンダリングしたシートのインデックス。 */
	readonly sheet: number;
}

// 直近にパースしたブックのキャッシュ(シートタブ切替のたびの再パースを避ける)。
// mtime が変わったら読み直す。1エントリで十分(モバイルは同時に1ブックしか見ない)。
let workbookCache: { key: string; mtime: number; workbook: IParadisWorkbookData } | undefined;

async function parseWithCache(fileService: IFileService, sharedProcessService: ISharedProcessService, resource: URI, mtime: number): Promise<IParadisWorkbookData> {
	const key = resource.toString();
	if (workbookCache && workbookCache.key === key && workbookCache.mtime === mtime) {
		return workbookCache.workbook;
	}
	const workbook = await parseSpreadsheetResource(fileService, sharedProcessService, resource);
	workbookCache = { key, mtime, workbook };
	return workbook;
}

// レンダリング済みシートHTMLのLRUキャッシュ(キーに mtime を含むため更新されたファイルは自然に外れる)。
// シートタブの往復や同じファイルの開き直しを即応答にする。件数に加え合計バイト数でも
// 上限を掛ける(1件最大6MBのHTML文字列を無際限に抱えてrendererのメモリを圧迫しないため)。
const sheetHtmlCache = new Map<string, IParadisMobileSheetResult>();
const SHEET_HTML_CACHE_MAX = 16;
const SHEET_HTML_CACHE_MAX_CHARS = 24_000_000; // UTF-16で約48MB相当

function cacheTotalChars(): number {
	let total = 0;
	for (const v of sheetHtmlCache.values()) {
		total += v.html.length;
	}
	return total;
}

function cacheGet(key: string): IParadisMobileSheetResult | undefined {
	const hit = sheetHtmlCache.get(key);
	if (hit) {
		// LRU: 取り直して末尾(最新)へ
		sheetHtmlCache.delete(key);
		sheetHtmlCache.set(key, hit);
	}
	return hit;
}

function cacheSet(key: string, value: IParadisMobileSheetResult): void {
	sheetHtmlCache.delete(key);
	sheetHtmlCache.set(key, value);
	while (sheetHtmlCache.size > SHEET_HTML_CACHE_MAX || (sheetHtmlCache.size > 1 && cacheTotalChars() > SHEET_HTML_CACHE_MAX_CHARS)) {
		const oldest = sheetHtmlCache.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		sheetHtmlCache.delete(oldest);
	}
}

async function renderSheetUncached(fileService: IFileService, sharedProcessService: ISharedProcessService, resource: URI, sheetIndex: number, mtime: number): Promise<IParadisMobileSheetResult> {
	const workbook = await parseWithCache(fileService, sharedProcessService, resource, mtime);
	const css = await loadSpreadsheetCss(fileService);
	if (workbook.sheets.length === 0) {
		throw new Error('シートが見つかりません');
	}
	const index = Math.min(Math.max(0, sheetIndex), workbook.sheets.length - 1);
	const sheet = workbook.sheets[index];
	const html = withMeasureHost((host, doc) => {
		const deduper = new InlineStyleDeduper();
		const section = buildSheetSectionHtml(sheet, host, doc, deduper, true);
		const notices: string[] = [];
		if (sheet.truncated) {
			notices.push('行数が多いためシートの先頭のみ表示しています');
		}
		const docHtml = assembleMobileDoc(css, [{ name: sheet.name, html: section.html, naturalWidth: section.naturalWidth }], notices, deduper.cssText());
		if (encoder.encode(docHtml).length > MOBILE_XLSX_HTML_MAX_BYTES) {
			throw new Error('このシートは大きすぎるため、モバイルでは表示できません');
		}
		return docHtml;
	});
	return { html, sheets: workbook.sheets.map(s => s.name), sheet: index };
}

/** 次に見る可能性が高い隣のシートを、PC側がアイドルのときに先読みしてキャッシュへ入れておく。 */
function schedulePrefetch(fileService: IFileService, sharedProcessService: ISharedProcessService, resource: URI, sheetIndex: number, mtime: number, sheetCount: number): void {
	if (sheetIndex < 0 || sheetIndex >= sheetCount) {
		return;
	}
	const key = `${resource.toString()}|${mtime}|${sheetIndex}`;
	if (sheetHtmlCache.has(key)) {
		return;
	}
	// これを超える規模のシートはPC側UIのカクつきを招くため先読みしない(本要求時のみレンダー)
	const PREFETCH_MAX_CELLS = 30_000;
	const run = async () => {
		try {
			if (sheetHtmlCache.has(key)) {
				return;
			}
			// ファイルが変わっていたら先読みしない(古い内容をキャッシュしない)
			const stat = await fileService.stat(resource);
			if ((stat.mtime ?? 0) !== mtime) {
				return;
			}
			const workbook = await parseWithCache(fileService, sharedProcessService, resource, mtime);
			const sheet = workbook.sheets[sheetIndex];
			if (!sheet || sheet.rows.length * sheet.columnCount > PREFETCH_MAX_CELLS) {
				return;
			}
			cacheSet(key, await renderSheetUncached(fileService, sharedProcessService, resource, sheetIndex, mtime));
		} catch {
			// 先読みは投機なので失敗は無視(本要求時に改めてエラーになる)
		}
	};
	if (typeof mainWindow.requestIdleCallback === 'function') {
		// timeout は指定しない: PCが忙しい間は先読みを強制発火させない(あくまでアイドル時のみ)
		mainWindow.requestIdleCallback(() => { void run(); });
	} else {
		mainWindow.setTimeout(() => { void run(); }, 1_000);
	}
}

/**
 * xlsx の1シートをPC版ビューアと同じ見た目の静的HTMLへレンダリングする。
 * シート単位の遅延読み込み(モバイルのネイティブタブが切替時に個別要求する)に加え、
 * レンダリング結果をLRUキャッシュし、隣のシートをアイドル時に先読みする。
 */
export async function renderSpreadsheetMobileSheet(fileService: IFileService, sharedProcessService: ISharedProcessService, resource: URI, sheetIndex: number): Promise<IParadisMobileSheetResult> {
	const stat = await fileService.stat(resource);
	const mtime = stat.mtime ?? 0;
	const key = `${resource.toString()}|${mtime}|${sheetIndex}`;
	let result = cacheGet(key);
	if (!result) {
		result = await renderSheetUncached(fileService, sharedProcessService, resource, sheetIndex, mtime);
		cacheSet(key, result);
	}
	// クランプ後のインデックスでもヒットするよう二重登録(コスト:参照共有のみ)
	cacheSet(`${resource.toString()}|${mtime}|${result.sheet}`, result);
	schedulePrefetch(fileService, sharedProcessService, resource, result.sheet + 1, mtime, result.sheets.length);
	schedulePrefetch(fileService, sharedProcessService, resource, result.sheet - 1, mtime, result.sheets.length);
	return result;
}

/**
 * xlsx の差分(旧版 vs 新版)を縦積みの静的HTMLへレンダリングする。
 * PC版差分ビューアと同じセル差分計算(buildDiffSheets)・色分け・図形差分を使う。
 * originalResource が読めない場合(新規追加ファイル等)は空ブックとの比較になる。
 */
export async function renderSpreadsheetDiffMobileHtml(
	fileService: IFileService,
	sharedProcessService: ISharedProcessService,
	originalResource: URI,
	modifiedResource: URI,
	originalLabel: string,
	modifiedLabel: string,
): Promise<string> {
	const emptyWorkbook: IParadisWorkbookData = { sheets: [] };
	const [original, modified] = await Promise.all([
		parseSpreadsheetResource(fileService, sharedProcessService, originalResource).catch(() => emptyWorkbook),
		parseSpreadsheetResource(fileService, sharedProcessService, modifiedResource).catch(() => emptyWorkbook),
	]);
	const css = await loadSpreadsheetCss(fileService);
	const diffSheets = buildDiffSheets(original.sheets, modified.sheets);
	if (diffSheets.length === 0) {
		throw new Error('変更はありません');
	}
	return withMeasureHost((host, doc) => {
		const deduper = new InlineStyleDeduper();
		const sections: ISectionEntry[] = [];
		for (const sheet of diffSheets) {
			const naturalWidth = PARADIS_ROW_NUM_COL_WIDTH + sheet.columnWidths.reduce((s, w) => s + w, 0);
			const shapeDiff = buildShapeDiff(sheet.originalShapes, sheet.modifiedShapes);
			const wrap = doc.createElement('div');

			const buildSide = (rows: readonly IParadisDiffRow[], label: string, side: 'original' | 'modified', renders: readonly IParadisShapeRender[] | undefined, minCol: number | undefined) => {
				const labelEl = doc.createElement('div');
				labelEl.className = 'pm-pane-label';
				labelEl.textContent = label;
				wrap.appendChild(labelEl);
				const inner = doc.createElement('div');
				inner.className = 'paradis-spreadsheet-inner';
				inner.style.width = `${naturalWidth}px`;
				const pane = buildDiffPaneDom(rows, sheet.columnWidths, naturalWidth, doc);
				inner.appendChild(pane.table);
				wrap.appendChild(inner);
				host.appendChild(wrap);
				applyOverflow(pane.overflowCells);
				if (renders && renders.length > 0 && minCol !== undefined) {
					const overlay = buildShapeDiffOverlay(renders, side, measureRowY(pane.dataRows), sheet.columnWidths, minCol, doc);
					if (overlay) {
						inner.appendChild(overlay);
					}
				}
			};

			buildSide(sheet.originalRows, `${sheet.name} — ${originalLabel}`, 'original', shapeDiff.originalRenders, sheet.originalMinCol);
			buildSide(sheet.modifiedRows, `${sheet.name} — ${modifiedLabel}`, 'modified', shapeDiff.modifiedRenders, sheet.modifiedMinCol);

			deduper.apply(wrap);
			const suffix = sheet.sheetStatus === 'added' ? ' (追加)' : sheet.sheetStatus === 'removed' ? ' (削除)' : '';
			sections.push({ name: `${sheet.name}${suffix}`, html: wrap.outerHTML, naturalWidth });
			wrap.remove();
		}
		return assembleWithinBudget(css, sections, [], deduper);
	});
}
