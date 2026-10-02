// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle } from 'react-native';
import { ChevronDown, ChevronRight, Search } from 'lucide-react-native';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import type { BreadcrumbItem } from '../../filesBreadcrumb.js';
import { matchRanges, type FilesSearchMode } from '../../filesSearch.js';
import { hapticSelection } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import { HIT_SIZE, colors, radius, space, type } from '../../theme.js';
import { Icon, iconSize, useThemeColors } from '../../ui/index.js';
import type { FileDecoration } from './fileDecorations.js';
import { FileTypeIcon } from './fileIcons.js';
import { baseName, formatSize, parentPath, type TreeRow } from './fileTree.js';

/**
 * ファイルの画面の部品（Orca の mobile-file-explorer-row・検索欄・ビューアのパンくず。
 * 寸法はモックの `.trow` `.searchbar` `.sfield` `.crumb`）。
 */

/** ツリーの1段ぶんの字下げ（pt。Orca と同じ）。 */
const INDENT = 18;
/** シェブロンの列の幅（pt。ファイルの行はこの幅だけ空ける）。 */
const CHEVRON_WIDTH = 16;

/**
 * ツリーの1行（フォルダは押すと開閉、ファイルは押すとビューアへ）。`decoration` は Git の色と右端の文字
 * （`fileDecorations.ts`。PC のエクスプローラーと同じ見え方）。
 */
export function TreeRowView({ pcId, row, expanded, highlighted, decoration, disabled, onToggle, onOpen, onRetry }: {
	/** アイコンのテーマを引く PC。 */
	pcId: string | undefined;
	row: TreeRow;
	expanded: boolean;
	highlighted: boolean;
	decoration?: FileDecoration;
	disabled: boolean;
	onToggle: (path: string) => void;
	onOpen: (path: string) => void;
	onRetry: (path: string) => void;
}) {
	const theme = useThemeColors();
	const indent = { paddingLeft: space.lg + row.depth * INDENT };
	if (row.kind === 'loading') {
		return (
			<View style={[styles.statusRow, indent]}>
				<View style={styles.chevronSpace} />
				<ActivityIndicator size="small" color={colors.textDim} />
				<Text style={styles.statusText}>読み込み中…</Text>
			</View>
		);
	}
	if (row.kind === 'error') {
		return (
			<View style={[styles.statusRow, indent]}>
				<View style={styles.chevronSpace} />
				<Text style={styles.errorText} numberOfLines={1}>{row.message ?? 'フォルダを読み込めませんでした'}</Text>
				<Pressable
					onPress={() => { hapticSelection(); onRetry(row.path); }}
					hitSlop={hitSlopToMinimum(RETRY_HEIGHT)}
					style={({ pressed }) => [styles.retry, pressed ? styles.pressed : undefined]}
					accessibilityRole="button"
					accessibilityLabel={`${row.path} をもう一度読み込む`}
				>
					<Text style={styles.retryText}>再試行</Text>
				</Pressable>
			</View>
		);
	}
	const dir = row.kind === 'dir';
	return (
		<Pressable
			onPress={() => {
				hapticSelection();
				if (dir) {
					onToggle(row.path);
				} else {
					onOpen(row.path);
				}
			}}
			disabled={disabled && !dir}
			style={({ pressed }) => [styles.row, indent, highlighted ? { backgroundColor: theme.accentWash } : undefined, pressed ? styles.pressed : undefined]}
			accessibilityRole="button"
			accessibilityState={dir ? { expanded } : undefined}
			accessibilityLabel={`${dir ? 'フォルダ' : 'ファイル'} ${row.name}${decoration !== undefined ? `、${decoration.label}` : ''}`}
		>
			{dir ? <Icon icon={expanded ? ChevronDown : ChevronRight} size={iconSize.md} color={colors.textMuted} /> : <View style={styles.chevronSpace} />}
			<FileTypeIcon pcId={pcId} name={row.name} dir={dir} expanded={dir ? expanded : undefined} parentName={baseName(parentPath(row.path)) || undefined} />
			<View style={styles.col}>
				<Text style={[styles.name, decoration !== undefined ? { color: decoration.color } : undefined]} numberOfLines={1}>{row.name}</Text>
				{!dir && row.size !== undefined ? <Text style={styles.sub}>{formatSize(row.size)}</Text> : null}
			</View>
			<Text style={[styles.badge, decoration !== undefined ? { color: decoration.color } : undefined]} importantForAccessibility="no">{decoration?.badge ?? ''}</Text>
		</Pressable>
	);
}

const SEARCH_MODES: readonly { readonly key: FilesSearchMode; readonly label: string }[] = [
	{ key: 'name', label: '名前' },
	{ key: 'text', label: '内容' },
];

/**
 * 検索欄（モックの `.searchbar`）。`ScreenHeader` の children に置く。入力は uncontrolled
 * （打ちながら親を描き直しても、欄の中身とカーソルが揺れないように）。
 */
