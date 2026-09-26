// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Construction } from 'lucide-react-native';
import { EmptyState, Screen, ScreenHeader } from '../../src/ui/index.js';

/**
 * 使用量（`/settings/usage`）。**段階2の仮の画面**で、段階6の担当が Orca の accounts（モックの「使用量」）に合わせて作り直す。
 */
export default function UsageScreen() {
	return (
		<Screen>
			<ScreenHeader title="使用量" variant="settings" />
			<EmptyState icon={Construction} title="作成中" body="この画面は作り直しの途中です。" />
		</Screen>
	);
}
