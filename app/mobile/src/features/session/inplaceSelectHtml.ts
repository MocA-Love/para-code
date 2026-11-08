// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { scaleChatSize, type ChatTextScale } from '../../chatTextScale.js';
import { BULLET_INDENT, tableColumnWidths } from '../../components/markdownLayout.js';
import { MAX_BULLET_DEPTH, parseBlocks, parseInline, type Block, type InlineToken } from '../../components/markdownParse.js';
import type { HighlightData } from '../../components/codeHighlightCache.js';
import { alpha, colors, mono, tint, type } from '../../theme.js';
import { escapeHtml } from '../code/fileViewerModel.js';
import { viewerScriptContentSecurityPolicy } from '../code/fileFind.js';

/**
 * その場で範囲を選ぶ（Q551 案 4）ときに、発言の表示と差し替える WebView の HTML。RN を持たない純関数。
 *
 * - 本文は会話の描画（`markdownText.tsx`）と同じ `parseBlocks` / `parseInline` で読み、同じ寸法（字・行間・余白・
 *   コードの帯・表の列の幅・引用の棒）の CSS で描く。差し替えた瞬間に字の位置がずれて跳ねないようにするため
 *   （ファイルのビューアの `buildMarkdownHtml` は marked で読むのでブロックの切れ方が違い、字も 15/24 で大きい）
 * - 発言から来た文字は、すべて `escapeHtml` を通して要素の中身にだけ置く（属性には入れない。`escapeHtml` は引用符を
 *   変えないため）。リンクは `href` を持たない色付きの文字にして、押しても遷移しない
 * - CSP は既定ですべて止め、nonce 付きのスクリプト 1 つと style だけを開ける（{@link inplaceSelectContentSecurityPolicy}）。スクリプトは高さを知らせることと、押した点の単語（無ければ全体）を選ぶこと・押し続けた点の単語を選ぶことだけをする
 * - 発言は `segments` の並びで受ける。押した発言 1 つだけのとき（発言の上に重ねる）と、前後の発言をまとめて並べるとき
 *   （会話の一覧の上に重ねて中でスクロールする。`crossSelect.tsx`。{@link InplaceSelectScrollLayout}）がある
 * - コードは、会話の描画が PC から取ってある色付け（`codeHighlightCache.ts`）があればその色と地の色で描く
 */

/** 差し替える発言 1 つ。 */
export interface InplaceSelectSegment {
	/** 発言の元の文字（エージェントは Markdown）。 */
	readonly text: string;
	/** Markdown として描くか（自分の発言は false。吹き出しの字で、そのまま描く）。 */
	readonly markdown: boolean;
	/** Markdown でない発言の字。既定は吹き出しの字（`bubble`）。過去の会話の自分の発言は本文の字（`body`）。 */
	readonly plain?: 'bubble' | 'body';
	/** 発言の前に出す見出し（誰の発言か。前後の発言をまとめて選ぶとき）。選べない（写すときに入らない）。 */
	readonly label?: string;
}

/**
 * 前後の発言をまとめて選ぶとき（会話の一覧の上に重ね、WebView の中でスクロールする）の置き方。押した発言
 * （`anchor` 番目の発言）が、重ねる前と同じ位置に来るようにスクロールして見せる。値はすべて WebView の左上からの pt。
 */
export interface InplaceSelectScrollLayout {
	/** 押した発言の `segments` の中の番号。 */
	readonly anchor: number;
	/** 押した発言の上端の、重ねる前の位置（縦）。 */
	readonly top: number;
	/** 発言の列の左端と幅（会話の一覧の列にそろえる）。 */
	readonly left: number;
	readonly width: number;
	/** 上下に足す余白（一覧の高さ）。端の発言でも、押した発言を元の位置までスクロールできるように。 */
	readonly pad: number;
}

