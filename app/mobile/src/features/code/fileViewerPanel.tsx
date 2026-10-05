// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsFocused, useNavigation, useRouter } from 'expo-router';
import { CloudOff, Code, Eye, Search, X } from 'lucide-react-native';
import { useShortcutSlot } from '../../ipad/shortcutRegistry.js';
import { colors, space } from '../../theme.js';
import { EmptyState, HeaderButton, Screen, ScreenHeader } from '../../ui/index.js';
import { codeCacheKey, useCodeCache } from './codeCache.js';
import { OfflineBanner, SpaceGateBody } from './codeParts.js';
import { folderHref } from './codeRoutes.js';
import { findTargetOf } from './fileFind.js';
import { FileFindBar } from './fileFindBar.js';
import { FileViewerBody } from './fileViewerBody.js';
import { ViewerCrumbs } from './filesParts.js';
import { baseName } from './fileTree.js';
import { DIR_VIEW, FILE_VIEW, canToggleSource, defaultViewerMode, viewerBreadcrumb, viewerKindOf, type ViewerMode } from './fileViewerModel.js';
import type { CodeSpace } from './useCodeSpace.js';
import { useFileContent } from './useFileContent.js';
import { useFileFind } from './useFileFind.js';

/**
 * ファイルビューア（Orca の MobileFilePreviewScreen。モックの「ファイルビューア（README.md）」）。
 * タイトルはファイル名、その下にパンくず（押すとツリーのそのフォルダへ）。Markdown と HTML は
 * 右上でプレビューとソースを切り替える。
 *
 * 右端の虫めがねで、見出しの帯の下にファイル内の検索欄を出す（虫めがねは X に変わる。ファイルの画面の検索と同じ形）。
 * 画像・動画・音声・PDF では押せない。iPad の外付けキーボードでは ⌘F で開き、⌘G・⇧⌘G で前後の一致へ、Esc で閉じる。
 * 欄は見出しの children に出し入れするので、本文の WebView は作り直さない。
 */
export function FileViewerPanel({ codeSpace, path, focusLine }: { codeSpace: CodeSpace; path: string; focusLine: number | undefined }) {
	const router = useRouter();
	const navigation = useNavigation();
	const kind = viewerKindOf(path);
	const [mode, setMode] = useState<ViewerMode>(defaultViewerMode(kind, focusLine));
	const { content, selectSheet } = useFileContent(codeSpace, path, mode);
	const crumbs = viewerBreadcrumb(codeSpace.name, path);
	const find = useFileFind();
	const searchable = findTargetOf(kind, mode) !== undefined;
	const focused = useIsFocused();
	useShortcutSlot('find', focused && searchable ? { open: find.show, step: find.step } : undefined);
	useShortcutSlot('escape', focused && find.open ? { escape: find.close } : undefined);

	/**
	 * パンくずを押した。1つ前の画面が同じスペースのツリーならそこへ戻ってフォルダを開き
	 * （開いていたフォルダや位置を残すため）、そうでなければこの画面をツリーに置き換える。
	 */
	const openFolder = (target: string) => {
		const { pcId, spaceId } = codeSpace;
		if (pcId === undefined || spaceId === undefined) {
			return;
		}
		const state = navigation.getState();
		const currentRoute = state?.routes[state.index];
		const previous = state !== undefined && state.index > 0 ? state.routes[state.index - 1] : undefined;
		const params = new Map<string, unknown>(Object.entries(previous?.params ?? {}));
		const previousIsTree = previous !== undefined && previous.name === currentRoute?.name
			&& params.get('pcId') === pcId
			&& params.get('spaceId') === spaceId
			&& params.get('view') !== FILE_VIEW
			&& (params.get('view') === DIR_VIEW || params.get('path') === undefined);
		if (previousIsTree && router.canGoBack()) {
			useCodeCache.getState().requestReveal(codeCacheKey(pcId, spaceId), target);
			router.back();
			return;
		}
		router.replace(folderHref(pcId, spaceId, target));
	};

	const waiting = content === undefined && codeSpace.unavailable !== undefined;
	return (
		<Screen>
			<ScreenHeader
				title={baseName(path)}
				meta={<ViewerCrumbs items={crumbs} onSelect={openFolder} />}
				surface="panel"
				right={(
					<>
						{canToggleSource(kind) ? (
							<HeaderButton
								icon={mode === 'render' ? Code : Eye}
								label={mode === 'render' ? 'ソースを表示' : 'プレビューを表示'}
								onPress={() => setMode(current => (current === 'render' ? 'code' : 'render'))}
							/>
						) : null}
						<HeaderButton
							icon={find.open ? X : Search}
							label={find.open ? '検索を閉じる' : 'ファイル内を検索'}
							onPress={find.toggle}
							active={find.open}
							disabled={!searchable}
						/>
					</>
				)}
			>
				{find.open && searchable ? <FileFindBar inputRef={find.inputRef} query={find.query} result={find.result} onChangeQuery={find.changeQuery} onStep={find.step} onEscape={find.close} /> : null}
			</ScreenHeader>
			<SpaceGateBody gate={codeSpace.gate}>
				<View style={styles.body}>
					<OfflineBanner reason={codeSpace.unavailable} style={styles.banner} />
					{waiting ? (
						<EmptyState icon={CloudOff} title="ファイルを読み込めません" body={`${codeSpace.unavailable ?? ''}。つながると読み込みます。`} />
					) : (
						<FileViewerBody path={path} kind={kind} mode={mode} content={content} focusLine={focusLine} onSelectSheet={selectSheet} find={find.binding} />
					)}
				</View>
			</SpaceGateBody>
		</Screen>
	);
}

const styles = StyleSheet.create({
	body: {
		flex: 1,
		backgroundColor: colors.codeBg,
	},
	banner: {
		marginBottom: space.sm,
	},
});
