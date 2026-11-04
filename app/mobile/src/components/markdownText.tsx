// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * エージェント応答向けの軽量Markdownレンダラ（依存ゼロ）。読む記法は `markdownParse.ts` を参照。
 * それ以外はプレーンテキストとして安全に表示する（未対応記法で壊れない）。
 */

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../appState.js';
import { alpha, colors, radius, squircle, tint, type } from '../theme.js';
import { monoFamily } from '../monoFont.js';
import { scaleChatSize, type ChatTextScale } from '../chatTextScale.js';
import { useChatIconSize, useChatStyles, useChatTextScale } from '../ui/chatTextScale.js';
import { useThemeColors } from '../ui/themeColorsStore.js';
import type { LocalFileTarget } from '../localFileTarget.js';
import { IOBar } from './agentIoBlock.js';
import { ContextMenu, useContextMenuSheet } from './contextMenu.js';
import type { ContextMenuOps, ContextMenuSpec } from './contextMenuModel.js';
import { contextMenuOps } from './copyActions.js';
import { buildExternalLinkMenu, buildLocalFileLinkMenu } from './linkMenu.js';
import { HorizontalScrollFade } from './horizontalScrollFade.js';
import { localFileTargetKey, useLocalFileOpener } from './localFileOpener.js';
import { MAX_BULLET_DEPTH, parseBlocks, parseInline, type Block, type InlineToken } from './markdownParse.js';

/** 表セルの表示幅（fontSize 12 相当）。全角は2文字ぶんとして数える。 */
function estimateTextWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		// 記号混じりでも大きく外さない程度の粗い見積もり（半角6.6px / 全角12px）。
		width += /[　-鿿＀-￯]/.test(char) ? 12 : 6.6;
	}
	return width;
}

/**
 * 列ごとに「一番長いセル」を基準に幅を決める。極端に長い列は上限で頭打ちにする。
 * 会話の文字サイズ（`scale`）を変えているときは、見積もりも同じ割合で広げる・狭める。
 */
function tableColumnWidths(block: { header: string[]; rows: string[][] }, cols: number, scale: ChatTextScale): number[] {
	const widths: number[] = [];
	for (let c = 0; c < cols; c++) {
		let max = estimateTextWidth(block.header[c] ?? '');
		for (const row of block.rows) {
			max = Math.max(max, estimateTextWidth(row[c] ?? ''));
		}
		// +14 はセル左右のパディング、+8 は見積もり誤差ぶんの余白（足りないと折り返す）。
		widths.push(scaleChatSize(Math.min(260, Math.max(52, Math.ceil(max) + 22)), scale));
	}
	return widths;
}

// ---- コードブロックのPCテーマハイライト -------------------------------------------------------

/** 色付きテキスト片。1行 = HighlightRun[]。 */
interface HighlightRun { text: string; color?: string; italic?: boolean; bold?: boolean }
interface HighlightData { lines: HighlightRun[][]; bg?: string; fg?: string }

/**
 * PCから届いた `.monaco-tokenized-source` HTML（span.mtkN と <br/> のみ、< > & エスケープ）と
 * カラーマップCSS（`.mtkN { color: ... }`）をネイティブText用の色付きラン列へ変換する。
 * 期待形式から外れた場合は undefined（プレーン表示のまま）。
 */
function parseTokenizedHtml(html: string, css: string): HighlightRun[][] | undefined {
	const inner = /^<div[^>]*>([\s\S]*)<\/div>$/.exec(html.trim())?.[1];
	if (inner === undefined) {
		return undefined;
	}
	const colorByClass = new Map<string, string>();
	for (const rule of css.matchAll(/\.(mtk\d+)\s*\{\s*color:\s*([^;}]+);/g)) {
		const className = rule[1];
		const color = rule[2];
		if (className !== undefined && color !== undefined) {
			colorByClass.set(className, color.trim());
		}
	}
	const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
	let currentLine: HighlightRun[] = [];
	const lines: HighlightRun[][] = [currentLine];
	const tokenPattern = /<span class="([^"]*)">([\s\S]*?)<\/span>|<br\/?>|([^<]+)/g;
	for (const m of inner.matchAll(tokenPattern)) {
		if (m[0].startsWith('<br')) {
			currentLine = [];
			lines.push(currentLine);
			continue;
		}
		if (m[1] !== undefined) {
			const classes = m[1].split(/\s+/);
			const colorClass = classes.find(c => /^mtk\d+$/.test(c));
			currentLine.push({
				text: unescape(m[2] ?? ''),
				...(colorClass !== undefined && colorByClass.has(colorClass) ? { color: colorByClass.get(colorClass) } : {}),
				...(classes.includes('mtki') ? { italic: true } : {}),
				...(classes.includes('mtkb') ? { bold: true } : {}),
			});
		} else if (m[3] !== undefined && m[3].length > 0) {
			currentLine.push({ text: unescape(m[3]) });
		}
	}
	return lines;
}

