// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { useNavigationContainerRef, useRouter } from 'expo-router';
import { BellOff } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import type { NotifyPayload } from '@para/protocol';
import { createAgentLatestEntryToken } from '../src/agentNavigation.js';
import { useAppStore } from '../src/appState.js';
import { haptic } from '../src/haptics.js';
import { useParaToast } from '../src/paraToast.js';
import { useNow } from '../src/time.js';
import { Button, ConfirmDrawer, EmptyState, ListGroup } from '../src/ui/index.js';
import { GroupNote, SettingsScreen } from '../src/features/settings/settingsScaffold.js';
import { NotificationRow } from '../src/features/notifications/notificationRow.js';
import { notificationTarget } from '../src/features/notifications/notificationListModel.js';
import { openPcRoute } from '../src/features/pc/openPcRoute.js';

/**
 * 通知の一覧（`/notifications`。Orca に無い画面で、モックでは設定の部品で組んでいる）。
 *
 * この一覧に「既読」という状態は無い: 押して開いたもの・消したものは一覧から消え、PC と他の端末の
 * 一覧からも消える（`dismissNotification` / `clearNotifications`）。そのためモックの「すべて既読」は
 * 「すべて消す」にしている（取り消せないので一度確かめる）。
 *
 * 押したときの行き先は OS の通知のタップと同じ（`notificationDestination`）。この画面を閉じて行き先を開くので、
 * 戻ると一覧ではなく、この画面の下にあった画面へ戻る。下が PC の画面なら、その中で開く（`openPcRoute`。
 * 同じ PC の器は増やさない）。
 */
export default function NotificationsScreen() {
	const router = useRouter();
	const container = useNavigationContainerRef();
	const now = useNow();
	// workspace 本体は購読しない（PC からの再送で最大 10Hz 描き直すため）。押したときにだけ読む。
	const { notifications, setSelectedWs, setSelectedTerminalKey, clearNotifications, dismissNotification } = useAppStore(useShallow(s => ({
		notifications: s.notifications,
		setSelectedWs: s.setSelectedWs,
		setSelectedTerminalKey: s.setSelectedTerminalKey,
		clearNotifications: s.clearNotifications,
		dismissNotification: s.dismissNotification,
	})));
	const [confirming, setConfirming] = useState(false);

	const open = (notification: NotifyPayload) => {
		haptic('move');
		const { workspace, activePcId } = useAppStore.getState();
		const target = notificationTarget(notification, workspace, activePcId, createAgentLatestEntryToken());
		switch (target.kind) {
			case 'session':
				// 行き先を確かめられてから既読にする（状態が揃う前に有効な通知を消さない）。
				dismissNotification(notification.id);
				// setSelectedWs は selectedTerminalKey を戻すので、この順を守る
				if (target.spaceId !== undefined) {
					setSelectedWs(target.spaceId);
				}
				setSelectedTerminalKey(target.terminalKey);
				openPcRoute(router, container, target.href, 'overlay');
				return;
			case 'pc':
				dismissNotification(notification.id);
				openPcRoute(router, container, target.href, 'overlay');
				return;
			case 'wait':
				useParaToast.getState().show({ key: 'notification-wait', text: 'PC から状態を受け取っています。少し待ってから開いてください', icon: 'time-outline', tone: 'info' }, 2_500);
				return;
			case 'missing':
				useParaToast.getState().show({ key: 'notification-missing', text: 'このエージェントはもう見つかりません', icon: 'alert-circle-outline', tone: 'warn' }, 2_500);
				return;
		}
	};

	return (
		<SettingsScreen
			title="通知"
			right={notifications.length > 0 ? (
				<Button label="すべて消す" variant="ghost" size="sm" onPress={() => { haptic('move'); setConfirming(true); }} />
			) : undefined}
			footer={(
				<ConfirmDrawer
					visible={confirming}
					title="通知をすべて消しますか？"
					message={`${notifications.length} 件の通知を消します。PC とほかの端末の一覧からも消え、取り消せません（まだ答えていない許可と質問は、PC とほかの端末では残ります）。`}
					confirmLabel="すべて消す"
					onConfirm={clearNotifications}
					onClose={() => setConfirming(false)}
				/>
			)}
		>
			{notifications.length === 0 ? (
				<EmptyState icon={BellOff} title="通知はありません" body="エージェントが作業を終えたときや、返事を待っているときにここへ届きます。" />
			) : (
				<>
					<ListGroup>
						{notifications.map(notification => (
							<NotificationRow key={notification.id} notification={notification} now={now} onPress={() => open(notification)} />
						))}
					</ListGroup>
					<GroupNote after>通知を押すと、そのエージェントの会話か、その PC の画面を開きます。</GroupNote>
				</>
			)}
		</SettingsScreen>
	);
}
