// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Construction } from 'lucide-react-native';
import { EmptyState, Screen, ScreenHeader } from '../../src/ui/index.js';

/**
 * 更新履歴（`/settings/changelog`）。**段階2の仮の画面**で、段階6の担当が作り直す（中身は `src/changelog.ts` の `MOBILE_CHANGELOG`）。
 */
export default function ChangelogScreen() {
	return (
		<Screen>
			<ScreenHeader title="更新履歴" variant="settings" />
			<EmptyState icon={Construction} title="作成中" body="この画面は作り直しの途中です。" />
		</Screen>
	);
}
