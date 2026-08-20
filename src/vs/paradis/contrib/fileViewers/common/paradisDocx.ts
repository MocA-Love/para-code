/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word(.docx)差分ビューアで renderer と webview が共有する語彙。
//
// 役割分担:
//   webview  … vendored docx-preview で .docx を2つパースし、AST から「ブロック概要」(IParadisDocxOutline)
//               だけを抜き出して renderer へ渡す。差分結果を受け取ったら AST に注釈を注入して描画する。
//   renderer … 受け取った2つの outline を buildDocxDiff() で突き合わせ、注釈(IParadisDocxAnnotation)と
//               ゴースト(IParadisDocxFiller)を返す。ここが純TSなのでユニットテストできる。
//
// AST そのものを renderer へ送らないのは、docx-preview が描画時に `parent` を張って循環参照にするため
// （postMessage の構造化クローンで落ちる）。送るのは常にこのファイルの型だけに限る。

/** ブロックの種別。いまは段落のみ（表のセル内段落も同じ paragraph として平坦に並べる）。 */
export type ParadisDocxBlockKind = 'paragraph';

/**
 * 文字を持たない run の種別。docx-preview の AST では run の子に現れる。
 * 文字差分ではこれらを分割せず、run（またはその子）単位でまとめて印を付ける。
 */
export type ParadisDocxRunSpecial = 'object' | 'break' | 'tab';

/** 左右どちらのペインか。 */
export type ParadisDocxSide = 'original' | 'modified';

/**
 * 段落を構成する run 1つ分。docx-preview の AST の `run` ノード1つに対応する。
 * `text` はその run が実際に描画する文字を連結したもので、図・脚注参照などの不可分な対象は
 * U+FFFC(OBJECT REPLACEMENT CHARACTER)1文字として数える。
 */
export interface IParadisDocxRun {
	readonly text: string;
	/** 書式の正規化キー（IParadisDocxOutline.formats の添字）。空文字は「直接書式なし」。 */
	readonly fmt: string;
	/** テキストを一切持たない run のときだけ設定する（画像のみの run 等）。 */
	readonly special?: ParadisDocxRunSpecial;
}

/** 差分の突き合わせ単位。docx-preview の AST の段落ノード1つに対応する。 */
export interface IParadisDocxBlock {
	/** webview 側が保持する AST ノード配列の添字。注釈を戻すときの唯一のキー。 */
	readonly index: number;
	readonly kind: ParadisDocxBlockKind;
	/** runs のテキストを連結したもの（正規化前）。 */
	readonly text: string;
	/** 段落スタイル名（'Heading1' 等）。未指定なら undefined。 */
	readonly styleName?: string;
	/** 箇条書き/番号付きリストの識別子（`${numbering.id}:${numbering.level}`）。 */
	readonly listKey?: string;
	/** 表のネスト深さ。本文直下は 0。 */
	readonly depth: number;
	/** 段落自身の書式（配置・字下げ等）の正規化キー。 */
	readonly fmt?: string;
	/** 段落に含まれる図・画像の識別子（出現順）。画像の差し替えを検出するために使う。 */
	readonly objects?: readonly string[];
	readonly runs: readonly IParadisDocxRun[];
}

/** webview → renderer で渡す1文書分の概要。 */
export interface IParadisDocxOutline {
	readonly blocks: readonly IParadisDocxBlock[];
	/**
	 * 書式キー → 実際の CSS プロパティ（`font-weight` 等）。文書内で重複排除してあるので、
	 * run ごとに書式オブジェクトを持たせるより軽い。ツールチップ文言の生成に使う。
	 */
	readonly formats: Readonly<Record<string, Readonly<Record<string, string>>>>;
	/** ブロック数の上限で打ち切った場合に true。 */
	readonly truncated?: boolean;
}

/** 変更の種別。 */
export type ParadisDocxChangeStatus = 'added' | 'removed' | 'modified' | 'moved' | 'formatChanged';

/** 段落内の印の種別。 */
export type ParadisDocxSegmentType = 'added' | 'removed' | 'format';

/** 書式の変更1件。表示文言（「太字が追加されました」等）は presentation 層で作る。 */
export interface IParadisDocxFormatChange {
	/** CSS プロパティ名、または `_va`(上付き下付き) / `_style`(文字スタイル名)。 */
	readonly property: string;
	readonly original?: string;
	readonly modified?: string;
}

/** 段落内の文字範囲に付ける印。範囲は run 内オフセット（`[start, end)`）。 */
export interface IParadisDocxSegment {
	readonly run: number;
	readonly start: number;
	readonly end: number;
	readonly type: ParadisDocxSegmentType;
	/** 書式変更のとき、何がどう変わったか。 */
	readonly format?: readonly IParadisDocxFormatChange[];
	/**
	 * ツールチップ本文。差分アルゴリズムは埋めず、送信直前に presentation 層が
	 * `format` から組み立てて入れる（webview では nls を使えないため）。
	 */
	readonly detail?: string;
}

