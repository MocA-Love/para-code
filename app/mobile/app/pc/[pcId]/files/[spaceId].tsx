// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useLocalSearchParams } from 'expo-router';
import { firstParam } from '../../../../src/routes.js';
import { Screen, ScreenHeader } from '../../../../src/ui/index.js';
import { CenterSpinner, SpaceGateBody } from '../../../../src/features/code/codeParts.js';
import { FileTreePanel } from '../../../../src/features/code/fileTreePanel.js';
import { baseName } from '../../../../src/features/code/fileTree.js';
import { FileViewerPanel } from '../../../../src/features/code/fileViewerPanel.js';
import { filesTarget, parseFocusLine } from '../../../../src/features/code/fileViewerModel.js';
import { useCodeSpace } from '../../../../src/features/code/useCodeSpace.js';
import { useFilesTarget } from '../../../../src/features/code/useFilesTarget.js';

/**
 * ファイル（`/pc/[pcId]/files/[spaceId]?path=…`）。Orca の files に合わせ、ツリー（MobileFileExplorerPanel）と
 * ビューア（MobileFilePreviewScreen）を同じルートで出し分ける。
 *
 * | クエリ | 出すもの |
 * |---|---|
 * | なし | 根からのツリー |
 * | `path` + `view=dir` | そのフォルダまで開いたツリー |
 * | `path` + `view=file`（+ `line`） | ファイルのビューア（`line` はその行へ送る） |
 * | `path` だけ | 親のフォルダを読んで、フォルダならツリー・ファイルならビューア |
 *
 * 行き先は `src/features/code/codeRoutes.ts` の `fileViewerHref` / `folderHref` で作る。
 */
export default function FilesScreen() {
	const params = useLocalSearchParams<{ path?: string | string[]; view?: string | string[]; line?: string | string[] }>();
	const codeSpace = useCodeSpace();
	const target = useFilesTarget(codeSpace, filesTarget(firstParam(params.path), firstParam(params.view)));

	if (target.kind === 'file') {
		return <FileViewerPanel codeSpace={codeSpace} path={target.path} focusLine={parseFocusLine(firstParam(params.line))} />;
	}
	if (target.kind === 'tree') {
		return <FileTreePanel codeSpace={codeSpace} reveal={target.reveal} />;
	}
	return (
		<Screen>
			<ScreenHeader title={baseName(target.path)} surface="panel" />
			<SpaceGateBody gate={codeSpace.gate}>
				<CenterSpinner label="開いています…" />
			</SpaceGateBody>
		</Screen>
	);
}
