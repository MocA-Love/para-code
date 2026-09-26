// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Construction } from 'lucide-react-native';
import { EmptyState, Screen, ScreenHeader } from '../../../../src/ui/index.js';

/**
 * ソース管理（`/pc/[pcId]/source-control/[spaceId]`）。**段階2の仮の画面**で、段階5の担当が Orca の source-control（変更 / コミットの区分、下に固定のコミットバー）に作り直す。ルートは `useRouteSpace(params.pcId, params.spaceId)` で読む。
 */
export default function SourceControlScreen() {
	return (
		<Screen>
			<ScreenHeader title="ソース管理" surface="panel" />
			<EmptyState icon={Construction} title="作成中" body="この画面は作り直しの途中です。" />
		</Screen>
	);
}