/** ハイライト結果のメモリキャッシュ（同一コード片の再取得を避ける）。null = 取得失敗（再試行しない）。 */
const highlightCache = new Map<string, HighlightData | null>();
const HIGHLIGHT_CACHE_LIMIT = 120;
/**
 * ハイライト要求を投げるまでの静止待ち。
 *
 * ストリーミング中は本文が最大8Hzで伸び、そのたびに cacheKey が変わる。都度要求すると
 * PCへの往復が氾濫し、キャッシュも未完成のコード片で埋まって本当に必要な結果を押し出す。
 */
const HIGHLIGHT_REQUEST_DELAY_MS = 250;

/**
 * コードブロック。まずプレーンで即描画し、PCの現行テーマによるハイライト
 * （fs hl 要求 → Monacoトークナイザ + カラーマップ）が取れ次第、色付きに差し替える。
 * 取得失敗・未接続時はプレーンのまま（機能は損なわない）。
 */
/**
 * ブロック単位の memo 子。親（MarkdownText）はストリーミング中・ローカルstate更新のたびに
 * 再描画されるため、本文が不変なブロックはここで止める（見出しやテーブルの
 * parseInline/renderInlineTokens が毎回走ると多数の Text ノードを組み直す）。
 * `onOpenLocal` は呼び出し側で useCallback 済みという前提。
 */
const HeadingBlock = memo(function HeadingBlock({ text, level, onOpenLocal }: { text: string; level: number; onOpenLocal: (target: LocalFileTarget) => void }) {
	const selectable = useContext(SelectableContext);
	const links = useContext(LinkMenuContext);
	const theme = useThemeColors();
	const styles = useChatStyles(baseStyles);
	return (
		<Text style={[styles.body, styles.heading, level === 1 ? styles.h1 : level === 2 ? styles.h2 : null]} selectable={selectable}>
			{renderInlineTokens(parseInline(text), styles, styles.body, onOpenLocal, theme.accent, links.externalLongPress)}
		</Text>
	);
});

const TableBlock = memo(function TableBlock({ block, onOpenLocal }: { block: Extract<Block, { kind: 'table' }>; onOpenLocal: (target: LocalFileTarget) => void }) {
	const selectable = useContext(SelectableContext);
	const links = useContext(LinkMenuContext);
	// 列数はヘッダー基準（本体行の過不足セルは空/切り捨てで揃える）
	const cols = block.header.length;
	// 列幅は内容から見積もって固定する。flex:1 で画面幅へ押し込むと列が潰れて
	// 縦に折り返し、桁が崩れるため（本家Claudeアプリと同じく表だけ横に流す）。
	const scale = useChatTextScale();
	const widths = tableColumnWidths(block, cols, scale);
	const theme = useThemeColors();
	const styles = useChatStyles(baseStyles);
	return (
		<HorizontalScrollFade style={styles.tableWrap}>
			<View style={styles.table}>
				<View style={[styles.tableRow, styles.tableHead]}>
					{block.header.map((cell, c) => (
						<View key={c} style={[styles.tableCell, { width: widths[c] }, c > 0 ? styles.tableCellBorder : null]}>
							<Text style={[styles.body, styles.tableHeadText, { textAlign: block.aligns[c] ?? 'left' }]} selectable={selectable}>
								{renderInlineTokens(parseInline(cell), styles, styles.body, onOpenLocal, theme.accent, links.externalLongPress)}
							</Text>
						</View>
					))}
				</View>
				{block.rows.map((row, r) => (
					<View key={r} style={[styles.tableRow, r % 2 === 1 ? styles.tableRowAlt : null]}>
						{Array.from({ length: cols }, (_, c) => (
							<View key={c} style={[styles.tableCell, { width: widths[c] }, c > 0 ? styles.tableCellBorder : null]}>
								<Text style={[styles.body, styles.tableCellText, { textAlign: block.aligns[c] ?? 'left' }]} selectable={selectable}>
									{renderInlineTokens(parseInline(row[c] ?? ''), styles, styles.body, onOpenLocal, theme.accent, links.externalLongPress)}
								</Text>
							</View>
						))}
					</View>
				))}
			</View>
		</HorizontalScrollFade>
	);
});

