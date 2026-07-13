// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { shouldRunForegroundWork } from '../appLifecycle.js';

/** バックグラウンド中の画面用タイマー・ループアニメーションを確実に止めるための共有状態。 */
export function useAppIsActive(): boolean {
	const [active, setActive] = useState(() => shouldRunForegroundWork(AppState.currentState));
	useEffect(() => {
		const subscription = AppState.addEventListener('change', state => setActive(shouldRunForegroundWork(state)));
		return () => subscription.remove();
	}, []);
	return active;
}
