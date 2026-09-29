// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { Animated, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { MessageSquare } from 'lucide-react-native';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useWindowControlsInset } from '../src/ipad/windowControls.js';
import { useParaToast } from '../src/paraToast.js';
import { ensureNotificationPermission } from '../src/platform.js';
import { colors, radius, space, type } from '../src/theme.js';
import { Button, Icon, Screen } from '../src/ui/index.js';
import { leaveToHome } from '../src/features/pairing/leaveSetup.js';
import { LogoTile, ParaLogo } from '../src/features/pairing/paraLogo.js';
import { NotificationPreview } from '../src/features/settings/notificationPreview.js';
import { parseOnboardingSteps, type OnboardingStep, type SessionView } from '../src/features/settings/onboardingPlan.js';
import { loadOnboardingSteps, markNotificationsAnswered, useSessionViewPreference } from '../src/features/settings/onboardingStore.js';

/** ページを送る動きの長さ（ms。Orca の SLIDE_DURATION_MS）。 */
const SLIDE_MS = 280;
/** 本文と操作の最大幅（pt。Orca の 420）。 */
const CONTENT_MAX_WIDTH = 420;

type Choice = SessionView | 'enable' | 'skip';

/**
 * はじめて（`/onboarding`。Orca の mobile-onboarding と MobileOnboardingPage）。
 * ペアリングが成立した直後に、まだ決めていないことだけを1ページずつ聞く（`onboardingPlan.ts`）:
 *  1. セッションの開き方（チャット UI かターミナルか）
 *  2. 通知の許可
 *
 * どのページも選ぶまで先へ進めない（戻る・横のスワイプでは飛ばせない。Orca と同じ）。
 * 全部答えたらホームへ戻る。`?steps=session-view,notifications` で聞くことを指定して開ける（確認用）。
 */
export default function OnboardingScreen() {
	const router = useRouter();
	const params = useLocalSearchParams<{ steps?: string | string[] }>();
	const requested = parseOnboardingSteps(params.steps);
	const [loaded, setLoaded] = useState<OnboardingStep[] | undefined>(undefined);
	const steps = requested ?? loaded;
	const hasRequest = requested !== undefined;

	// 開いたときに1回だけ決める（答えるたびに聞くことを減らすと、ページ送りの途中で並びが変わる）
	useEffect(() => {
		if (hasRequest) {
			return;
		}
		let cancelled = false;
		void loadOnboardingSteps().catch(() => []).then(next => {
			if (cancelled) {
				return;
			}
			if (next.length === 0) {
				leaveToHome(router);
				return;
			}
			setLoaded(next);
		});
		return () => { cancelled = true; };
	}, [hasRequest, router]);

	return (
		<Screen>
			{/* 選ぶまで先へ進めないので、左端からのスワイプで戻らせない */}
			<Stack.Screen options={{ gestureEnabled: false }} />
			{steps !== undefined ? <OnboardingFlow steps={steps} onDone={() => leaveToHome(router)} /> : null}
		</Screen>
	);
}

