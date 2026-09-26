// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Construction } from 'lucide-react-native';
import { EmptyState, Screen, ScreenHeader } from '../../src/ui/index.js';

/**
 * ペアリング済みの PC（`/settings/pcs`）。**段階2の仮の画面**で、段階6の担当が作り直す（モックの「PC」）。
 */
export default function PcsSettingsScreen() {
	return (
		<Screen>
			<ScreenHeader title="PC" variant="settings" />
			<EmptyState icon={Construction} title="作成中" body="この画面は作り直しの途中です。" />
		</Screen>
	);
}