/** 1ブロックに付ける注釈。webview はこれを見て AST の cssStyle に属性を注入する。 */
export interface IParadisDocxAnnotation {
	readonly side: ParadisDocxSide;
	readonly index: number;
	readonly status: ParadisDocxChangeStatus;
	readonly changeId: number;
	readonly segments?: readonly IParadisDocxSegment[];
	/** 段落自身の書式変更（配置・字下げ等）。 */
	readonly blockFormat?: readonly IParadisDocxFormatChange[];
	/** 段落自身の書式変更のツールチップ本文（presentation 層が埋める）。 */
	readonly detail?: string;
}

/**
 * 片側にしか無いブロックの代わりに、反対側へ差し込む合成段落（ゴースト）。
 * 左右の段落数を揃えて縦位置のずれを防ぐためのもので、中身は反対側のテキストの写し。
 *
 * 表の中の段落には作らない（対応するセルが相手側に存在しないことがあり、構造を壊すため）。
 */
export interface IParadisDocxFiller {
	/** ゴーストを挿入する側。 */
	readonly side: ParadisDocxSide;
	/** この側のブロック index の直後に挿入する。-1 は本文の先頭。 */
	readonly afterIndex: number;
	readonly text: string;
	/** 反対側で何が起きたか。 */
	readonly kind: 'added' | 'removed' | 'moved';
	readonly changeId: number;
}

/** Prev/Next のナビ対象になる変更1件。 */
export interface IParadisDocxChange {
	readonly id: number;
	readonly status: ParadisDocxChangeStatus;
	readonly originalIndex?: number;
	readonly modifiedIndex?: number;
	/** 一覧に出す抜粋（表示文言は UI 層で組み立てる）。 */
	readonly excerpt: string;
}

/** 上限に当たって精度を落とした理由。UI に「簡易表示」と出すために使う。 */
export type ParadisDocxDegradeReason = 'blocks' | 'align' | 'chars';

export interface IParadisDocxDiffResult {
	readonly changes: readonly IParadisDocxChange[];
	readonly annotations: readonly IParadisDocxAnnotation[];
	readonly fillers: readonly IParadisDocxFiller[];
	/** 精度を落とした場合の理由（複数あり得る）。 */
	readonly degraded?: readonly ParadisDocxDegradeReason[];
}

// ── 上限 ────────────────────────────────────────────────────────────────

/** 1ファイルの読み込み上限。左右2文書を同時に AST + DOM で持つので Excel より控えめにする。 */
export const PARADIS_DOCX_MAX_BYTES = 32 * 1024 * 1024;
/** これを超えるブロック数の文書は打ち切る（それ以降は差分を取らない）。 */
export const PARADIS_DOCX_MAX_BLOCKS = 20_000;
/** 段落の文字差分を諦めて「まるごと置換」に落とす閾値。 */
export const PARADIS_DOCX_MAX_CHAR_DIFF_LENGTH = 20_000;
/** 変更領域内の再マッチングで DP を使う上限（原文数 × 新文数）。超えたら位置ペアリングに落とす。 */
export const PARADIS_DOCX_ALIGN_CELL_BUDGET = 40_000;
/** 「同じ段落が移動した」と見なすのに必要な最短の正規化テキスト長。 */
export const PARADIS_DOCX_MOVE_MIN_LENGTH = 4;
/** 変更領域内で「対応する段落」と見なす類似度の下限。 */
export const PARADIS_DOCX_SIMILARITY_THRESHOLD = 0.5;
/** ゴーストに写すテキストの最大長（長文をそのまま複製しない）。 */
export const PARADIS_DOCX_FILLER_TEXT_LIMIT = 400;
/** 変更一覧に出す抜粋の最大長。 */
export const PARADIS_DOCX_EXCERPT_LIMIT = 80;

/**
 * 図・脚注参照など、文字として分割できない対象を表す1文字（U+FFFC OBJECT REPLACEMENT CHARACTER）。
 * ソースに生の U+FFFC を置くと hygiene の非ASCII検査に引っかかるので、コードポイントから作る。
 */
export const PARADIS_DOCX_OBJECT_CHAR = String.fromCharCode(0xFFFC);

// ── 注釈の受け渡しに使う DOM 属性名 ──────────────────────────────────────
//
// docx-preview は `cssStyle` のキーが `$` で始まるとき `setAttribute(key.slice(1), value)` を
// 呼ぶ（renderStyleValues）。この隙間を使うと vendored ライブラリに一切手を入れずに
// 出力 DOM へ印を付けられる。
//
// 注意1: `className` は `renderClass` が**代入で上書き**するため使わない（属性注入なら無傷）。
// 注意2: `renderStyleValues` を通るのは paragraph / run / table / row / cell / hyperlink /
//        drawing / image のみ。text / tab / break / symbol / inserted / deleted は通らないので、
//        印は必ず run 以上の粒度に落とすこと。

export const PARADIS_DOCX_DIFF_ATTR = 'data-paradis-diff';
export const PARADIS_DOCX_CHANGE_ATTR = 'data-paradis-change';
export const PARADIS_DOCX_SEG_ATTR = 'data-paradis-seg';
export const PARADIS_DOCX_GHOST_ATTR = 'data-paradis-ghost';
/**
 * 書式変更の説明を載せる属性。**`title` であることに意味がある**。
 * webview の中身は docx-preview が作るので、独自属性にするとホバーの実装を自前で書くことになる。
 * `title` にしておけばブラウザ標準のツールチップがそのまま出る。
 */
