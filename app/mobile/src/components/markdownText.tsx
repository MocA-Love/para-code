// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * エージェント応答向けの軽量Markdownレンダラ（依存ゼロ）。
 * チャットバブル内で頻出する要素だけを対象にする:
 *  - コードブロック（```）/ インラインコード（`）
 *  - 太字（**）
 *  - 見出し（# 〜 ###）
 *  - 箇条書き（- / * / 1.）
 *  - 表（GFMテーブル: ヘッダー行＋区切り行＋本体行、列アライメント対応）
 * それ以外はプレーンテキストとして安全に表示する（未対応記法で壊れない）。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { useAppStore } from '../appState.js';
import { colors } from '../theme.js';

type CellAlign = 'left' | 'center' | 'right';

type Block =
	| { kind: 'code'; text: string; lang?: string }
	| { kind: 'heading'; level: number; text: string }
	| { kind: 'bullet'; marker: string; text: string }
	| { kind: 'table'; header: string[]; aligns: CellAlign[]; rows: string[][] }
	| { kind: 'para'; text: string };

/** `| a | b |` 形式の行をセル配列へ分解する（前後のパイプは落とす）。 */
function splitTableRow(line: string): string[] {
	let trimmed = line.trim();
	if (trimmed.startsWith('|')) {
		trimmed = trimmed.slice(1);
	}
	if (trimmed.endsWith('|')) {
		trimmed = trimmed.slice(0, -1);
	}
	return trimmed.split('|').map(cell => cell.trim());
}

/** GFMテーブルの区切り行（`| --- | :---: |` 等）かどうか。 */
function isTableSeparator(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.includes('-') || !trimmed.includes('|')) {
		return false;
	}
	return splitTableRow(trimmed).every(cell => /^:?-+:?$/.test(cell));
}

