// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Construction } from 'lucide-react-native';
import { EmptyState, Screen, ScreenHeader } from '../src/ui/index.js';

/**
 * はじめて起動したときの案内（`/onboarding`）。**段階2の仮の画面**で、段階6の担当が Orca の onboarding に合わせて作り直す。
 */
export default function OnboardingScreen() {
	return (
		<Screen>
			<ScreenHeader title="はじめに" />
			<EmptyState icon={Construction} title="作成中" body="この画面は作り直しの途中です。" />
		</Screen>
	);
}
