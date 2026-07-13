// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * エージェント応答向けの軽量Markdownレンダラ（依存ゼロ）。
 * チャットバブル内で頻出する要素だけを対象にする:
 *  - コードブロック（```）/ インラインコード（`）
 *  - 太字（**）
 *  - 見出し（# 〜 ###）
 *  - 箇条書き（- / * / 1.）
 *  - 表（GFMテーブル: ヘッダー行＋区切り行＋本体行、列アライメント対応）
 *  - http(s)リンク / ワークスペース内ファイルリンク（カード＋アプリ内ビューアー）
 * それ以外はプレーンテキストとして安全に表示する（未対応記法で壊れない）。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { hapticSelection } from '../haptics.js';
import { colors } from '../theme.js';
import { WorkspaceFileViewer } from './workspaceFileViewer.js';

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

interface LocalFileTarget {
	path: string;
	line?: number;
	column?: number;
}

type InlineToken =
	| { kind: 'text'; text: string }
	| { kind: 'code'; text: string }
	| { kind: 'bold'; text: string }
	| { kind: 'external'; label: string; url: string }
	| { kind: 'local'; label: string; target: LocalFileTarget };

/** `[` 位置からMarkdownリンク1個を読み取る。山括弧内では空白・括弧を許可する。 */
function markdownLinkAt(text: string, start: number): { end: number; label: string; destination: string } | undefined {
	if (start > 0 && text[start - 1] === '!') {
		return undefined; // 画像記法はファイルを開くカードへ変換しない
	}
	const labelEnd = text.indexOf('](', start + 1);
	if (labelEnd < 0 || text.slice(start + 1, labelEnd).includes('\n')) {
		return undefined;
	}
	const label = text.slice(start + 1, labelEnd);
	if (label.length === 0) {
		return undefined;
	}
	const destinationStart = labelEnd + 2;
	if (text[destinationStart] === '<') {
		const angleEnd = text.indexOf('>', destinationStart + 1);
		if (angleEnd < 0) {
			return undefined;
		}
		let cursor = angleEnd + 1;
		while (text[cursor] === ' ' || text[cursor] === '\t') { cursor++; }
		if (text[cursor] === '"' || text[cursor] === "'") {
			const quote = text.charAt(cursor);
			const titleEnd = text.indexOf(quote, cursor + 1);
			if (titleEnd < 0) { return undefined; }
			cursor = titleEnd + 1;
			while (text[cursor] === ' ' || text[cursor] === '\t') { cursor++; }
		}
		if (text[cursor] !== ')') {
			return undefined;
		}
		return { end: cursor + 1, label, destination: text.slice(destinationStart + 1, angleEnd) };
	}

	let depth = 0;
	for (let cursor = destinationStart; cursor < text.length && text[cursor] !== '\n'; cursor++) {
		const char = text[cursor];
		if (char === '(') {
			depth++;
		} else if (char === ')') {
			if (depth > 0) {
				depth--;
				continue;
			}
			const body = text.slice(destinationStart, cursor).trim();
			const match = /^(?<destination>\S+?)(?:\s+(?:"[^"]*"|'[^']*'))?$/.exec(body);
			if (match?.groups?.destination === undefined) {
				return undefined;
			}
			return { end: cursor + 1, label, destination: match.groups.destination };
		}
	}
	return undefined;
}

/** 行指定（`:4:2` / `#L4C2` / `#L4-L8`）をパス本体から分離する。 */
function parseLocalFileTarget(destination: string): LocalFileTarget | undefined {
	if (/^https?:\/\//i.test(destination)) {
		return undefined;
	}
	let path = destination.trim();
	let line: number | undefined;
	let column: number | undefined;
	const fragmentIndex = path.lastIndexOf('#');
	if (fragmentIndex >= 0) {
		const fragment = path.slice(fragmentIndex);
		const location = /^#L(?<line>\d+)(?:C(?<column>\d+))?(?:-L\d+(?:C\d+)?)?$/i.exec(fragment);
		if (location?.groups?.line === undefined) {
			return undefined;
		}
		line = Number(location.groups.line);
		column = location.groups.column !== undefined ? Number(location.groups.column) : undefined;
		path = path.slice(0, fragmentIndex);
	}
	if (line === undefined) {
		const lineColumnSuffix = /^(?<path>.+):(?<line>\d+):(?<column>\d+)$/.exec(path);
		const lineSuffix = lineColumnSuffix ?? /^(?<path>.+):(?<line>\d+)$/.exec(path);
		if (lineSuffix?.groups?.path !== undefined && lineSuffix.groups.line !== undefined) {
			path = lineSuffix.groups.path;
			line = Number(lineSuffix.groups.line);
			column = lineSuffix.groups.column !== undefined ? Number(lineSuffix.groups.column) : undefined;
		}
	}
	if (/^file:\/\//i.test(path)) {
		path = path.slice('file://'.length);
		if (/^localhost\//i.test(path)) { path = path.slice('localhost'.length); }
	} else if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) {
		return undefined; // javascript: / mailto: 等は実行もファイル解決もしない
	}
	try {
		path = decodeURIComponent(path);
	} catch {
		return undefined;
	}
	if (path.length === 0 || path.startsWith('#') || line === 0 || column === 0) {
		return undefined;
	}
	if ((line !== undefined && (!Number.isSafeInteger(line) || line > 2_147_483_647))
		|| (column !== undefined && (!Number.isSafeInteger(column) || column > 2_147_483_647))) {
		return undefined;
	}
	return {
		path,
		...(line !== undefined ? { line } : {}),
		...(column !== undefined ? { column } : {}),
	};
}

/** インライン記法を安全な描画トークンへ分解する。 */
function parseInline(text: string): InlineToken[] {
	const tokens: InlineToken[] = [];
	let plain = '';
	const flush = () => {
		if (plain.length > 0) { tokens.push({ kind: 'text', text: plain }); plain = ''; }
	};
	for (let i = 0; i < text.length;) {
		if (text[i] === '`') {
			const end = text.indexOf('`', i + 1);
			if (end > i + 1 && !text.slice(i + 1, end).includes('\n')) {
				flush(); tokens.push({ kind: 'code', text: text.slice(i + 1, end) }); i = end + 1; continue;
			}
		}
		if (text.startsWith('**', i)) {
			const end = text.indexOf('**', i + 2);
			if (end > i + 2 && !text.slice(i + 2, end).includes('\n')) {
				flush(); tokens.push({ kind: 'bold', text: text.slice(i + 2, end) }); i = end + 2; continue;
			}
		}
		if (text[i] === '[') {
			const link = markdownLinkAt(text, i);
			if (link !== undefined) {
				if (/^https?:\/\//i.test(link.destination)) {
					flush(); tokens.push({ kind: 'external', label: link.label, url: link.destination }); i = link.end; continue;
				}
				const target = parseLocalFileTarget(link.destination);
				if (target !== undefined) {
					flush(); tokens.push({ kind: 'local', label: link.label, target }); i = link.end; continue;
				}
			}
		}
		plain += text.charAt(i);
		i++;
	}
	flush();
	return tokens;
}

function renderInlineTokens(tokens: InlineToken[], baseStyle: object, onOpenLocal: (target: LocalFileTarget) => void): ReactNode[] {
	return tokens.map((token, i) => {
		if (token.kind === 'code') {
			return <Text key={i} style={[baseStyle, styles.inlineCode]}>{token.text}</Text>;
		}
		if (token.kind === 'bold') {
			return <Text key={i} style={[baseStyle, styles.bold]}>{token.text}</Text>;
		}
		if (token.kind === 'external') {
			return <Text key={i} style={[baseStyle, styles.link]} onPress={() => { void Linking.openURL(token.url).catch(() => { /* 開けないURLは無視 */ }); }}>{token.label}</Text>;
		}
		if (token.kind === 'local') {
			return <Text key={i} style={[baseStyle, styles.link]} onPress={() => onOpenLocal(token.target)}>{token.label}</Text>;
		}
		return <Text key={i} style={baseStyle}>{token.text}</Text>;
	});
}

function LocalFileCard({ label, target, opening, onPress }: { label: string; target: LocalFileTarget; opening: boolean; onPress: () => void }) {
	const name = target.path.split(/[\\/]/).pop() ?? target.path;
	const location = target.line !== undefined ? `行 ${target.line}${target.column !== undefined ? `、列 ${target.column}` : ''}` : undefined;
	return (
		<Pressable style={({ pressed }) => [styles.fileCard, pressed ? styles.fileCardPressed : null]} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}を開く`}>
			<View style={styles.fileIcon}><Ionicons name="document-text-outline" size={18} color={colors.accent} /></View>
			<View style={styles.fileInfo}>
				<Text style={styles.fileLabel} numberOfLines={1}>{label || name}</Text>
				<Text style={styles.filePath} numberOfLines={2}>{target.path}{location !== undefined ? ` · ${location}` : ''}</Text>
			</View>
			{opening ? <ActivityIndicator size="small" color={colors.accent} /> : <Ionicons name="chevron-forward" size={18} color={colors.textDim} />}
		</Pressable>
	);
}

function InlineBlock({ text, onOpenLocal, openingKey }: { text: string; onOpenLocal: (target: LocalFileTarget) => void; openingKey?: string }) {
	const tokens = parseInline(text);
	if (!tokens.some(token => token.kind === 'local')) {
		return <Text style={styles.body} selectable>{renderInlineTokens(tokens, styles.body, onOpenLocal)}</Text>;
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
					const key = `${local.target.path}:${local.target.line ?? ''}:${local.target.column ?? ''}`;
					return <LocalFileCard key={i} label={local.label} target={local.target} opening={openingKey === key} onPress={() => onOpenLocal(local.target)} />;
				}
				return <Text key={i} style={styles.body} selectable>{renderInlineTokens(group, styles.body, onOpenLocal)}</Text>;
			})}
		</View>
	);
}

export function MarkdownText({ text }: { text: string }) {
	const { workspace, selectedWs, selectedTerminalId, fsResolveLink } = useAppStore(useShallow(s => ({
		workspace: s.workspace,
		selectedWs: s.selectedWs,
		selectedTerminalId: s.selectedTerminalId,
		fsResolveLink: s.fsResolveLink,
	})));
	const selectedTerminal = workspace?.terminals.find(terminal => terminal.id === selectedTerminalId);
	const terminalWs = selectedTerminal !== undefined ? (selectedTerminal.ws ?? workspace?.activeWs) : undefined;
	const ws = terminalWs ?? selectedWs ?? workspace?.activeWs ?? workspace?.workspaces[0]?.id;
	const [openingKey, setOpeningKey] = useState<string | undefined>();
	const [viewer, setViewer] = useState<{ ws: string; path: string; line?: number } | undefined>();
	const openGeneration = useRef(0);
	useEffect(() => () => { openGeneration.current++; }, []);
	const blocks = parseBlocks(text);
	const openLocal = (target: LocalFileTarget) => {
		if (ws === undefined) {
			Alert.alert('ファイルを開けません', '対応するワークスペースが見つかりません。');
			return;
		}
		const key = `${target.path}:${target.line ?? ''}:${target.column ?? ''}`;
		const generation = ++openGeneration.current;
		hapticSelection();
		setOpeningKey(key);
		void fsResolveLink(ws, target.path).then(resolved => {
			if (openGeneration.current === generation) {
				setViewer({ ws, path: resolved.path, ...(target.line !== undefined ? { line: target.line } : {}) });
			}
		}).catch(error => {
			if (openGeneration.current === generation) {
				Alert.alert('ファイルを開けません', String(error instanceof Error ? error.message : error));
			}
		}).finally(() => {
			if (openGeneration.current === generation) {
				setOpeningKey(current => current === key ? undefined : current);
			}
		});
	};
	return (
		<View style={styles.root}>
			{blocks.map((block, i) => {
				if (block.kind === 'code') {
					return <CodeBlock key={i} text={block.text} lang={block.lang} />;
				}
				if (block.kind === 'heading') {
					return (
						<Text key={i} style={[styles.body, styles.heading, block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : null]} selectable>
							{renderInlineTokens(parseInline(block.text), styles.body, openLocal)}
						</Text>
					);
				}
				if (block.kind === 'bullet') {
					return (
						<View key={i} style={styles.bulletRow}>
							<Text style={[styles.body, styles.bulletMarker]}>{block.marker}</Text>
							<View style={styles.bulletBody}><InlineBlock text={block.text} onOpenLocal={openLocal} openingKey={openingKey} /></View>
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
											{renderInlineTokens(parseInline(cell), styles.body, openLocal)}
										</Text>
									</View>
								))}
							</View>
							{block.rows.map((row, r) => (
								<View key={r} style={[styles.tableRow, r % 2 === 1 ? styles.tableRowAlt : null]}>
									{Array.from({ length: cols }, (_, c) => (
										<View key={c} style={[styles.tableCell, c > 0 ? styles.tableCellBorder : null]}>
											<Text style={[styles.body, styles.tableCellText, { textAlign: block.aligns[c] ?? 'left' }]} selectable>
												{renderInlineTokens(parseInline(row[c] ?? ''), styles.body, openLocal)}
											</Text>
										</View>
									))}
								</View>
							))}
						</View>
					);
				}
				return <InlineBlock key={i} text={block.text} onOpenLocal={openLocal} openingKey={openingKey} />;
			})}
			{viewer !== undefined ? (
				<WorkspaceFileViewer ws={viewer.ws} path={viewer.path} focusLine={viewer.line} backLabel="エージェント" onClose={() => setViewer(undefined)} />
			) : null}
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
	inlineStack: { gap: 6 },
	fileCard: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.glassBg, borderWidth: 1, borderColor: colors.glassBorder, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 11 },
	fileCardPressed: { opacity: 0.72 },
	fileIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentWash },
	fileInfo: { flex: 1, gap: 2 },
	fileLabel: { color: colors.text, fontSize: 13, fontWeight: '600' },
	filePath: { color: colors.textDim, fontFamily: mono, fontSize: 10, lineHeight: 14 },
	table: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: 'hidden', marginVertical: 2 },
	tableRow: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
	tableHead: { backgroundColor: 'rgba(110,118,129,.18)', borderTopWidth: 0 },
	tableRowAlt: { backgroundColor: 'rgba(110,118,129,.07)' },
	tableCell: { flex: 1, paddingVertical: 5, paddingHorizontal: 7 },
	tableCellBorder: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
	tableHeadText: { fontWeight: '700', fontSize: 12, lineHeight: 17 },
	tableCellText: { fontSize: 12, lineHeight: 17 },
});