/** 会話の描画に合わせるための値（画面の側で集めて渡す）。 */
export interface InplaceSelectLook {
	/** 会話の文字サイズの設定（`useChatTextScale()`）。 */
	readonly scale: ChatTextScale;
	/** OS の文字の倍率（`useWindowDimensions().fontScale`）。RN の Text は掛けるが、WebView の CSS は掛けないので自分で掛ける。 */
	readonly osFontScale: number;
	/** `StyleSheet.hairlineWidth`。 */
	readonly hairline: number;
	/** 本文の色（エージェントは `colors.text`、自分の発言は吹き出しの上の色）。 */
	readonly fg: string;
	/** リンクの色（設定 → 色の「選択の印・リンク」）。 */
	readonly accent: string;
	/** ファイルのカードのアイコンの台の色。 */
	readonly accentWash: string;
	/** 選んだ範囲の色。 */
	readonly selection: string;
	/** コードブロックの色付けを引く（会話の描画が取ってあるもの。無ければ色を付けない）。 */
	readonly codeHighlight?: (text: string, lang: string | undefined) => HighlightData | undefined;
}

/** 押した点（WebView の左上からの pt）。ここの単語を選んだ状態で開く。 */
export interface InplaceSelectPoint {
	readonly x: number;
	readonly y: number;
}

/** WebView から届く知らせ。`ready` は描き終えた（まだ選ばない）、`height` は中身の高さが変わった。 */
export interface InplaceSelectMessage {
	readonly kind: 'ready' | 'height';
	readonly height: number;
}

/** 知らせの高さの上限（壊れた値で一覧を伸ばさない）。 */
const MAX_REPORTED_HEIGHT = 200_000;

/** WebView の `onMessage` の `data` を読む。形が違うものは捨てる。 */
export function parseInplaceSelectMessage(data: unknown): InplaceSelectMessage | undefined {
	if (typeof data !== 'string' || data.length > 200) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const kind = (value as { type?: unknown }).type;
	const height = (value as { height?: unknown }).height;
	if ((kind !== 'ready' && kind !== 'height') || typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
		return undefined;
	}
	return { kind, height: Math.min(MAX_REPORTED_HEIGHT, Math.ceil(height)) };
}

/**
 * 差し替えている間の行の最小の高さ。WebView の中身が元の表示より高いときだけ、その高さまで行を伸ばす
 * （低いときは元の表示の高さのまま。一覧の行の高さを変えない）。
 */
export function inplaceSelectMinHeight(nativeHeight: number | undefined, webHeight: number | undefined): number | undefined {
	if (webHeight === undefined) {
		return undefined;
	}
	return nativeHeight === undefined || webHeight > nativeHeight + 0.5 ? webHeight : undefined;
}

/**
 * 押した点を WebView の中の点に直す。触れた点（画面の座標）と、包んだ部品の画面の上の四角から求める。
 * 四角の外・古い（`maxAgeMs` より前の）触れた点は使わない（iPad の右クリックなど、触れずにメニューを開いたとき）。
 */
export function localPressPoint(
	touch: { readonly pageX: number; readonly pageY: number; readonly at: number } | undefined,
	frame: { readonly pageX: number; readonly pageY: number; readonly width: number; readonly height: number },
	now: number,
	maxAgeMs = 15_000,
): InplaceSelectPoint | undefined {
	if (touch === undefined || now - touch.at > maxAgeMs || now < touch.at) {
		return undefined;
	}
	const x = touch.pageX - frame.pageX;
	const y = touch.pageY - frame.pageY;
	if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > frame.width || y > frame.height) {
		return undefined;
	}
	return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

/** 寸法の計算（`chatTextScale.ts` の `scaleChatStyle` と同じ掛け方）。 */
interface Metrics {
	/** 字の大きさ・行の高さ（OS の倍率まで掛けた px）。 */
	readonly font: (value: number) => number;
	/** 縦の余白・間隔（割合の半分だけ広げる）。 */
	readonly spacing: (value: number) => number;
	/** アイコン・字下げ（割合そのもの）。 */
	readonly layout: (value: number) => number;
}

function metricsOf(look: InplaceSelectLook): Metrics {
	const os = Number.isFinite(look.osFontScale) && look.osFontScale > 0 ? look.osFontScale : 1;
	const spacingScale = 1 + (look.scale.layout - 1) / 2;
	return {
		font: value => Math.round(value * look.scale.font * os * 100) / 100,
		spacing: value => Math.round(value * spacingScale * 2) / 2,
		layout: value => scaleChatSize(value, look.scale),
	};
}