const CodeBlock = memo(function CodeBlock({ text, lang }: { text: string; lang?: string }) {
	const selectable = useContext(SelectableContext);
	const fsHighlight = useAppStore(s => s.fsHighlight);
	const styles = useChatStyles(baseStyles);
	const [wrap, setWrap] = useState(false);
	const cacheKey = `${lang ?? ''} ${text}`;
	// 結果は「どの内容に対するものか」と一緒に持つ。紐づけずに持つと、ストリーミングで本文が
	// 伸びた後も前の（短い）ハイライト行を描き続け、ブロックの高さが実際の内容とずれたまま
	// 固まって遅れて塊で跳ねる（会話の追従が引っかかる原因）。
	const requestedOnceRef = useRef(false);
	const mountedRef = useRef(true);
	useEffect(() => () => { mountedRef.current = false; }, []);
	const [data, setData] = useState<{ readonly key: string; readonly value: HighlightData } | undefined>(() => {
		const cached = highlightCache.get(cacheKey);
		return cached ? { key: cacheKey, value: cached } : undefined;
	});

	useEffect(() => {
		if (highlightCache.has(cacheKey)) {
			const cached = highlightCache.get(cacheKey);
			setData(cached ? { key: cacheKey, value: cached } : undefined);
			return;
		}
		// この実行が「キー変化で置き換えられた」ことを表すローカルフラグ。ref に持たせると
		// cleanup と次の effect body が同一コミット内で同期に走るため即座に false へ戻り、
		// 判定として機能しない（アンマウントとキー変化も区別できない）。
		let superseded = false;
		// 本文が伸びている間は投げない（静止してから1回だけ要求する）。ただし初回マウントは
		// 待たない。履歴スクロールで再マウントされるたびに待つと、FlatList のリサイクルで
		// 画面外へ出た瞬間に要求が捨てられ、色が付かないまま残る。
		const delay = requestedOnceRef.current ? HIGHLIGHT_REQUEST_DELAY_MS : 0;
		requestedOnceRef.current = true;
		const timer = setTimeout(() => {
			fsHighlight(text, lang).then(result => {
				let parsed: HighlightData | null = null;
				if (result.html !== undefined && result.css !== undefined) {
					const lines = parseTokenizedHtml(result.html, result.css);
					if (lines !== undefined) {
						parsed = { lines, ...(result.bg !== undefined ? { bg: result.bg } : {}), ...(result.fg !== undefined ? { fg: result.fg } : {}) };
					}
				}
				// 未完成のコード片への応答（＝まだマウントされたままキーが差し替わった）は
				// キャッシュへ入れない。二度と再来しないキーなので、120件の枠から有用な
				// エントリを押し出すだけになる。アンマウント（FlatList のリサイクル）は
				// キー自体は有効なので保存する。
				if (superseded && mountedRef.current) {
					return;
				}
				if (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT) {
					const oldest = highlightCache.keys().next().value;
					if (oldest !== undefined) {
						highlightCache.delete(oldest);
					}
				}
				highlightCache.set(cacheKey, parsed);
				if (parsed !== null && !superseded) {
					setData({ key: cacheKey, value: parsed });
				}
			}).catch(() => {
				// 未接続・タイムアウト等は次回マウント時に再試行できるようキャッシュしない
			});
		}, delay);
		return () => { superseded = true; clearTimeout(timer); };
	}, [cacheKey, text, lang, fsHighlight]);

	const highlighted = data?.key === cacheKey ? data.value : undefined;
	// 既定はコードを折り返さず横スクロールにする（インデントと桁が崩れないようにする）。見出しの「折り返し」で切り替える。
	const body = highlighted === undefined
		? <Text style={[styles.codeText, wrap ? styles.codeWrap : null]} selectable={selectable}>{text}</Text>
		: (
			<Text style={[styles.codeText, wrap ? styles.codeWrap : null, highlighted.fg !== undefined ? { color: highlighted.fg } : null]} selectable={selectable}>
				{highlighted.lines.map((line, li) => (
					<Text key={li}>
						{li > 0 ? '\n' : ''}
						{line.map((run, ri) => (
							<Text
								key={ri}
								style={[
									run.color !== undefined ? { color: run.color } : null,
									run.italic ? styles.codeItalic : null,
									run.bold ? styles.codeBold : null,
								]}
							>
								{run.text}
							</Text>
						))}
					</Text>
				))}
			</Text>
		);
	return (
		<View style={[styles.codeBlock, highlighted?.bg !== undefined ? { backgroundColor: highlighted.bg } : null]}>
			<IOBar label={lang ?? 'コード'} wrap={wrap} onToggleWrap={() => setWrap(value => !value)} copyText={text} />
			{wrap
				? <View style={styles.codeContent}>{body}</View>
				: <HorizontalScrollFade contentStyle={styles.codeContent}>{body}</HorizontalScrollFade>}
		</View>
	);
});