function OnboardingFlow({ steps, onDone }: { steps: readonly OnboardingStep[]; onDone: () => void }) {
	const insets = useStableInsets();
	// iPad のウィンドウアプリでは左上に操作ボタンが出る。見出しはその右から始める。
	const controlsInset = useWindowControlsInset();
	const saveSessionView = useSessionViewPreference(s => s.save);
	const [width, setWidth] = useState(0);
	const [index, setIndex] = useState(0);
	const [busy, setBusy] = useState<Choice | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	// 状態の更新は同期で両方のボタンを塞がないので、連打で2回進まないよう ref でも止める
	const inFlight = useRef(false);
	const slide = useRef(new Animated.Value(0)).current;

	const onLayout = (event: LayoutChangeEvent) => {
		const next = Math.round(event.nativeEvent.layout.width);
		setWidth(current => (current === next ? current : next));
	};

	const advance = () => {
		const next = index + 1;
		if (next >= steps.length) {
			onDone();
			return;
		}
		setIndex(next);
		Animated.timing(slide, { toValue: next, duration: SLIDE_MS, useNativeDriver: true }).start(() => {
			setBusy(undefined);
			inFlight.current = false;
		});
	};

	const run = async (choice: Choice, action: () => Promise<void>, failure: string) => {
		if (inFlight.current) {
			return;
		}
		inFlight.current = true;
		setBusy(choice);
		setError(undefined);
		try {
			await action();
			advance();
		} catch {
			setError(failure);
			setBusy(undefined);
			inFlight.current = false;
		}
	};

	const chooseSessionView = (view: SessionView) => {
		void run(view, () => saveSessionView(view), '選んだ内容を保存できませんでした。もう一度お試しください。');
	};

	const chooseNotifications = (choice: 'enable' | 'skip') => {
		void run(choice, async () => {
			const granted = choice === 'enable' ? await ensureNotificationPermission() : false;
			await markNotificationsAnswered();
			useParaToast.getState().show({
				key: 'onboarding-notifications',
				text: granted ? '通知を有効にしました' : 'あとで設定から有効にできます',
				icon: granted ? 'notifications-outline' : 'information-circle-outline',
				tone: 'info',
			}, 2_500);
		}, '通知の設定を変えられませんでした。もう一度お試しください。');
	};

	const translateX = Animated.multiply(slide, -width);

	return (
		<View style={[styles.flow, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
			<View style={[styles.brand, controlsInset > 0 ? { paddingLeft: space.xl + controlsInset } : undefined]}>
				<ParaLogo size={18} />
				<Text style={styles.brandName}>Para Code</Text>
				{steps.length > 1 ? (
					<View
						style={styles.progress}
						accessible
						accessibilityRole="progressbar"
						accessibilityLabel="はじめての設定の進み具合"
						accessibilityValue={{ text: `${steps.length} ページ中 ${index + 1} ページ目` }}
					>
						{steps.map((step, i) => <View key={step} style={[styles.dot, i === index ? styles.dotOn : undefined]} />)}
					</View>
				) : null}
			</View>
			<View style={styles.viewport} onLayout={onLayout}>
				{width > 0 ? (
					<Animated.View style={[styles.track, { width: width * steps.length, transform: [{ translateX }] }]}>
						{steps.map((step, i) => (
							<ScrollView
								key={step}
								style={{ width }}
								contentContainerStyle={styles.page}
								showsVerticalScrollIndicator={false}
								accessibilityElementsHidden={i !== index}
								importantForAccessibility={i === index ? 'auto' : 'no-hide-descendants'}
							>
								{step === 'session-view' ? (
									<>
										<View style={styles.content}>
											<LogoTile><Icon icon={MessageSquare} size={30} color={colors.text} /></LogoTile>
											<Text style={[styles.title, styles.titleAfterIcon]}>セッションをどう開きますか？</Text>
											<Text style={styles.body}>対応しているエージェントのセッションを、この端末ではターミナルで開くか、チャット UI で開くかを選びます。セッションのタブを長押しすると表示を切り替えられ、既定はあとから設定で変えられます。</Text>
										</View>
										<View style={styles.footer}>
											{error !== undefined && i === index ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
											<Button label="チャット UI を使う" onPress={() => chooseSessionView('chat')} loading={busy === 'chat'} disabled={busy !== undefined} accessibilityLabel="セッションをチャット UI で開く" />
											<Button label="ターミナルのままにする" variant="outline" onPress={() => chooseSessionView('terminal')} loading={busy === 'terminal'} disabled={busy !== undefined} accessibilityLabel="セッションをターミナルで開く" style={styles.second} />
										</View>
									</>
								) : (
									<>
										<View style={[styles.content, styles.contentTop]}>
											<NotificationPreview />
											<Text style={styles.title}>{'エージェントに呼ばれたら\n見逃さない'}</Text>
											<Text style={styles.body}>エージェントが作業を終えたときや、あなたの返事を待っているときに、このスマホに通知します。アプリを開いていなくても届きます。</Text>
										</View>
										<View style={styles.footer}>
											<Text style={styles.disclosure}>PC の Para Code からプッシュ通知で届きます。PC を操作している間は鳴らさないなど、設定からいつでも変えられます。</Text>
											{error !== undefined && i === index ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
											<Button label="通知を有効にする" onPress={() => chooseNotifications('enable')} loading={busy === 'enable'} disabled={busy !== undefined} accessibilityLabel="エージェントの通知を有効にする" />
											<Button label="あとで" variant="outline" onPress={() => chooseNotifications('skip')} loading={busy === 'skip'} disabled={busy !== undefined} accessibilityLabel="通知はあとで設定する" style={styles.second} />
										</View>
									</>
								)}
							</ScrollView>
						))}
					</Animated.View>
				) : null}
			</View>
		</View>
	);
}

/** 進捗の点（pt。モックの `.oprog i`: 7×7、選択中は幅 22）。 */
const DOT = 7;
const DOT_ACTIVE = 22;

const styles = StyleSheet.create({
	flow: {
		flex: 1,
	},
	brand: {
		minHeight: 52,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingHorizontal: space.xl,
	},
	brandName: {
		fontSize: type.title,
		fontWeight: '700',
		color: colors.text,
	},
	progress: {
		position: 'absolute',
		left: '50%',
		flexDirection: 'row',
		alignItems: 'center',
		gap: DOT,
		transform: [{ translateX: -((DOT_ACTIVE + DOT * 3) / 2) }],
	},
	dot: {
		width: DOT,
		height: DOT,
		borderRadius: radius.pill,
		backgroundColor: colors.border,
	},
	dotOn: {
		width: DOT_ACTIVE,
		backgroundColor: colors.text,
	},
	viewport: {
		flex: 1,
		overflow: 'hidden',
	},
	track: {
		height: '100%',
		flexDirection: 'row',
	},
	page: {
		flexGrow: 1,
		paddingHorizontal: space.xl,
	},
	content: {
		flexGrow: 1,
		alignItems: 'center',
		justifyContent: 'center',
		paddingTop: space.lg,
		paddingBottom: space.md,
	},
	contentTop: {
		justifyContent: 'flex-start',
		paddingTop: space.xl,
	},
	title: {
		maxWidth: CONTENT_MAX_WIDTH,
		fontSize: type.hero,
		fontWeight: '700',
		letterSpacing: -0.3,
		lineHeight: 32,
		color: colors.text,
		textAlign: 'center',
	},
	titleAfterIcon: {
		marginTop: space.xl,
	},
	body: {
		maxWidth: CONTENT_MAX_WIDTH,
		fontSize: type.body,
		lineHeight: 21,
		color: colors.textDim,
		textAlign: 'center',
		marginTop: space.md,
	},
	footer: {
		width: '100%',
		maxWidth: CONTENT_MAX_WIDTH,
		alignSelf: 'center',
		paddingBottom: space.lg,
	},
	disclosure: {
		fontSize: type.meta,
		lineHeight: 18,
		color: colors.textDim,
		textAlign: 'center',
		marginBottom: space.lg,
	},
	error: {
		fontSize: type.meta,
		lineHeight: 18,
		color: colors.red,
		textAlign: 'center',
		marginBottom: space.sm,
	},
	second: {
		marginTop: space.sm,
	},
});
