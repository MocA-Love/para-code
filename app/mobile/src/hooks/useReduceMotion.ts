// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * 端末の「視差効果を減らす」（Android は「アニメーションを削除」）が有効か。設定を途中で変えても追いつく。
 * 回り続ける・跳ねるような飾りの動きは、これが真のときは止める。
 */
export function useReduceMotion(): boolean {
	const [reduceMotion, setReduceMotion] = useState(false);
	useEffect(() => {
		let mounted = true;
		void AccessibilityInfo.isReduceMotionEnabled().then(enabled => {
			if (mounted) {
				setReduceMotion(enabled);
			}
		});
		const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
		return () => {
			mounted = false;
			subscription.remove();
		};
	}, []);
	return reduceMotion;
}