/** `linkColor` はリンクの色（設定 → 色の「選択の印・リンク」）。 */
function renderInlineTokens(tokens: InlineToken[], styles: typeof baseStyles, baseStyle: object, onOpenLocal: (target: LocalFileTarget) => void, linkColor: string, externalLongPress: (url: string) => (() => void) | undefined): ReactNode[] {
	return tokens.map((token, i) => {
		if (token.kind === 'code') {
			return <Text key={i} style={[baseStyle, styles.inlineCode]}>{token.text}</Text>;
		}
		if (token.kind === 'bold') {
			return <Text key={i} style={[baseStyle, styles.bold]}>{token.text}</Text>;
		}
		if (token.kind === 'external') {
			// 押したら今までどおりすぐ開く。長押しで URL の操作（Q549 U9。ネイティブのメニューがあるビルドでは発言のメニューの「リンク」）
			return <Text key={i} style={[baseStyle, styles.link, { color: linkColor }]} onPress={() => openExternalUrl(token.url)} onLongPress={externalLongPress(token.url)}>{token.label}</Text>;
		}
		if (token.kind === 'local') {
			return <Text key={i} style={[baseStyle, styles.link, { color: linkColor }]} onPress={() => onOpenLocal(token.target)}>{token.label}</Text>;
		}
		return <Text key={i} style={baseStyle}>{token.text}</Text>;
	});
}

function LocalFileCard({ label, target, opening, onPress }: { label: string; target: LocalFileTarget; opening: boolean; onPress: () => void }) {
	const links = useContext(LinkMenuContext);
	// 長押しで「ファイルを開く」「パスをコピー」「行番号つきでコピー」（Q549 U4）
	const menu = buildLocalFileLinkMenu(target, { ...links.ops, open: onPress });
	const name = target.path.split(/[\\/]/).pop() ?? target.path;
	const theme = useThemeColors();
	const styles = useChatStyles(baseStyles);
	const iconSize = useChatIconSize(18);
	const fileIconBox = useChatIconSize(32);
	const location = target.line !== undefined ? `行 ${target.line}${target.column !== undefined ? `、列 ${target.column}` : ''}` : undefined;
	return (
		<ContextMenu menu={menu} previewRadius={radius.control}>
			<Pressable style={({ pressed }) => [styles.fileCard, pressed ? styles.fileCardPressed : null]} onPress={onPress} onLongPress={links.longPress(menu)} accessibilityRole="button" accessibilityLabel={`${label}を開く`}>
				<View style={[styles.fileIcon, { width: fileIconBox, height: fileIconBox, backgroundColor: theme.accentWash }]}><Ionicons name="document-text-outline" size={iconSize} color={theme.accent} /></View>
				<View style={styles.fileInfo}>
					<Text style={styles.fileLabel} numberOfLines={1}>{label || name}</Text>
					<Text style={styles.filePath} numberOfLines={2}>{target.path}{location !== undefined ? ` · ${location}` : ''}</Text>
				</View>
				{opening ? <ActivityIndicator size="small" color={theme.accent} /> : <Ionicons name="chevron-forward" size={iconSize} color={colors.textDim} />}
			</Pressable>
		</ContextMenu>
	);
}

