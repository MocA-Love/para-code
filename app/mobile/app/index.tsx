// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { PairingEmptyState, usePairingRequired } from '../src/features/pairing/pairingEmptyState.js';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { unreadQuestionNotificationCount } from '../src/components/notificationCount.js';
import { AccountUsageCard, HomeEmptyState, HomeTopBar, QuickActions, ResumeCard, StatCards } from '../src/features/home/homeParts.js';
import { batteryLine, formatCost, pcCardCounts, pcConnectionLine, runningAgents, totalAttention } from '../src/features/home/homeSummary.js';
import { lastSessionSubtitle } from '../src/features/home/lastSession.js';
import { useLastSession } from '../src/features/home/lastSessionStore.js';
import { PcActions } from '../src/features/home/pcActions.js';
import { PcCard } from '../src/features/home/pcCard.js';
import { useHomeUsage } from '../src/features/home/useHomeUsage.js';
import { LaunchDrawer } from '../src/features/launch/launchDrawer.js';
import { openSession } from '../src/features/pc/openSession.js';
import { startStatusSinceTracking } from '../src/features/pc/statusSinceStore.js';
import { hapticSelection } from '../src/haptics.js';
import { useContentColumnStyle } from '../src/ipad/useContentColumn.js';
import { shouldShowBattery } from '../src/pcStatus.js';
import { routes } from '../src/routes.js';
import { colors, space, type } from '../src/theme.js';
import { useNow } from '../src/time.js';
import { Screen, SectionHeader, connectionKind } from '../src/ui/index.js';

// 行の経過時間の元（状態が変わった時刻）を、どの画面を見ていても取りこぼさないように早めに見張り始める。
startStatusSinceTracking();

/**
 * ホーム（`/`。Orca の MobileHomeScreen、モックの「ホーム」）。
 *
 * 上から: 上端の帯（ロゴ・通知のベル・設定）→「おかえりなさい」→ 統計カード3枚 →「デスクトップ」の
 * PC のカード → 「再開」（最後に開いたセッション）→ クイック操作 → アカウントの使用量。
 * PC が1台も無いときは「デスクトップをつなぐ」の空の状態だけを出す。
 *
 * 統計カードの中身は、PC 側に起動回数などの集計が無いので「要対応・実行中・今日のコスト」で代えている
 * （理由は `src/features/home/homeSummary.ts`）。
 */
export default function HomeScreen() {
	const router = useRouter();
	const { ready, pcs, activePcId, archivedKeys, notifications } = useAppStore(useShallow(s => ({
		ready: s.ready, pcs: s.pcs, activePcId: s.activePcId, archivedKeys: s.archivedKeys, notifications: s.notifications,
	})));
	// **`s.workspace` 本体は購読しない**（PC からの再送のたびに作り直される）。ターミナルの並びは
	// 中身が同じなら参照が据え置かれる（workspaceIdentity.ts）。
	const terminals = useAppStore(s => s.workspace?.terminals);
	const lastSession = useLastSession(s => s.value);
	const loadLastSession = useLastSession(s => s.load);
	const usage = useHomeUsage();
	const now = useNow();
	const column = useContentColumnStyle();
	const [menuPcId, setMenuPcId] = useState<string | undefined>(undefined);
	const [launching, setLaunching] = useState(false);

	useEffect(() => {
		loadLastSession();
	}, [loadLastSession]);

	const unread = unreadQuestionNotificationCount(notifications);
	// ペアリングが無い（切れた）ときは、PC の一覧があってもペアリングの案内を出す（旧来のホームと接続ガードの代わり）。
	const pairingRequired = usePairingRequired();
	const empty = (ready && pcs.length === 0) || pairingRequired;
	const activePc = pcs.find(pc => pc.id === activePcId);
	const activeConnected = activePc !== undefined && connectionKind(activePc.connection, activePc.pcOnline) === 'connected';
	const resumePc = lastSession !== undefined ? pcs.find(pc => pc.id === lastSession.pcId) : undefined;

	return (
		<Screen>
			<HomeTopBar
				unread={unread}
				showBell={!empty}
				onNotifications={() => { hapticSelection(); router.push(routes.notifications()); }}
				onSettings={() => { hapticSelection(); router.push(routes.settings()); }}
			/>
			{empty ? (
				pairingRequired ? <PairingEmptyState /> : <HomeEmptyState onPair={() => { hapticSelection(); router.push(routes.pair()); }} />
			) : (
				<ScrollView contentContainerStyle={[styles.content, column]}>
					<Text style={styles.hero} accessibilityRole="header">おかえりなさい</Text>
					<StatCards
						items={[
							{ label: '要対応', value: String(totalAttention(pcs)) },
							{ label: '実行中', value: String(runningAgents(terminals, archivedKeys)) },
							{ label: '今日のコスト', value: formatCost(usage.cost) },
						]}
					/>
					<SectionHeader title="デスクトップ" />
					{pcs.map(pc => {
						const kind = connectionKind(pc.connection, pc.pcOnline);
						return (
							<PcCard
								key={pc.id}
								id={pc.id}
								name={pc.name}
								kind={kind}
								connectionText={pcConnectionLine(kind, pc.lastOnlineAt, now)}
								detail={shouldShowBattery(pc) && pc.battery !== undefined ? batteryLine(pc.battery) : undefined}
								// 見ていない PC のターミナルは届かないので、件数は台帳の要約から出す。
								counts={pcCardCounts(pc, pc.id === activePcId ? terminals : undefined, archivedKeys)}
								onOpen={id => router.push(routes.pc(id))}
								onMenu={setMenuPcId}
							/>
						);
					})}
					{lastSession !== undefined && resumePc !== undefined ? (
						<View>
							<SectionHeader title="再開" style={styles.gapSmall} />
							<ResumeCard
								title={lastSession.title}
								subtitle={lastSessionSubtitle(lastSession)}
								dotColor={lastSession.color}
								onPress={() => openSession(router, lastSession)}
							/>
						</View>
					) : null}
					<SectionHeader title="クイック操作" style={styles.gapLarge} />
					<QuickActions
						onPair={() => { hapticSelection(); router.push(routes.pair()); }}
						onNewSpace={() => { hapticSelection(); setLaunching(true); }}
						newSpaceDisabled={!activeConnected}
					/>
					<SectionHeader title="アカウントの使用量" style={styles.gapLarge} />
					<AccountUsageCard limits={usage.limits} onPress={() => { hapticSelection(); router.push(routes.settings('usage')); }} />
				</ScrollView>
			)}
			<PcActions pcId={menuPcId} onClose={() => setMenuPcId(undefined)} />
			<LaunchDrawer visible={launching} preset={NEW_SPACE_PRESET} onClose={() => setLaunching(false)} />
		</Screen>
	);
}

/** ホームの「新しいスペース」は、いま見ている PC に新しいスペースを作る形でシートを開く。 */
const NEW_SPACE_PRESET = { kind: 'newSpace' } as const;

/** 一覧の下の余白（モックの `.hlist` の 58）。 */
const BOTTOM_GAP = 58;

const styles = StyleSheet.create({
	content: {
		paddingHorizontal: space.lg,
		paddingBottom: BOTTOM_GAP,
	},
	hero: {
		paddingTop: space.xs,
		paddingBottom: space.md,
		fontSize: type.hero,
		fontWeight: '800',
		letterSpacing: -0.3,
		color: colors.text,
	},
	gapSmall: {
		marginTop: space.sm,
	},
	gapLarge: {
		marginTop: space.xl,
	},
});