function inlineHtml(tokens: readonly InlineToken[]): string {
	return tokens.map(token => {
		switch (token.kind) {
			case 'code':
				return `<span class="ic">${escapeHtml(token.text)}</span>`;
			case 'bold':
				return `<span class="b">${escapeHtml(token.text)}</span>`;
			case 'external':
			case 'local':
				return `<span class="a">${escapeHtml(token.label)}</span>`;
			default:
				return escapeHtml(token.text);
		}
	}).join('');
}

/** 本文の段落（ファイルのリンクはカードにして、前後の文字と分ける。`markdownText.tsx` の InlineBlock と同じ）。 */
function inlineBlockHtml(text: string): string {
	const tokens = parseInline(text);
	if (!tokens.some(token => token.kind === 'local')) {
		return `<div class="p">${inlineHtml(tokens)}</div>`;
	}
	const groups: InlineToken[][] = [];
	for (const token of tokens) {
		const last = groups[groups.length - 1];
		if (token.kind !== 'local' && last !== undefined && last[0]?.kind !== 'local') {
			last.push(token);
		} else {
			groups.push([token]);
		}
	}
	const parts = groups.map(group => {
		const local = group[0];
		if (local?.kind === 'local') {
			const name = local.target.path.split(/[\\/]/).pop() ?? local.target.path;
			const location = local.target.line !== undefined ? ` · 行 ${local.target.line}${local.target.column !== undefined ? `、列 ${local.target.column}` : ''}` : '';
			return `<div class="fc"><div class="fi"></div><div class="fn"><div class="fl">${escapeHtml(local.label || name)}</div><div class="fp">${escapeHtml(local.target.path)}${escapeHtml(location)}</div></div><div class="fv"></div></div>`;
		}
		return `<div class="p">${inlineHtml(group)}</div>`;
	});
	return `<div class="st">${parts.join('')}</div>`;
}

function alignAttr(align: string | undefined): string {
	return align === 'center' ? ' class="ac"' : align === 'right' ? ' class="ar"' : '';
}

function tableHtml(block: Extract<Block, { kind: 'table' }>, look: InplaceSelectLook): string {
	const cols = block.header.length;
	const widths = tableColumnWidths(block, cols, look.scale);
	// 本物の表にする（選んで写すと行ごとに 1 行・セルはタブで区切られる。メニューの「テキストをコピー」と同じ形）
	const colgroup = `<colgroup>${widths.map(width => `<col style="width:${width}px">`).join('')}</colgroup>`;
	const cell = (text: string, c: number, head: boolean) => {
		const tag = head ? 'th' : 'td';
		return `<${tag}${alignAttr(block.aligns[c])}>${inlineHtml(parseInline(text))}</${tag}>`;
	};
	const head = `<tr class="hd">${block.header.map((text, c) => cell(text, c, true)).join('')}</tr>`;
	const rows = block.rows.map((row, r) => `<tr${r % 2 === 1 ? ' class="alt"' : ''}>${Array.from({ length: cols }, (_, c) => cell(row[c] ?? '', c, false)).join('')}</tr>`);
	const total = widths.reduce((sum, width) => sum + width, 0);
	return `<div class="tw"><table style="width:${total}px">${colgroup}${head}${rows.join('')}</table></div>`;
}

function blocksHtml(blocks: readonly Block[], look: InplaceSelectLook, metrics: Metrics): string {
	return blocks.map(block => {
		switch (block.kind) {
			case 'code':
				// 見出しの帯（言語名と「折り返し」「コピー」）は会話と同じ高さで描くだけで、選べない・押せない
				return codeBlockHtml(block.text, block.lang, look.codeHighlight?.(block.text, block.lang));
			case 'heading':
				return `<div class="p h${block.level === 1 ? ' h1' : ''}">${inlineHtml(parseInline(block.text))}</div>`;
			case 'bullet': {
				// 印と本文は表のセルにする（flex や中の div だと、選んで写したときに印だけが 1 行になる。セルならタブで続く）
				const tokens = parseInline(block.text);
				const body = tokens.some(token => token.kind === 'local') ? `<div class="bb">${inlineBlockHtml(block.text)}</div>` : `<div class="bb p">${inlineHtml(tokens)}</div>`;
				return `<div class="bl" style="padding-left:${Math.min(block.depth, MAX_BULLET_DEPTH) * metrics.layout(BULLET_INDENT)}px"><div class="br"><span class="bm">${escapeHtml(block.marker)}</span>${body}</div></div>`;
			}
			case 'table':
				return tableHtml(block, look);
			case 'quote':
				return `<div class="q"><div class="qb"></div><div class="qc">${blocksHtml(block.blocks, look, metrics)}</div></div>`;
			case 'rule':
				return '<div class="hr"></div>';
			case 'para':
				return inlineBlockHtml(block.text);
		}
	}).join('');
}

