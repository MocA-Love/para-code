// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useNavigationContainerRef, useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { createAgentLatestEntryToken } from '../src/agentNavigation.js';
import { useAppStore } from '../src/appState.js';
import { openSessionTarget, type OpenSessionTarget } from '../src/features/links/openSessionTarget.js';
import { isPcPath } from '../src/features/links/runningPcLink.js';
import { openPcRoute } from '../src/features/pc/openPcRoute.js';
import { firstParam, routes } from '../src/routes.js';
import { colors } from '../src/theme.js';
import { Screen } from '../src/ui/index.js';

/** PC の状態を待つ上限。過ぎたらホームへ（オフラインのまま開かれたときに止まらないように）。 */
const WAIT_LIMIT_MS = 8_000;

/**
 * 中継の画面（`/open-session?latest=…`）。Live Activity の旧 URL（`paracode-mobile:///agent`）は
 * `app/+native-intent.tsx` がここへ書き換える。台帳と PC の状態が揃うのを待って、要対応のエージェントの
 * セッション（無ければホーム）を開く。この画面は閉じるか行き先に置き換えるので、戻る履歴には残らない。
 * この画面の下が PC の画面なら、その中で開く（同じ PC の器は増やさない。規則は `src/features/pc/pcOpenPlan.ts`）。
 *
 * `latest`（会話を最新まで送る一度限りの印）は旧 `/agent` のクエリの意味のまま引き継ぐ。付いていなければ
 * 通知のタップと同じく新しく作る。
 *
 * `to`（PC の中の画面のパス）が付いていれば、待たずにそこを開く。アプリが起動している間に届いた
 * PC の中の画面へのリンクを、`app/+native-intent.tsx` がここ経由に書き換えたもの（`runningPcLink.ts`）。
 */
export default function OpenSessionScreen() {
	const router = useRouter();
	const container = useNavigationContainerRef();
	const params = useLocalSearchParams<{ latest?: string | string[]; to?: string | string[] }>();
	const latest = firstParam(params.latest);
	const relayTarget = firstParam(params.to);
	// 行き先だけを購読する（workspace 本体を購読すると PC の再送のたびに描き直す）。
	const target = useAppStore(useShallow((s): OpenSessionTarget => openSessionTarget({
		ready: s.ready,
		pcCount: s.pcs.length,
		activePcId: s.activePcId,
		workspace: s.workspace,
	})));
	const doneRef = useRef(false);

	useEffect(() => {
		if (doneRef.current || relayTarget === undefined) {
			return;
		}
		doneRef.current = true;
		if (isPcPath(relayTarget)) {
			// この画面の下が PC の画面ならその中で開き、同じ画面が出ていれば閉じるだけ（`openPcRoute`）。
			openPcRoute(router, container, relayTarget, 'overlay');
		} else {
			router.replace(routes.home());
		}
	}, [relayTarget, router, container]);

	useEffect(() => {
		if (doneRef.current || relayTarget !== undefined || target.kind === 'wait') {
			return;
		}
		doneRef.current = true;
		switch (target.kind) {
			case 'home':
				router.replace(routes.home());
				return;
			case 'pc':
				openPcRoute(router, container, routes.pc(target.pcId), 'overlay');
				return;
			case 'session': {
				// 旧来の部品やストアの操作が既定の対象にしている選択も合わせる（通知のタップと同じ）。
				// setSelectedWs は selectedTerminalKey を戻すので、この順を守る。
				const store = useAppStore.getState();
				store.setSelectedWs(target.spaceId);
				store.setSelectedTerminalKey(target.terminalKey);
				openPcRoute(router, container, routes.session(target.pcId, target.spaceId, {
					tab: { kind: 'terminal', terminalKey: target.terminalKey },
					latest: latest ?? createAgentLatestEntryToken(),
				}), 'overlay');
				return;
			}
		}
	}, [target, latest, relayTarget, router, container]);

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
