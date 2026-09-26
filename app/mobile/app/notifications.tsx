// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Construction } from 'lucide-react-native';
import { EmptyState, Screen, ScreenHeader } from '../src/ui/index.js';

/**
 * 通知の一覧（`/notifications`）。**段階2の仮の画面**で、段階6の担当が作り直す（Orca に無い画面なので、設定の部品で組む。モックの「通知」）。
 */
export default function NotificationsScreen() {
	return (
		<Screen>
			<ScreenHeader title="通知" />
			<EmptyState icon={Construction} title="作成中" body="この画面は作り直しの途中です。" />
		</Screen>
	);
}