/**
 * コードブロック。色付けがあれば、行ごとの色の片を span にして、PC のテーマの地の色・字の色で描く（会話の描画と同じ）。
 * 色は {@link cssColor} を通したものだけを属性に置く（引用符や `;` を含む値は捨てて色を付けない）。字は `escapeHtml` を通す。
 */
function codeBlockHtml(text: string, lang: string | undefined, highlight: HighlightData | undefined): string {
	const head = `<div class="io"><span class="iol">${escapeHtml(lang ?? 'コード')}</span><span class="ioa">折り返し</span><span class="ioa">コピー</span></div>`;
	if (highlight === undefined) {
		return `<div class="cb">${head}<div class="cc"><div class="ct">${escapeHtml(text)}</div></div></div>`;
	}
	const bg = highlight.bg !== undefined ? safeColor(highlight.bg) : undefined;
	const fg = highlight.fg !== undefined ? safeColor(highlight.fg) : undefined;
	const lines = highlight.lines.map(line => line.map(run => {
		const color = run.color !== undefined ? safeColor(run.color) : undefined;
		const classes = [run.italic === true ? 'ci' : '', run.bold === true ? 'cbd' : ''].filter(name => name.length > 0).join(' ');
		const attrs = `${classes.length > 0 ? ` class="${classes}"` : ''}${color !== undefined ? ` style="color:${color}"` : ''}`;
		return attrs.length > 0 ? `<span${attrs}>${escapeHtml(run.text)}</span>` : escapeHtml(run.text);
	}).join('')).join('\n');
	return `<div class="cb"${bg !== undefined ? ` style="background:${bg}"` : ''}>${head}<div class="cc"><div class="ct"${fg !== undefined ? ` style="color:${fg}"` : ''}>${lines}</div></div></div>`;
}

function segmentHtml(segment: InplaceSelectSegment, look: InplaceSelectLook, metrics: Metrics): string {
	const label = segment.label !== undefined ? `<div class="sp">${escapeHtml(segment.label)}</div>` : '';
	if (!segment.markdown) {
		return `<div class="seg">${label}<div class="${segment.plain === 'body' ? 'p' : 'u'}">${escapeHtml(segment.text)}</div></div>`;
	}
	return `<div class="seg">${label}${blocksHtml(parseBlocks(segment.text), look, metrics)}</div>`;
}

/**
 * iOS の文字（RN の Text）のタブの間隔（pt。`NSParagraphStyle` の既定のタブ位置は 28pt おき）。CSS の既定（8 文字）だと
 * コードの字下げが広がるので、同じ間隔にする。
 */
const NATIVE_TAB_INTERVAL = 28;

/** 数を CSS・スクリプトに置ける形にする（数でなければ 0）。 */
function num(value: number): string {
	return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '0';
}

/** 色を CSS に置ける形にする（`#rrggbb` / `rgba(...)` など、記号の少ない値だけを通す）。 */
function cssColor(value: string, fallback: string): string {
	return safeColor(value) ?? fallback;
}

/**
 * {@link cssColor} と同じ検査。通らない値は `undefined`（色を付けない）。PC から届く色（コードの色付け）も通るので、
 * 色の形だけを許す: `#` の 16 進（3〜8 桁）、`rgb()`・`rgba()`・`hsl()`・`hsla()`（中は数・`%`・`.`・`,`・空白・`/` だけ）、
 * 英字だけの色の名前。`url(`・`var(`・`expression` など、読み込みや計算になる形は弾く。
 */