export function FilesSearchBar({ mode, initialQuery = '', onChangeMode, onChangeQuery, editable }: {
	mode: FilesSearchMode;
	/** 開いたときに入れておく文字（退避しておいた検索を戻すとき）。 */
	initialQuery?: string;
	onChangeMode: (mode: FilesSearchMode) => void;
	onChangeQuery: (query: string) => void;
	editable: boolean;
}) {
	return (
		<View style={styles.searchBar}>
			<View style={styles.field}>
				<Icon icon={Search} size={iconSize.sm} color={colors.textMuted} />
				<TextInput
					style={styles.input}
					autoFocus={initialQuery.length === 0}
					defaultValue={initialQuery}
					onChangeText={onChangeQuery}
					placeholder={mode === 'name' ? 'ファイル名で検索…' : 'ファイルの内容を検索…'}
					placeholderTextColor={colors.textMuted}
					autoCapitalize="none"
					autoCorrect={false}
					returnKeyType="search"
					clearButtonMode="while-editing"
					editable={editable}
					accessibilityLabel="ファイルを検索"
				/>
			</View>
			<View style={styles.modes} accessibilityRole="radiogroup">
				{SEARCH_MODES.map(item => {
					const on = item.key === mode;
					return (
						<Pressable
							key={item.key}
							onPress={() => { if (!on) { hapticSelection(); onChangeMode(item.key); } }}
							hitSlop={hitSlopToMinimum(SEARCH_FIELD_HEIGHT - space.xs * 2)}
							style={[styles.mode, on ? styles.modeOn : undefined]}
							accessibilityRole="radio"
							accessibilityState={{ selected: on }}
							accessibilityLabel={item.key === 'name' ? 'ファイル名で検索' : 'ファイルの内容で検索'}
						>
							<Text style={[styles.modeText, on ? styles.modeTextOn : undefined]}>{item.label}</Text>
						</Pressable>
					);
				})}
			</View>
		</View>
	);
}

/** 一致した箇所を青の太字で示す（地は敷かない）。規則は PC 側と同じ `matchRanges`。 */
function Highlighted({ text, query, smartCase, lines, style }: { text: string; query: string; smartCase: boolean; lines: number; style: StyleProp<TextStyle> }) {
	const theme = useThemeColors();
	const ranges = matchRanges(text, query, smartCase);
	const parts: ReactNode[] = [];
	let at = 0;
	for (const [index, range] of ranges.entries()) {
		if (range.start > at) {
			parts.push(text.slice(at, range.start));
		}
		parts.push(<Text key={index} style={[styles.hit, { color: theme.accent }]}>{text.slice(range.start, range.end)}</Text>);
		at = range.end;
	}
	if (at < text.length) {
		parts.push(text.slice(at));
	}
	return <Text style={style} numberOfLines={lines}>{parts}</Text>;
}

/** ファイル名の検索の結果の行。 */
export function FindResultRow({ pcId, path, query, onOpen }: { pcId: string | undefined; path: string; query: string; onOpen: (path: string) => void }) {
	const at = path.lastIndexOf('/');
	const name = at < 0 ? path : path.slice(at + 1);
	return (
		<Pressable
			onPress={() => { hapticSelection(); onOpen(path); }}
			style={({ pressed }) => [styles.row, styles.resultRow, pressed ? styles.pressed : undefined]}
			accessibilityRole="button"
			accessibilityLabel={`ファイル ${path}`}
		>
			<FileTypeIcon pcId={pcId} name={name} dir={false} parentName={baseName(parentPath(path)) || undefined} />
			<View style={styles.col}>
				<Highlighted text={name} query={query} smartCase={false} lines={1} style={styles.name} />
				<Highlighted text={path} query={query} smartCase={false} lines={1} style={styles.sub} />
			</View>
		</Pressable>
	);
}

/** 内容の検索の結果の行（パス:行番号 と、その行）。 */
export function GrepResultRow({ path, line, text, query, onOpen }: { path: string; line: number; text: string; query: string; onOpen: (path: string, line: number) => void }) {
	return (
		<Pressable
			onPress={() => { hapticSelection(); onOpen(path, line); }}
			style={({ pressed }) => [styles.row, styles.resultRow, pressed ? styles.pressed : undefined]}
			accessibilityRole="button"
			accessibilityLabel={`${path} の ${line} 行目`}
		>
			<View style={styles.col}>
				<Text style={styles.sub} numberOfLines={1}>{`${path}:${line}`}</Text>
				<Highlighted text={text.trim()} query={query} smartCase lines={2} style={styles.preview} />
			</View>
		</Pressable>
	);
}

/**
 * ビューアのタイトルの下のパンくず（モックの `.crumb`。下線付きの 12pt）。
 * どれを押してもツリーのそのフォルダへ移る。
 */
