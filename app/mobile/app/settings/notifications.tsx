// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Construction } from 'lucide-react-native';
import { EmptyState, Screen, ScreenHeader } from '../../src/ui/index.js';

/**
 * 通知と音声の設定（`/settings/notifications`）。**段階2の仮の画面**で、段階6の担当が作り直す。
 */
export default function NotificationSettingsScreen() {
	return (
		<Screen>
			<ScreenHeader title="通知と音声" variant="settings" />
			<EmptyState icon={Construction} title="作成中" body="この画面は作り直しの途中です。" />
		</Screen>
	);
}
