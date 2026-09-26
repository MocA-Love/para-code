// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { CloudOff, Code, Eye } from 'lucide-react-native';
import { colors, space } from '../../theme.js';
import { EmptyState, HeaderButton, Screen, ScreenHeader } from '../../ui/index.js';
import { codeCacheKey, useCodeCache } from './codeCache.js';
import { OfflineBanner, SpaceGateBody } from './codeParts.js';
import { folderHref } from './codeRoutes.js';
import { FileViewerBody } from './fileViewerBody.js';
import { ViewerCrumbs } from './filesParts.js';
import { baseName } from './fileTree.js';
import { DIR_VIEW, FILE_VIEW, canToggleSource, defaultViewerMode, viewerBreadcrumb, viewerKindOf, type ViewerMode } from './fileViewerModel.js';
import type { CodeSpace } from './useCodeSpace.js';
import { useFileContent } from './useFileContent.js';

/**
 * ファイルビューア（Orca の MobileFilePreviewScreen。モックの「ファイルビューア（README.md）」）。
 * タイトルはファイル名、その下にパンくず（押すとツリーのそのフォルダへ）。Markdown と HTML は
 * 右上でプレビューとソースを切り替える。
 */
export function FileViewerPanel({ codeSpace, path, focusLine }: { codeSpace: CodeSpace; path: string; focusLine: number | undefined }) {
	const router = useRouter();
	const navigation = useNavigation();
	const kind = viewerKindOf(path);
	const [mode, setMode] = useState<ViewerMode>(defaultViewerMode(kind, focusLine));
	const { content, selectSheet } = useFileContent(codeSpace, path);
	const crumbs = viewerBreadcrumb(codeSpace.name, path);

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
				right={canToggleSource(kind) ? (
					<HeaderButton
						icon={mode === 'render' ? Code : Eye}
						label={mode === 'render' ? 'ソースを表示' : 'プレビューを表示'}
						onPress={() => setMode(current => (current === 'render' ? 'code' : 'render'))}
					/>
				) : undefined}
			/>
			<SpaceGateBody gate={codeSpace.gate}>
				<View style={styles.body}>
					<OfflineBanner reason={codeSpace.unavailable} style={styles.banner} />
					{waiting ? (
						<EmptyState icon={CloudOff} title="ファイルを読み込めません" body={`${codeSpace.unavailable ?? ''}。つながると読み込みます。`} />
					) : (
						<FileViewerBody path={path} kind={kind} mode={mode} content={content} focusLine={focusLine} onSelectSheet={selectSheet} />
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
