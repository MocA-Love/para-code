// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * エージェント応答向けの軽量Markdownレンダラ（依存ゼロ）。
 * チャットバブル内で頻出する要素だけを対象にする:
 *  - コードブロック（```）/ インラインコード（`）
 *  - 太字（**）
 *  - 見出し（# 〜 ###）
 *  - 箇条書き（- / * / 1.）
 * それ以外はプレーンテキストとして安全に表示する（未対応記法で壊れない）。
 */

import type { ReactNode } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme.js';

type Block =
	| { kind: 'code'; text: string }
	| { kind: 'heading'; level: number; text: string }
	| { kind: 'bullet'; marker: string; text: string }
	| { kind: 'para'; text: string };

function parseBlocks(source: string): Block[] {
	const blocks: Block[] = [];
	const lines = source.split('\n');
	let codeLines: string[] | undefined;
	let paraLines: string[] = [];

	const flushPara = () => {
		if (paraLines.length > 0) {
			blocks.push({ kind: 'para', text: paraLines.join('\n') });
			paraLines = [];
		}
	};

	for (const line of lines) {
		if (codeLines !== undefined) {
			if (line.trimEnd().startsWith('```')) {
				blocks.push({ kind: 'code', text: codeLines.join('\n') });
				codeLines = undefined;
			} else {
				codeLines.push(line);
			}
			continue;
		}
		if (line.trimStart().startsWith('```')) {
			flushPara();
			codeLines = [];
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
		blocks.push({ kind: 'code', text: codeLines.join('\n') }); // 閉じ忘れフェンスも表示する
	}
	flushPara();
	return blocks;
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
					return (
						<View key={i} style={styles.codeBlock}>
							<Text style={styles.codeText} selectable>{block.text}</Text>
						</View>
					);
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
	bulletRow: { flexDirection: 'row', gap: 6 },
	bulletMarker: { color: colors.textDim },
	bulletBody: { flex: 1 },
});
