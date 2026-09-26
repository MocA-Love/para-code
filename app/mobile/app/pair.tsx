// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Construction } from 'lucide-react-native';
import { EmptyState, Screen, ScreenHeader } from '../src/ui/index.js';

/**
 * ペアリング（`/pair`）。**段階2の仮の画面**で、段階6の担当が Orca の pair-scan に合わせて作り直す
 * （旧画面は `legacy-screens/pair.tsx`。QR の読み取り・URI の貼り付け・確認コードの処理はそこにある）。
 */
export default function PairScreen() {
	return (
		<Screen>
			<ScreenHeader title="PC をペアリング" />
			<EmptyState icon={Construction} title="作成中" body="この画面は作り直しの途中です。" />
		</Screen>
	);
}
