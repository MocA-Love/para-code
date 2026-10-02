// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { File, FileText, Folder, FolderOpen, Image as ImageIcon } from 'lucide-react-native';
import { pcHasCapabilityFor, useAppStore } from '../../appState.js';
import { PcCapability, pcHasCapability } from '../../pcCompat.js';
import { colors } from '../../theme.js';
import { Icon, iconSize } from '../../ui/index.js';
import { ensureIconTheme, requestIconSvg, useFileIconStore } from './fileIconStore.js';
import { iconIdFor, iconTargetOf } from './fileIconTheme.js';
import { viewerKindOf } from './fileViewerModel.js';

/** テーマの SVG が無いときのアイコン（従来の lucide の 3 種類とフォルダー）。 */
function fallbackIconOf(name: string, dir: boolean, expanded: boolean | undefined) {
	if (dir) {
		return expanded === true ? FolderOpen : Folder;
	}
	const kind = viewerKindOf(name);
	return kind === 'markdown' ? FileText : kind === 'image' ? ImageIcon : File;
}

/**
 * ファイル・フォルダーのアイコン。PC で選んでいるファイルアイコンのテーマ（`fs.icon-theme.v1`）の SVG を描き、
 * PC が対応していない・テーマがフォント形式（Seti など）・SVG がまだ届いていない間は lucide のアイコンで描く。
 * 大きさはどちらでも同じ（既定 16pt）なので、SVG が届いても行の高さや字下げは変わらない。
 *
 * `parentName` は親のフォルダーの名前（`github/workflows` のように親で絞る規則に使う。無くてもよい）。
 */
export const FileTypeIcon = memo(function FileTypeIcon({ pcId, name, dir, expanded, parentName, size = iconSize.md }: {
	/** そのファイルがある PC（いま前面の PC とは限らない）。 */
	pcId: string | undefined;
	name: string;
	dir: boolean;
	expanded?: boolean;
	parentName?: string;
	size?: number;
}) {
	// 前面の PC なら届いた State の広告を購読し、そうでなければその PC の接続の広告を読む
	const supported = useAppStore(s => pcId !== undefined && (s.activePcId === pcId ? pcHasCapability(s.workspace, PcCapability.FsIconTheme) : pcHasCapabilityFor(pcId, PcCapability.FsIconTheme)));
	const target = iconTargetOf(dir, expanded);
	const id = useFileIconStore(s => (supported && pcId !== undefined ? iconIdFor(s.themes[pcId], name, parentName, target) : undefined));
	const svg = useFileIconStore(s => (id !== undefined && pcId !== undefined ? s.themes[pcId]?.svgs[id] : undefined));

	useEffect(() => {
		if (supported && pcId !== undefined) {
			ensureIconTheme(pcId);
		}
	}, [supported, pcId]);
	useEffect(() => {
		if (pcId !== undefined && id !== undefined && svg === undefined) {
			requestIconSvg(pcId, id);
		}
	}, [pcId, id, svg]);

	// 同じ大きさの枠の中で描き分ける（SVG に替わっても周りの配置を動かさない）
	return (
		<View style={[styles.box, { width: size, height: size }]}>
			{typeof svg === 'string'
				? <SvgXml xml={svg} width={size} height={size} onError={ignoreSvgError} />
				: <Icon icon={fallbackIconOf(name, dir, expanded)} size={size} color={colors.textDim} />}
		</View>
	);
});

/** 読めない SVG は空の枠のままにする（行ごと落とさない）。 */
function ignoreSvgError(): void { }

const styles = StyleSheet.create({
	box: {
		alignItems: 'center',
		justifyContent: 'center',
	},
});
