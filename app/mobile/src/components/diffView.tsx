// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * unified diff のフルスクリーンビューア。GitHub モバイルアプリ風に、
 * 行番号つき・追加行は緑背景・削除行は赤背景・ハンク見出しは青系で表示する。
 */

import { useMemo } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme.js';

interface DiffViewProps {
	path: string;
	/** unified diff テキスト。undefined は読み込み中。 */
	diff: string | undefined;
	onClose: () => void;
}

type DiffRowKind = 'hunk' | 'add' | 'del' | 'ctx';

interface DiffRow {
	kind: DiffRowKind;
	oldNo?: number;
	newNo?: number;
	text: string;
}

/** unified diff を表示行の配列にパースする（ファイルヘッダ行は省く）。 */
export function parseUnifiedDiff(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let oldNo = 0;
	let newNo = 0;
	for (const line of diff.split('\n')) {
		if (line.startsWith('@@')) {
			const m = line.match(/^@@ -(?<oldStart>\d+)(?:,\d+)? \+(?<newStart>\d+)(?:,\d+)? @@(?<rest>.*)$/);
			if (m?.groups) {
				oldNo = parseInt(m.groups.oldStart ?? '1', 10);
				newNo = parseInt(m.groups.newStart ?? '1', 10);
				rows.push({ kind: 'hunk', text: line });
			}
		} else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename ') || line.startsWith('Binary files') || line.startsWith('\\')) {
			// ファイルメタ情報はビューアのヘッダで代替する（Binary等は文脈行として出さない）
			if (line.startsWith('Binary files')) {
				rows.push({ kind: 'hunk', text: line });
			}
		} else if (line.startsWith('+')) {
			// 未追跡ファイルの擬似diff（全行+でハンク見出しなし）は1行目から数える
			if (newNo === 0) {
				newNo = 1;
			}
			rows.push({ kind: 'add', newNo: newNo++, text: line.slice(1) });
		} else if (line.startsWith('-')) {
			if (oldNo === 0) {
				oldNo = 1;
			}
			rows.push({ kind: 'del', oldNo: oldNo++, text: line.slice(1) });
		} else if (line.startsWith(' ') || line === '') {
			// ハンク開始前の空行などは無視（ハンク内の文脈行のみ番号を進める）
			if (oldNo > 0 || newNo > 0) {
				rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
			}
		}
	}
	return rows;
}

export function DiffView({ path, diff, onClose }: DiffViewProps) {
	const rows = useMemo(() => (diff === undefined ? [] : parseUnifiedDiff(diff)), [diff]);
	const stats = useMemo(() => ({
		add: rows.filter(r => r.kind === 'add').length,
		del: rows.filter(r => r.kind === 'del').length,
	}), [rows]);

	return (
		<Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
			<View style={styles.screen}>
				<View style={styles.header}>
					<Ionicons name="git-compare-outline" size={16} color={colors.textDim} />
					<Text style={styles.title} numberOfLines={1}>{path}</Text>
					<Text style={styles.statAdd}>+{stats.add}</Text>
					<Text style={styles.statDel}>-{stats.del}</Text>
					<Pressable onPress={onClose} hitSlop={8} accessibilityLabel="閉じる">
						<Ionicons name="close" size={22} color={colors.text} />
					</Pressable>
				</View>
				<ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
					{diff === undefined ? <Text style={styles.dim}>読み込み中…</Text> : null}
					{diff !== undefined && rows.length === 0 ? <Text style={styles.dim}>{diff.trim() || '差分はありません'}</Text> : null}
					{rows.map((row, i) => {
						if (row.kind === 'hunk') {
							return (
								<View key={i} style={[styles.row, styles.hunkRow]}>
									<Text style={styles.hunkText} numberOfLines={1}>{row.text}</Text>
								</View>
							);
						}
						const rowStyle = row.kind === 'add' ? styles.addRow : row.kind === 'del' ? styles.delRow : undefined;
						const numStyle = row.kind === 'add' ? styles.addNum : row.kind === 'del' ? styles.delNum : undefined;
						const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
						const signStyle = row.kind === 'add' ? styles.signAdd : row.kind === 'del' ? styles.signDel : styles.signCtx;
						return (
							<View key={i} style={[styles.row, rowStyle]}>
								<Text style={[styles.lineNo, numStyle]}>{row.oldNo ?? ''}</Text>
								<Text style={[styles.lineNo, numStyle]}>{row.newNo ?? ''}</Text>
								<Text style={[styles.sign, signStyle]}>{sign}</Text>
								<Text style={styles.code}>{row.text || ' '}</Text>
							</View>
						);
					})}
					<View style={{ height: 32 }} />
				</ScrollView>
			</View>
		</Modal>
	);
}

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: '#0d1117' },
	header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 58, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface },
	title: { flex: 1, color: colors.text, fontSize: 13, fontFamily: MONO },
	statAdd: { color: '#3fb950', fontSize: 12, fontFamily: MONO, fontWeight: '700' },
	statDel: { color: '#f85149', fontSize: 12, fontFamily: MONO, fontWeight: '700', marginRight: 4 },
	body: { flex: 1 },
	bodyContent: { paddingVertical: 8 },
	dim: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 24 },
	row: { flexDirection: 'row', alignItems: 'flex-start', minHeight: 20 },
	hunkRow: { backgroundColor: 'rgba(56,139,253,0.12)', paddingHorizontal: 10, paddingVertical: 4, marginVertical: 4 },
	hunkText: { color: '#58a6ff', fontSize: 11, fontFamily: MONO },
	addRow: { backgroundColor: 'rgba(46,160,67,0.16)' },
	delRow: { backgroundColor: 'rgba(248,81,73,0.14)' },
	lineNo: { width: 34, textAlign: 'right', color: '#6e7681', fontSize: 10, fontFamily: MONO, paddingTop: 3, paddingRight: 4 },
	addNum: { color: '#7ee2a8' },
	delNum: { color: '#ffa198' },
	sign: { width: 14, textAlign: 'center', fontSize: 11, fontFamily: MONO, paddingTop: 2 },
	signAdd: { color: '#3fb950', fontWeight: '700' },
	signDel: { color: '#f85149', fontWeight: '700' },
	signCtx: { color: '#6e7681' },
	code: { flex: 1, color: '#e6edf3', fontSize: 11, lineHeight: 17, fontFamily: MONO, paddingRight: 10, paddingTop: 2 },
});