export const PARADIS_DOCX_DETAIL_ATTR = 'title';

// ── 書式として比較する CSS プロパティ ────────────────────────────────────
//
// docx-preview は rPr / pPr を CSS プロパティ名で `cssStyle` に格納する（`props` は存在しない）。
// 許可リスト方式にしておくと、レイアウト由来のノイズ（幅・高さ等）が差分に混ざらない。

/** run（文字）の書式として比較するキー。 */
export const PARADIS_DOCX_RUN_FORMAT_KEYS: readonly string[] = [
	'font-weight',
	'font-style',
	'text-decoration',
	'text-decoration-color',
	'color',
	'font-size',
	'font-family',
	'background-color',
	'text-transform',
	'font-variant',
	'vertical-align',
	'verticalAlign',
	'letter-spacing',
	'direction',
];

/** 段落自身の書式として比較するキー。 */
export const PARADIS_DOCX_BLOCK_FORMAT_KEYS: readonly string[] = [
	'text-align',
	'margin-left',
	'margin-right',
	'margin-top',
	'margin-bottom',
	'text-indent',
	'line-height',
	'background-color',
	'border-top',
	'border-bottom',
	'border-left',
	'border-right',
	'direction',
];

/** 上付き/下付き（docx-preview では run.verticalAlign にトップレベル格納される）の擬似キー。 */
export const PARADIS_DOCX_VERTICAL_ALIGN_KEY = '_va';
/** 文字スタイル名（rStyle）の擬似キー。 */
export const PARADIS_DOCX_CHAR_STYLE_KEY = '_style';
/** 段落スタイル名（pStyle。「見出し1」等）の擬似キー。 */
export const PARADIS_DOCX_PARAGRAPH_STYLE_KEY = '_pstyle';
/** 箇条書き/番号付きリストの擬似キー。 */
export const PARADIS_DOCX_LIST_KEY = '_list';

/** 書式オブジェクトを比較用の正規化キーにする。キー順に依存しない安定した文字列を返す。 */
export function docxFormatKey(format: Readonly<Record<string, string>> | undefined): string {
	if (!format) {
		return '';
	}
	const keys = Object.keys(format).sort();
	if (keys.length === 0) {
		return '';
	}
	return keys.map(k => `${k}=${format[k]}`).join(';');
}

// ── テキスト正規化 ──────────────────────────────────────────────────────

/**
 * ブロックの対応付けに使う正規化。前後の空白を落とし、連続する空白（全角空白・タブ・改行を含む）を
 * 半角空白1つに畳む。
 *
 * 全角/半角の統一（NFKC 等）は**しない**。日本語文書では「Ａ」と「A」の違いは利用者にとって
 * 実際の変更であり、畳んでしまうと差分として見えなくなる。
 */
export function normalizeDocxText(text: string): string {
	// JS の \s は U+3000(全角空白)・U+00A0(NBSP) を含むので、これだけで日本語文書にも足りる。
	return text.replace(/\s+/g, ' ').trim();
}

/** 対応付けの第1段で使う、ブロックの指紋。ここが一致したものだけを「不変」と見なす。 */
export function docxBlockKey(block: IParadisDocxBlock): string {
	const objects = block.objects?.length ? block.objects.join(',') : '';
	return `${block.kind}|${block.depth}|${block.styleName ?? ''}|${block.listKey ?? ''}|${objects}|${normalizeDocxText(block.text)}`;
}

// ── renderer ⇄ webview のメッセージ ─────────────────────────────────────

/** vendored の docx-preview / jszip が読み込めていないときのエラーコード。文言は renderer 側で付ける。 */
export const PARADIS_DOCX_ERROR_LIBRARY_MISSING = 'paradis.docx.libraryMissing';

/** renderer → webview。 */
export type ParadisDocxHostMessage =
	// generation は読み直しの世代。webview は概要を返すときにそのまま反射して返す。
	| { readonly type: 'load'; readonly generation: number; readonly original: ArrayBuffer; readonly modified: ArrayBuffer }
	| {
		readonly type: 'annotate';
		readonly annotations: readonly IParadisDocxAnnotation[];
		readonly fillers: readonly IParadisDocxFiller[];
	}
	| { readonly type: 'reveal'; readonly changeId: number }
	| { readonly type: 'zoom'; readonly scale: number }
	| { readonly type: 'showFormatChanges'; readonly enabled: boolean };

/** webview → renderer。 */
export type ParadisDocxWebviewMessage =
	// webview 内のスクリプトが受信を始めた合図。これを待たずに 'load' を送ると取りこぼす。
	| { readonly type: 'ready' }
	| { readonly type: 'outline'; readonly generation: number; readonly original: IParadisDocxOutline; readonly modified: IParadisDocxOutline }
	| { readonly type: 'rendered' }
	| { readonly type: 'activeChange'; readonly changeId: number }
	| { readonly type: 'error'; readonly side?: ParadisDocxSide; readonly message: string };
