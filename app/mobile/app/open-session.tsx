// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { createAgentLatestEntryToken } from '../src/agentNavigation.js';
import { useAppStore } from '../src/appState.js';
import { openSessionTarget, type OpenSessionTarget } from '../src/features/links/openSessionTarget.js';
import { firstParam, routes } from '../src/routes.js';
import { colors } from '../src/theme.js';
import { Screen } from '../src/ui/index.js';

/** PC の状態を待つ上限。過ぎたらホームへ（オフラインのまま開かれたときに止まらないように）。 */
const WAIT_LIMIT_MS = 8_000;

/**
 * 中継の画面（`/open-session?latest=…`）。Live Activity の旧 URL（`paracode-mobile:///agent`）は
 * `app/+native-intent.tsx` がここへ書き換える。台帳と PC の状態が揃うのを待って、要対応のエージェントの
 * セッション（無ければホーム）へ**置き換える**ので、戻る履歴には残らない（下はホーム）。
 *
 * `latest`（会話を最新まで送る一度限りの印）は旧 `/agent` のクエリの意味のまま引き継ぐ。付いていなければ
 * 通知のタップと同じく新しく作る。
 */
export default function OpenSessionScreen() {
	const router = useRouter();
	const params = useLocalSearchParams<{ latest?: string | string[] }>();
	const latest = firstParam(params.latest);
	// 行き先だけを購読する（workspace 本体を購読すると PC の再送のたびに描き直す）。
	const target = useAppStore(useShallow((s): OpenSessionTarget => openSessionTarget({
		ready: s.ready,
		pcCount: s.pcs.length,
		activePcId: s.activePcId,
		workspace: s.workspace,
	})));
	const doneRef = useRef(false);

	useEffect(() => {
		if (doneRef.current || target.kind === 'wait') {
			return;
		}
		doneRef.current = true;
		switch (target.kind) {
			case 'home':
				router.replace(routes.home());
				return;
			case 'pc':
				router.replace(routes.pc(target.pcId));
				return;
			case 'session': {
				// 旧来の部品やストアの操作が既定の対象にしている選択も合わせる（通知のタップと同じ）。
				// setSelectedWs は selectedTerminalKey を戻すので、この順を守る。
				const store = useAppStore.getState();
				store.setSelectedWs(target.spaceId);
				store.setSelectedTerminalKey(target.terminalKey);
				// withAnchor: PC の中の Stack の根（1列では PC の画面、2列では「エージェントが開かれていません」）を下に敷く。
				router.replace(routes.session(target.pcId, target.spaceId, {
					tab: { kind: 'terminal', terminalKey: target.terminalKey },
					latest: latest ?? createAgentLatestEntryToken(),
				}), { withAnchor: true });
				return;
			}
		}
	}, [target, latest, router]);

	useEffect(() => {
		const timer = setTimeout(() => {
			if (!doneRef.current) {
				doneRef.current = true;
				router.replace(routes.home());
			}
		}, WAIT_LIMIT_MS);
		return () => clearTimeout(timer);
	}, [router]);

	return (
		<Screen>
			<View style={styles.center} accessibilityLabel="セッションを開いています">
				<ActivityIndicator color={colors.textDim} />
			</View>
		</Screen>
	);
}

const styles = StyleSheet.create({
	center: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
	},
});