const InlineBlock = memo(function InlineBlock({ text, onOpenLocal, openingKey }: { text: string; onOpenLocal: (target: LocalFileTarget) => void; openingKey?: string }) {
	const selectable = useContext(SelectableContext);
	const links = useContext(LinkMenuContext);
	const theme = useThemeColors();
	const styles = useChatStyles(baseStyles);
	const tokens = parseInline(text);
	if (!tokens.some(token => token.kind === 'local')) {
		return <Text style={styles.body} selectable={selectable}>{renderInlineTokens(tokens, styles, styles.body, onOpenLocal, theme.accent, links.externalLongPress)}</Text>;
	}
	const groups: InlineToken[][] = [];
	for (const token of tokens) {
		if (token.kind === 'local') {
			groups.push([token]);
		} else {
			const last = groups[groups.length - 1];
			if (last !== undefined && last[0]?.kind !== 'local') { last.push(token); } else { groups.push([token]); }
		}
	}
	return (
		<View style={styles.inlineStack}>
			{groups.map((group, i) => {
				const local = group[0]?.kind === 'local' ? group[0] : undefined;
				if (local?.kind === 'local') {
					return <LocalFileCard key={i} label={local.label} target={local.target} opening={openingKey === localFileTargetKey(local.target)} onPress={() => onOpenLocal(local.target)} />;
				}
				return <Text key={i} style={styles.body} selectable={selectable}>{renderInlineTokens(group, styles, styles.body, onOpenLocal, theme.accent, links.externalLongPress)}</Text>;
			})}
		</View>
	);
});

/**
 * 本文の Text を長押しで写せるようにするか（RN の `selectable`。iOS では長押しで全文の「コピー」が出る）。
 * 発言をネイティブのメニューで包むときは外す（同じ長押しを取り合わないように）。
 */
const SelectableContext = createContext(true);

/** 本文の中のリンクの長押し（ネイティブのメニューが無いビルドのシートと、写す道具）。MarkdownText が 1 つずつ持つ。 */
interface LinkMenus {
	readonly ops: ContextMenuOps;
	readonly longPress: (menu: ContextMenuSpec | undefined) => (() => void) | undefined;
	readonly externalLongPress: (url: string) => (() => void) | undefined;
}
const LinkMenuContext = createContext<LinkMenus>({ ops: { canCopy: false, copy: () => undefined, copyLater: () => undefined, share: () => undefined }, longPress: () => undefined, externalLongPress: () => undefined });

function openExternalUrl(url: string): void {
	void Linking.openURL(url).catch(() => { /* 開けないURLは無視 */ });
}

export function MarkdownText({ text, selectable = true }: {
	text: string;
	/** 既定は true（今の長押しのコピー）。長押しのメニューで包むときだけ false を渡す。 */
	selectable?: boolean;
}) {
	const { open, openingKey, viewer } = useLocalFileOpener();
	const styles = useChatStyles(baseStyles);
	// 本文が変わらない再レンダー（リンクを押したときのローカルstate更新など）で
	// パースし直さない。`parseBlocks` は `text` だけの純粋関数。
	const blocks = useMemo(() => parseBlocks(text), [text]);
	const menuSheet = useContextMenuSheet();
	const { longPress } = menuSheet;
	const links = useMemo<LinkMenus>(() => {
		const ops = contextMenuOps();
		return {
			ops,
			longPress,
			externalLongPress: url => longPress(buildExternalLinkMenu({ url }, { ...ops, open: () => openExternalUrl(url) })),
		};
	}, [longPress]);
	return (
		<View style={styles.root}>
			<SelectableContext.Provider value={selectable}>
				<LinkMenuContext.Provider value={links}>
					<BlockList blocks={blocks} onOpenLocal={open} openingKey={openingKey} />
				</LinkMenuContext.Provider>
			</SelectableContext.Provider>
			{viewer}
			{menuSheet.sheet}
		</View>
	);
}

