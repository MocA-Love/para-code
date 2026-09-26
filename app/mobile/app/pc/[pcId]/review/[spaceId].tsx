// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Construction } from 'lucide-react-native';
import { EmptyState, Screen, ScreenHeader } from '../../../../src/ui/index.js';

/**
 * 差分レビュー（`/pc/[pcId]/review/[spaceId]?path=…`）。**段階2の仮の画面**で、段階5の担当が Orca の MobileDiffReview に作り直す。
 */
export default function ReviewScreen() {
	return (
		<Screen>
			<ScreenHeader title="差分レビュー" surface="panel" />
			<EmptyState icon={Construction} title="作成中" body="この画面は作り直しの途中です。" />
		</Screen>
	);
}