function parseBlocks(source: string): Block[] {
	const blocks: Block[] = [];
	const lines = source.split('\n');
	let codeLines: string[] | undefined;
	let codeLang: string | undefined;
	let paraLines: string[] = [];

	const flushPara = () => {
		if (paraLines.length > 0) {
			blocks.push({ kind: 'para', text: paraLines.join('\n') });
			paraLines = [];
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (codeLines !== undefined) {
			if (line.trimEnd().startsWith('```')) {
				blocks.push({ kind: 'code', text: codeLines.join('\n'), ...(codeLang !== undefined ? { lang: codeLang } : {}) });
				codeLines = undefined;
			} else {
				codeLines.push(line);
			}
			continue;
		}
		if (line.trimStart().startsWith('```')) {
			flushPara();
			codeLines = [];
			// フェンスの言語名（```ts 等）。PCテーマハイライトの言語解決に使う。
			const info = line.trimStart().slice(3).trim().split(/\s+/)[0] ?? '';
			codeLang = info.length > 0 ? info : undefined;
			continue;
		}
		// 表: 「|で始まるヘッダー行」＋「区切り行」の並びで開始し、|で始まる行が続く限り本体行
		if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? '')) {
			flushPara();
			const header = splitTableRow(line);
			const aligns = splitTableRow(lines[i + 1] ?? '').map<CellAlign>(cell =>
				cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
			const rows: string[][] = [];
			let next = i + 2;
			while (next < lines.length && (lines[next] ?? '').trim().startsWith('|')) {
				rows.push(splitTableRow(lines[next] ?? ''));
				next++;
			}
			blocks.push({ kind: 'table', header, aligns, rows });
			i = next - 1;
			continue;
		}
		const heading = line.match(/^(?<hashes>#{1,3})\s+(?<body>.+)$/);
		if (heading?.groups?.hashes !== undefined && heading.groups.body !== undefined) {
			flushPara();
			blocks.push({ kind: 'heading', level: heading.groups.hashes.length, text: heading.groups.body });
			continue;
		}
		const bullet = line.match(/^\s*(?<marker>[-*]|\d+\.)\s+(?<body>.+)$/);
		if (bullet?.groups?.marker !== undefined && bullet.groups.body !== undefined) {
			flushPara();
			blocks.push({ kind: 'bullet', marker: /^\d/.test(bullet.groups.marker) ? bullet.groups.marker : '•', text: bullet.groups.body });
			continue;
		}
		if (line.trim().length === 0) {
			flushPara();
			continue;
		}
		paraLines.push(line);
	}
	if (codeLines !== undefined) {
		blocks.push({ kind: 'code', text: codeLines.join('\n'), ...(codeLang !== undefined ? { lang: codeLang } : {}) }); // 閉じ忘れフェンスも表示する
	}
	flushPara();
	return blocks;
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
 * コードブロック。まずプレーンで即描画し、PCの現行テーマによるハイライト
 * （fs hl 要求 → Monacoトークナイザ + カラーマップ）が取れ次第、色付きに差し替える。
 * 取得失敗・未接続時はプレーンのまま（機能は損なわない）。
 */
function CodeBlock({ text, lang }: { text: string; lang?: string }) {
	const fsHighlight = useAppStore(s => s.fsHighlight);
	const cacheKey = `${lang ?? ''} ${text}`;
	const [data, setData] = useState<HighlightData | undefined>(() => highlightCache.get(cacheKey) ?? undefined);

	useEffect(() => {
		if (highlightCache.has(cacheKey)) {
			const cached = highlightCache.get(cacheKey);
			setData(cached ?? undefined);
			return;
		}
		let cancelled = false;
		fsHighlight(text, lang).then(result => {
			let parsed: HighlightData | null = null;
			if (result.html !== undefined && result.css !== undefined) {
				const lines = parseTokenizedHtml(result.html, result.css);
				if (lines !== undefined) {
					parsed = { lines, ...(result.bg !== undefined ? { bg: result.bg } : {}), ...(result.fg !== undefined ? { fg: result.fg } : {}) };
				}
			}
			if (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT) {
				const oldest = highlightCache.keys().next().value;
				if (oldest !== undefined) {
					highlightCache.delete(oldest);
				}
			}
			highlightCache.set(cacheKey, parsed);
			if (!cancelled && parsed !== null) {
				setData(parsed);
			}
		}).catch(() => {
			// 未接続・タイムアウト等は次回マウント時に再試行できるようキャッシュしない
		});
		return () => { cancelled = true; };
	}, [cacheKey, text, lang, fsHighlight]);

	if (data === undefined) {
		return (
			<View style={styles.codeBlock}>
				<Text style={styles.codeText} selectable>{text}</Text>
			</View>
		);
	}
	return (
		<View style={[styles.codeBlock, data.bg !== undefined ? { backgroundColor: data.bg } : null]}>
			<Text style={[styles.codeText, data.fg !== undefined ? { color: data.fg } : null]} selectable>
				{data.lines.map((line, li) => (
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
		</View>
	);
}

/** [ラベル](URL) 形式のリンク。http(s) のみタップで開く（他スキームは実行しない）。 */
const LINK_PATTERN = /\[[^\]\n]+\]\(https?:\/\/[^()\s]+\)/;

/** インライン記法（`code` / **bold** / [リンク](url)）をTextノード列へ変換する。 */
function renderInline(text: string, baseStyle: object): ReactNode[] {
	const nodes: ReactNode[] = [];
	// `code` / **bold** / [リンク](url) の位置で分割する（ネストは扱わない）
	const parts = text.split(new RegExp(`(\`[^\`\n]+\`|\\*\\*[^*\n]+\\*\\*|${LINK_PATTERN.source})`, 'g'));
	parts.forEach((part, i) => {
		if (part.length === 0) {
			return;
		}
		if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
			nodes.push(<Text key={i} style={[baseStyle, styles.inlineCode]}>{part.slice(1, -1)}</Text>);
		} else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
			nodes.push(<Text key={i} style={[baseStyle, styles.bold]}>{part.slice(2, -2)}</Text>);
		} else if (part.startsWith('[') && LINK_PATTERN.test(part)) {
			const match = /^\[(?<label>[^\]\n]+)\]\((?<url>https?:\/\/[^()\s]+)\)$/.exec(part);
			if (match?.groups?.url !== undefined && match.groups.label !== undefined) {
				const url = match.groups.url;
				nodes.push(
					<Text key={i} style={[baseStyle, styles.link]} onPress={() => { void Linking.openURL(url).catch(() => { /* 開けないURLは無視 */ }); }}>
						{match.groups.label}
					</Text>
				);
			} else {
				nodes.push(<Text key={i} style={baseStyle}>{part}</Text>);
			}
		} else {
			nodes.push(<Text key={i} style={baseStyle}>{part}</Text>);
		}
	});
	return nodes;
}

export function MarkdownText({ text }: { text: string }) {
	const blocks = parseBlocks(text);
	return (
		<View style={styles.root}>
			{blocks.map((block, i) => {
				if (block.kind === 'code') {
					return <CodeBlock key={i} text={block.text} lang={block.lang} />;
				}
				if (block.kind === 'heading') {
					return (
						<Text key={i} style={[styles.body, styles.heading, block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : null]} selectable>
							{renderInline(block.text, styles.body)}
						</Text>
					);
				}
				if (block.kind === 'bullet') {
					return (
						<View key={i} style={styles.bulletRow}>
							<Text style={[styles.body, styles.bulletMarker]}>{block.marker}</Text>
							<Text style={[styles.body, styles.bulletBody]} selectable>{renderInline(block.text, styles.body)}</Text>
						</View>
					);
				}
				if (block.kind === 'table') {
					// 列数はヘッダー基準（本体行の過不足セルは空/切り捨てで揃える）
					const cols = block.header.length;
					return (
						<View key={i} style={styles.table}>
							<View style={[styles.tableRow, styles.tableHead]}>
								{block.header.map((cell, c) => (
									<View key={c} style={[styles.tableCell, c > 0 ? styles.tableCellBorder : null]}>
										<Text style={[styles.body, styles.tableHeadText, { textAlign: block.aligns[c] ?? 'left' }]} selectable>
											{renderInline(cell, styles.body)}
										</Text>
									</View>
								))}
							</View>
							{block.rows.map((row, r) => (
								<View key={r} style={[styles.tableRow, r % 2 === 1 ? styles.tableRowAlt : null]}>
									{Array.from({ length: cols }, (_, c) => (
										<View key={c} style={[styles.tableCell, c > 0 ? styles.tableCellBorder : null]}>
											<Text style={[styles.body, styles.tableCellText, { textAlign: block.aligns[c] ?? 'left' }]} selectable>
												{renderInline(row[c] ?? '', styles.body)}
											</Text>
										</View>
									))}
								</View>
							))}
						</View>
					);
				}
				return (
					<Text key={i} style={styles.body} selectable>{renderInline(block.text, styles.body)}</Text>
				);
			})}
		</View>
	);
}

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
	root: { gap: 6 },
	body: { color: colors.text, fontSize: 13, lineHeight: 19 },
	bold: { fontWeight: '700' },
	link: { color: '#58a6ff', textDecorationLine: 'underline' },
	inlineCode: { fontFamily: mono, fontSize: 12, backgroundColor: 'rgba(110,118,129,.25)', borderRadius: 3 },
	heading: { fontWeight: '700' },
	h1: { fontSize: 16 },
	h2: { fontSize: 15 },
	codeBlock: { backgroundColor: '#161b22', borderRadius: 8, borderWidth: 1, borderColor: colors.border, padding: 8 },
	codeText: { color: colors.text, fontFamily: mono, fontSize: 11, lineHeight: 16 },
	codeItalic: { fontStyle: 'italic' },
	codeBold: { fontWeight: '700' },
	bulletRow: { flexDirection: 'row', gap: 6 },
	bulletMarker: { color: colors.textDim },
	bulletBody: { flex: 1 },
	table: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: 'hidden', marginVertical: 2 },
	tableRow: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
	tableHead: { backgroundColor: 'rgba(110,118,129,.18)', borderTopWidth: 0 },
	tableRowAlt: { backgroundColor: 'rgba(110,118,129,.07)' },
	tableCell: { flex: 1, paddingVertical: 5, paddingHorizontal: 7 },
	tableCellBorder: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
	tableHeadText: { fontWeight: '700', fontSize: 12, lineHeight: 17 },
	tableCellText: { fontSize: 12, lineHeight: 17 },
});