export function safeColor(value: string): string | undefined {
	const color = value.trim();
	if (color.length === 0 || color.length > 64 || /url\(|var\(|expression/i.test(color)) {
		return undefined;
	}
	return /^#[\da-f]{3,8}$/i.test(color) || /^(?:rgba?|hsla?)\([\d\s.,%/]+\)$/i.test(color) || /^[a-z]+$/i.test(color) ? color : undefined;
}

/**
 * 範囲を選ぶ表示の CSP。既定はすべて止め（`default-src 'none'`）、要るものだけを開ける: nonce 付きのスクリプト 1 つと、
 * `<style>` と要素の `style` 属性（色・寸法）。画像・フォント・通信は使わないので開けない。残りの指定はファイルのビューアと同じ
 * （`viewerScriptContentSecurityPolicy`。nonce の形もそこで検める）。
 */
export function inplaceSelectContentSecurityPolicy(nonce: string): string {
	return `default-src 'none'; style-src 'unsafe-inline'; ${viewerScriptContentSecurityPolicy(nonce)}`;
}

function styleSheet(look: InplaceSelectLook, metrics: Metrics): string {
	const { font, spacing, layout } = metrics;
	const hair = `${num(look.hairline)}px solid ${colors.border}`;
	const fg = cssColor(look.fg, colors.text);
	return `
	html, body { margin: 0; padding: 0; background: transparent; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
	body { color: ${fg}; font-family: -apple-system, system-ui, sans-serif; font-size: ${num(font(type.body))}px; line-height: ${num(font(20))}px; -webkit-user-select: text; user-select: text; -webkit-tap-highlight-color: transparent; }
	::selection { background: ${cssColor(look.selection, colors.accent)}; }
	#m, .seg { display: flex; flex-direction: column; gap: ${num(spacing(6))}px; }
	.p { white-space: pre-wrap; overflow-wrap: break-word; }
	.b, .h { font-weight: 700; }
	.h1 { font-size: ${num(font(type.title))}px; }
	.ic { font-family: ${mono.ios}, ui-monospace, monospace; font-size: ${num(font(type.meta))}px; background: ${tint(colors.idle, alpha.line)}; border-radius: 6px; }
	.a { color: ${cssColor(look.accent, colors.accent)}; text-decoration: underline; }
	.st { display: flex; flex-direction: column; gap: ${num(spacing(6))}px; }
	.br { display: table; width: 100%; table-layout: auto; border-collapse: collapse; }
	.bm { display: table-cell; width: 1px; white-space: nowrap; padding-right: ${num(spacing(6))}px; color: ${colors.textDim}; }
	.bb { display: table-cell; }
	.q { display: flex; gap: ${num(spacing(8))}px; }
	.qb { width: 3px; flex: none; border-radius: 6px; background: ${colors.border}; }
	.qc { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: ${num(spacing(6))}px; opacity: 0.86; }
	.hr { height: ${num(look.hairline)}px; background: ${colors.border}; margin: ${num(spacing(6))}px 0; }
	.cb { background: ${colors.codeBg}; border: 1px solid ${colors.border}; border-radius: 6px; overflow: hidden; }
	.io { display: flex; align-items: center; gap: ${num(spacing(6))}px; padding: ${num(spacing(5))}px 8px; background: rgba(255,255,255,0.035); border-bottom: ${hair}; -webkit-user-select: none; user-select: none; }
	.iol { flex: 1; min-width: 0; color: ${colors.textDim}; font-size: ${num(font(type.badge))}px; line-height: normal; font-weight: 800; letter-spacing: ${num(0.9 * look.scale.layout)}px; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.ioa { min-height: 20px; box-sizing: border-box; display: flex; align-items: center; border: ${hair}; border-radius: 6px; padding: ${num(spacing(2))}px 7px; color: ${colors.textDim}; font-size: ${num(font(type.badge))}px; line-height: normal; }
	.cc { overflow-x: auto; display: flex; }
	.ct { flex: none; min-width: 100%; tab-size: ${num(NATIVE_TAB_INTERVAL)}px; box-sizing: border-box; padding: ${num(spacing(8))}px; color: ${colors.text}; font-family: ${mono.ios}, ui-monospace, monospace; font-size: ${num(font(type.caption))}px; line-height: ${num(font(16))}px; white-space: pre; }
	.tw { border: 1px solid ${colors.border}; border-radius: 6px; overflow-x: auto; margin: ${num(spacing(2))}px 0; }
	table { border-collapse: collapse; table-layout: fixed; border-spacing: 0; }
	tr + tr > th, tr + tr > td { border-top: ${hair}; }
	tr.hd { background: ${tint(colors.idle, alpha.wash)}; }
	tr.alt { background: ${tint(colors.idle, alpha.faint)}; }
	/* セルの字は会話の表と同じ本文の大きさ（RN の表は、セルの中の字に本文の字の形が当たって 14/20 で描かれている） */
	th, td { box-sizing: border-box; padding: ${num(spacing(5))}px 7px; font-size: ${num(font(type.body))}px; line-height: ${num(font(20))}px; text-align: left; vertical-align: top; white-space: pre-wrap; overflow-wrap: break-word; }
	th + th, td + td { border-left: ${hair}; }
	th { font-weight: 700; }
	.ac { text-align: center; }
	.ar { text-align: right; }
	.fc { display: flex; align-items: center; gap: ${num(spacing(10))}px; background: ${colors.glassBg}; border: 1px solid ${colors.glassBorder}; border-radius: 6px; padding: ${num(spacing(10))}px 11px; }
	.fi { width: ${num(layout(32))}px; height: ${num(layout(32))}px; flex: none; border-radius: 6px; background: ${cssColor(look.accentWash, colors.accentWash)}; }
	.fn { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: ${num(spacing(2))}px; }
	.fl { font-size: ${num(font(type.body))}px; line-height: normal; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.fp { color: ${colors.textDim}; font-family: ${mono.ios}, ui-monospace, monospace; font-size: ${num(font(type.badge))}px; line-height: ${num(font(14))}px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
	.fv { width: ${num(layout(18))}px; flex: none; }
	.ci { font-style: italic; }
	.cbd { font-weight: 700; }
	.sp { color: ${colors.textDim}; font-size: ${num(font(type.caption))}px; line-height: ${num(font(16))}px; font-weight: 600; -webkit-user-select: none; user-select: none; }
	#m.across { gap: ${num(spacing(14))}px; box-sizing: border-box; }
	.u { font-size: ${num(font(type.chat))}px; line-height: ${num(font(23))}px; font-weight: 500; white-space: pre-wrap; overflow-wrap: break-word; }
`;
}

/** 押し続けたとみなすまでの時間（ms）と、指が動いたとみなす距離（px）。OS の長押しの選択が届かなかったときの代わり。 */
const HOLD_MS = 500;
const HOLD_SLOP = 10;

/**
 * 高さを知らせ、選ぶための関数を置くスクリプト。
 *
 * - 読み込んだ時点では選ばない。透明で first responder でもない WebView で選ぶと、WebKit は DOM の選択だけを持ち、
 *   つまみも OS のメニューも出さない（その後の長押しも効かなくなることがある）。呼び出し側が見せて
 *   `requestFocus()` した後に {@link inplaceSelectStartScript} で `__paraSelectStart` を呼ぶ
 * - 押した点の単語を選ぶ。押した点が無い・字の上でないときは発言の全体を選ぶ（入ったら必ず何かが選ばれているように）。
 *   前後の発言をまとめて並べたときは、押した発言の本文だけ（見出しを除く）を選ぶ
 *   呼び出し側は first responder になるのが遅れたときのために数回呼ぶので、2 回目からは何も選ばれていないときだけ選ぶ
 * - 押し続けたら（{@link HOLD_MS}）その点の単語を選ぶ。OS の長押しの選択が先に選んでいたら何もしない。
 *   `touchcancel` では止めない（OS の長押しが認識されると、ページへの触れは取り消されるため）
 */
function selectScript(point: InplaceSelectPoint | undefined, layout: InplaceSelectScrollLayout | undefined): string {
	const at = point !== undefined ? `[${num(point.x)},${num(point.y)}]` : 'null';
	// 前後の発言をまとめて選ぶとき: 押した発言の番号と、元の上端の位置。描き終えたらそこへスクロールしてから知らせる
	const place = layout !== undefined ? `[${Math.max(0, Math.floor(layout.anchor))},${num(layout.top)}]` : 'null';
	return `(function(){
var root=document.getElementById('m');
function post(kind){try{window.ReactNativeWebView.postMessage(JSON.stringify({type:kind,height:Math.ceil(root.getBoundingClientRect().height)}));}catch(e){}}
function word(s){if(s.modify){s.modify('move','backward','word');s.modify('extend','forward','word');}}
function selectAt(p){var s=window.getSelection();if(!s){return false;}if(p&&document.caretRangeFromPoint){var r=document.caretRangeFromPoint(p[0],p[1]);if(r&&root.contains(r.startContainer)&&r.startContainer.nodeType===3){s.removeAllRanges();s.addRange(r);word(s);if(!s.isCollapsed){return true;}}}return false;}
function selectAll(){var s=window.getSelection();if(!s){return;}s.removeAllRanges();var el=lay?root.querySelectorAll('.seg')[lay[0]]:null;if(el){var sp=el.querySelector('.sp');var r=document.createRange();if(sp&&sp.nextElementSibling){r.setStartBefore(sp.nextElementSibling);}else{r.setStart(el,0);}r.setEnd(el,el.childNodes.length);s.addRange(r);return;}s.selectAllChildren(root);}
var started=false;
window.__paraSelectStart=function(){try{var s=window.getSelection();if(started&&s&&!s.isCollapsed){return;}started=true;if(!selectAt(${at})){selectAll();}}catch(e){}};
var hold=null,from=null;
function stopHold(){if(hold!==null){clearTimeout(hold);hold=null;}}
document.addEventListener('touchstart',function(e){stopHold();if(e.touches.length!==1){return;}var t=e.touches[0];from=[t.clientX,t.clientY];hold=setTimeout(function(){hold=null;try{var s=window.getSelection();if(s&&s.isCollapsed){selectAt(from);}}catch(x){}},${HOLD_MS});},{passive:true});
document.addEventListener('touchmove',function(e){var t=e.touches[0];if(from&&t&&Math.abs(t.clientX-from[0])+Math.abs(t.clientY-from[1])>${HOLD_SLOP}){stopHold();}},{passive:true});
document.addEventListener('touchend',stopHold,{passive:true});
var lay=${place};
function placeAnchor(){if(!lay){return;}var el=root.querySelectorAll('.seg')[lay[0]];if(!el){return;}var sp=el.querySelector('.sp');var t=sp&&sp.nextElementSibling?sp.nextElementSibling:el;window.scrollTo(0,Math.max(0,t.getBoundingClientRect().top+window.scrollY-lay[1]));}
var done=false;
function ready(){if(done){return;}done=true;try{placeAnchor();}catch(e){}post('ready');if(window.ResizeObserver){new ResizeObserver(function(){post('height');}).observe(root);}}
if(document.readyState==='complete'){ready();}else{window.addEventListener('load',ready);}
})();`;
}

/**
 * 見せて `requestFocus()` した後に WebView へ流す文（`injectJavaScript`）。押した点の単語か発言の全体を選ぶ。
 * 発言の文字は含まない（押した点は HTML の nonce 付きのスクリプトが持つ）。
 */
export function inplaceSelectStartScript(): string {
	return 'window.__paraSelectStart&&window.__paraSelectStart();true;';
}

/**
 * 差し替える WebView の HTML。`nonce` は `createMobileOfficeNonce()` で作り、HTML を作るたびに新しくする。
 * `layout` を渡すと、前後の発言をまとめて選ぶ形（中でスクロールし、押した発言を元の位置に合わせる）にする。
 */
export function buildInplaceSelectHtml(segments: readonly InplaceSelectSegment[], look: InplaceSelectLook, nonce: string, point?: InplaceSelectPoint, layout?: InplaceSelectScrollLayout): string {
	const metrics = metricsOf(look);
	const body = segments.map(segment => segmentHtml(segment, look, metrics)).join('');
	const root = layout !== undefined
		? `<div id="m" class="across" style="padding:${num(Math.max(0, layout.pad))}px 0;margin-left:${num(Math.max(0, layout.left))}px;width:${num(Math.max(1, layout.width))}px">`
		: '<div id="m">';
	return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${inplaceSelectContentSecurityPolicy(nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>${styleSheet(look, metrics)}</style>
</head><body>${root}${body}</div><script nonce="${nonce}">${selectScript(point, layout)}</script></body></html>`;
}