export function ViewerCrumbs({ items, onSelect }: { items: readonly BreadcrumbItem[]; onSelect: (target: string) => void }) {
	return (
		<View style={styles.crumbs}>
			{items.map((item, index) => (
				<View key={item.target} style={styles.crumbItem}>
					{index > 0 ? <Text style={styles.crumbSep}>/</Text> : null}
					<Pressable
						onPress={() => { hapticSelection(); onSelect(item.target); }}
						hitSlop={hitSlopToMinimum(CRUMB_HEIGHT)}
						style={styles.crumbButton}
						accessibilityRole="link"
						accessibilityLabel={`フォルダ ${item.label} を開く`}
					>
						{({ pressed }) => <Text style={[styles.crumbText, pressed ? styles.crumbTextPressed : undefined]} numberOfLines={1}>{item.label}</Text>}
					</Pressable>
				</View>
			))}
		</View>
	);
}

/** 右端の Git の文字の列の幅（pt）。文字が無い行も同じ幅を空けて、名前の右端をそろえる。 */
const BADGE_WIDTH = 18;
/** 検索欄の高さ（pt。モックの `.sfield`）。 */
const SEARCH_FIELD_HEIGHT = 36;
/** 再試行のボタンの高さ（pt。Orca の inlineRetryButton）。当たり判定は 44 に広げる。 */
const RETRY_HEIGHT = 28;
/** パンくずの文字の高さ（pt）。当たり判定は 44 に広げる。 */
const CRUMB_HEIGHT = 16;

const styles = StyleSheet.create({
	row: {
		minHeight: HIT_SIZE,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingRight: space.md,
	},
	resultRow: {
		paddingLeft: space.lg,
		paddingVertical: space.sm,
	},
	pressed: {
		backgroundColor: colors.raised,
	},
	chevronSpace: {
		width: CHEVRON_WIDTH,
	},
	col: {
		flex: 1,
		minWidth: 0,
	},
	badge: {
		width: BADGE_WIDTH,
		textAlign: 'center',
		fontSize: type.meta,
		fontWeight: '600',
	},
	name: {
		fontSize: type.body,
		color: colors.text,
	},
	sub: {
		fontSize: type.caption,
		color: colors.textMuted,
		marginTop: 1,
	},
	preview: {
		fontSize: type.meta,
		fontFamily: monoFamily,
		color: colors.text,
		marginTop: 2,
	},
	hit: {
		color: colors.accent,
		fontWeight: '700',
	},
	statusRow: {
		minHeight: 36,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingRight: space.md,
	},
	statusText: {
		fontSize: type.meta,
		color: colors.textDim,
	},
	errorText: {
		flex: 1,
		minWidth: 0,
		fontSize: type.meta,
		color: colors.red,
	},
	retry: {
		minHeight: RETRY_HEIGHT,
		justifyContent: 'center',
		paddingHorizontal: space.md,
		borderRadius: radius.button,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
	},
	retryText: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.text,
	},
	searchBar: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingVertical: space.sm,
		paddingHorizontal: space.md,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	field: {
		flex: 1,
		minWidth: 0,
		height: SEARCH_FIELD_HEIGHT,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingHorizontal: space.sm + 2,
		borderRadius: radius.tile,
		backgroundColor: colors.raised,
	},
	input: {
		flex: 1,
		minWidth: 0,
		height: SEARCH_FIELD_HEIGHT,
		fontSize: type.input,
		color: colors.text,
	},
	modes: {
		flexDirection: 'row',
		height: SEARCH_FIELD_HEIGHT,
		padding: space.xs - 1,
		borderRadius: radius.tile,
		backgroundColor: colors.raised,
	},
	mode: {
		justifyContent: 'center',
		paddingHorizontal: space.sm + 2,
		borderRadius: radius.button,
	},
	modeOn: {
		backgroundColor: colors.borderStrong,
	},
	modeText: {
		fontSize: type.label,
		fontWeight: '600',
		color: colors.textDim,
	},
	modeTextOn: {
		color: colors.text,
	},
	crumbs: {
		flex: 1,
		minWidth: 0,
		flexDirection: 'row',
		alignItems: 'center',
		flexWrap: 'nowrap',
		overflow: 'hidden',
	},
	crumbItem: {
		flexDirection: 'row',
		alignItems: 'center',
		flexShrink: 1,
		minWidth: 0,
	},
	crumbSep: {
		fontSize: type.meta,
		color: colors.textDim,
		marginHorizontal: 2,
	},
	crumbButton: {
		flexShrink: 1,
		minWidth: 0,
	},
	crumbText: {
		fontSize: type.meta,
		color: colors.textDim,
		textDecorationLine: 'underline',
		textDecorationColor: colors.borderStrong,
	},
	crumbTextPressed: {
		color: colors.text,
	},
});