/** ブロックの並び。引用の中身も同じ部品で描く。 */
function BlockList({ blocks, onOpenLocal, openingKey }: { blocks: readonly Block[]; onOpenLocal: (target: LocalFileTarget) => void; openingKey: string | undefined }) {
	const styles = useChatStyles(baseStyles);
	const bulletIndent = scaleChatSize(BULLET_INDENT, useChatTextScale());
	return (
		<>
			{blocks.map((block, i) => {
				if (block.kind === 'code') {
					return <CodeBlock key={i} text={block.text} lang={block.lang} />;
				}
				if (block.kind === 'heading') {
					return <HeadingBlock key={i} text={block.text} level={block.level} onOpenLocal={onOpenLocal} />;
				}
				if (block.kind === 'bullet') {
					return (
						<View key={i} style={[styles.bulletRow, { paddingLeft: Math.min(block.depth, MAX_BULLET_DEPTH) * bulletIndent }]}>
							<Text style={[styles.body, styles.bulletMarker]}>{block.marker}</Text>
							<View style={styles.bulletBody}><InlineBlock text={block.text} onOpenLocal={onOpenLocal} openingKey={openingKey} /></View>
						</View>
					);
				}
				if (block.kind === 'table') {
					return <TableBlock key={i} block={block} onOpenLocal={onOpenLocal} />;
				}
				if (block.kind === 'quote') {
					return (
						<View key={i} style={styles.quote}>
							<View style={styles.quoteBar} />
							<View style={styles.quoteBody}><BlockList blocks={block.blocks} onOpenLocal={onOpenLocal} openingKey={openingKey} /></View>
						</View>
					);
				}
				if (block.kind === 'rule') {
					return <View key={i} style={styles.rule} accessibilityRole="none" />;
				}
				return <InlineBlock key={i} text={block.text} onOpenLocal={onOpenLocal} openingKey={openingKey} />;
			})}
		</>
	);
}

/** 入れ子の箇条書きの 1 段ぶんの字下げ（会話の文字サイズが 100% のとき）。 */
const BULLET_INDENT = 16;

const baseStyles = StyleSheet.create({
	root: { gap: 6 },
	body: { color: colors.text, fontSize: type.body, lineHeight: 20 },
	bold: { fontWeight: '700' },
	link: { color: colors.accent, textDecorationLine: 'underline' },
	inlineCode: { fontFamily: monoFamily, fontSize: type.meta, backgroundColor: tint(colors.idle, alpha.line), borderRadius: radius.key },
	heading: { fontWeight: '700' },
	h1: { fontSize: type.title },
	// h1 と同じ大きさにすると見出しの段が消えるので、h2 は本文と同じ大きさの太字で区別する。
	h2: { fontSize: type.body },
	codeBlock: { backgroundColor: colors.codeBg, borderRadius: radius.control, ...squircle, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
	codeContent: { padding: 8 },
	codeWrap: { flexShrink: 1 },
	codeText: { color: colors.text, fontFamily: monoFamily, fontSize: type.caption, lineHeight: 16 },
	codeItalic: { fontStyle: 'italic' },
	codeBold: { fontWeight: '700' },
	bulletRow: { flexDirection: 'row', gap: 6 },
	bulletMarker: { color: colors.textDim },
	bulletBody: { flex: 1 },
	quote: { flexDirection: 'row', gap: 8 },
	quoteBar: { width: 3, borderRadius: radius.key, backgroundColor: colors.border },
	quoteBody: { flex: 1, gap: 6, opacity: 0.86 },
	rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 6 },
	inlineStack: { gap: 6 },
	fileCard: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.glassBg, borderWidth: 1, borderColor: colors.glassBorder, borderRadius: radius.control, ...squircle, paddingVertical: 10, paddingHorizontal: 11 },
	fileCardPressed: { opacity: 0.72 },
	fileIcon: { width: 32, height: 32, borderRadius: radius.control, ...squircle, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentWash },
	fileInfo: { flex: 1, gap: 2 },
	fileLabel: { color: colors.text, fontSize: type.body, fontWeight: '600' },
	filePath: { color: colors.textDim, fontFamily: monoFamily, fontSize: type.badge, lineHeight: 14 },
	tableWrap: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.control, ...squircle, overflow: 'hidden', marginVertical: 2 },
	table: { flexDirection: 'column' },
	tableRow: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
	tableHead: { backgroundColor: tint(colors.idle, alpha.wash), borderTopWidth: 0 },
	tableRowAlt: { backgroundColor: tint(colors.idle, alpha.faint) },
	tableCell: { paddingVertical: 5, paddingHorizontal: 7 },
	tableCellBorder: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
	tableHeadText: { fontWeight: '700', fontSize: type.meta, lineHeight: 17 },
	tableCellText: { fontSize: type.meta, lineHeight: 17 },
});
