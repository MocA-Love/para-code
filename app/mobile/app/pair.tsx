// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCameraPermissions } from 'expo-camera';
import { Clipboard, QrCode } from 'lucide-react-native';
import { useAppStore } from '../src/appState.js';
import { hapticSelection } from '../src/haptics.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { hitSlopToMinimum } from '../src/components/hitSlop.js';
import { colors, space, type } from '../src/theme.js';
import { Button, Icon, Screen, ScreenHeader, TextInputDrawer } from '../src/ui/index.js';
import { continueAfterPairing, leaveToHome } from '../src/features/pairing/leaveSetup.js';
import { LogoTile, ParaLogo } from '../src/features/pairing/paraLogo.js';
import { PairScanner, PairScannerPlaceholder, PairStep } from '../src/features/pairing/pairScanner.js';
import { extractPairingUri, formatSasCode, pairingUriFromLinkParam } from '../src/features/pairing/pairingInput.js';
import { usePairingFlow } from '../src/features/pairing/usePairingFlow.js';

/** 読み取った・貼り付けたものが Para Code のペアリング用でなかったとき。 */
const NOT_A_PAIRING_CODE = 'Para Code のペアリング用のコードではありません。PC に表示された QR コードかリンクを使ってください。';
/** 本文の最大幅（pt）。iPad で1行が伸びきらないようにするためだけの値（Orca の pair-confirm と同じ）。 */
const TEXT_MAX_WIDTH = 420;
/** 操作のボタンの列の最大幅（pt。Orca の actionStack）。 */
const ACTIONS_MAX_WIDTH = 360;

/**
 * ペアリング（`/pair`。Orca の pair-scan と pair-confirm）。
 *
 *  - 読み取り: 手順・カメラ（四隅の目印）・「リンクを貼り付ける」。カメラの許可がまだなら先に説明して許可をもらう
 *  - リンクから開いた（`paracode-mobile://pair?d=…` → `/pair?d=…`）: 「このデスクトップとペアリングしますか？」で確かめてから始める
 *  - 接続中 → 確認コード（6桁）を出して PC の承認を待つ。キャンセルでいつでも中断できる
 *  - 成立したら、まだ聞いていないこと（開き方・通知）があれば「はじめて」へ、無ければホームへ
 *
 * ペアリングの処理は既存の `pairFromUri`（`src/appState.ts`）で、画面を離れると中断する（`usePairingFlow`）。
 *
 * PC 側は「Para Code: モバイルデバイスを接続」で QR コードとリンクを出す。シミュレータにはカメラが
 * 無いので、リンクの貼り付けで試す。
 */
export default function PairScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const params = useLocalSearchParams<{ d?: string | string[] }>();
	const linkUri = pairingUriFromLinkParam(params.d);
	const ready = useAppStore(s => s.ready);
	const [permission, requestPermission] = useCameraPermissions();
	const [pasteOpen, setPasteOpen] = useState(false);
	// リンクから開いたときの確認を、始めた・断った後は出さない。
	const [linkHandled, setLinkHandled] = useState(false);
	// カメラは同じ QR を何度も読むので、1回目で止める（状態の更新が描画に届くまでの間の分も）。
	const scanLock = useRef(false);

	const onPaired = useCallback(() => { void continueAfterPairing(router); }, [router]);
	const flow = usePairingFlow(onPaired);

	const startWith = (text: string) => {
		const uri = extractPairingUri(text);
		if (uri === undefined) {
			flow.fail(NOT_A_PAIRING_CODE);
			return;
		}
		flow.start(uri);
	};
	const onScanned = (data: string) => {
		if (scanLock.current) {
			return;
		}
		scanLock.current = true;
		hapticSelection();
		startWith(data);
	};
	const backToScan = () => {
		scanLock.current = false;
		flow.reset();
	};
	const cancel = () => {
		scanLock.current = false;
		flow.cancel();
	};

	const phase = flow.phase;
	const confirmingLink = linkUri !== undefined && !linkHandled && phase.kind === 'idle';

	return (
		<Screen>
			<ScreenHeader title="デスクトップとペアリング" />
			<View style={[styles.body, { paddingBottom: insets.bottom + space.sm }]}>
				{confirmingLink ? (
					<Centered>
						<Text style={styles.title}>このデスクトップとペアリングしますか？</Text>
						<Text style={styles.subtitle}>PC の Para Code から開いたペアリングのリンクです。ペアリングすると、この端末の PC の一覧に加わります。</Text>
						<View style={styles.actions}>
							<Button label="ペアリング" onPress={() => { setLinkHandled(true); flow.start(linkUri); }} disabled={!ready} />
							<Button label="キャンセル" variant="ghost" onPress={() => { setLinkHandled(true); leaveToHome(router); }} />
						</View>
					</Centered>
				) : phase.kind === 'connecting' ? (
					<Centered>
						<ActivityIndicator size="large" color={colors.textDim} />
						<Text style={styles.connecting}>接続しています…</Text>
						<View style={styles.actions}>
							<Button label="キャンセル" variant="ghost" onPress={cancel} />
						</View>
					</Centered>
				) : phase.kind === 'sas' ? (
					<Centered>
						<LogoTile><ParaLogo size={34} /></LogoTile>
						<Text style={[styles.title, styles.sasTitle]}>確認コードを照らし合わせる</Text>
						<Text style={styles.subtitle}>PC に表示されている 6 桁と同じか確かめてください。</Text>
						<Text style={styles.sas} accessibilityLabel={`確認コード ${phase.code.split('').join(' ')}`}>{formatSasCode(phase.code)}</Text>
						<Text style={styles.subtitle}>同じなら、PC で「接続を承認」を押すと完了します。通信は端末どうしで暗号化されます。</Text>
						<View style={styles.actions}>
							<Button label="キャンセル" variant="outline" onPress={cancel} />
						</View>
					</Centered>
				) : phase.kind === 'error' ? (
					<Centered>
						<Text style={styles.error} accessibilityRole="alert">{phase.message}</Text>
						<View style={styles.actions}>
							<Button label="もう一度読み取る" onPress={backToScan} />
							<Button label="リンクを貼り付ける" variant="ghost" onPress={() => { backToScan(); setPasteOpen(true); }} />
						</View>
					</Centered>
				) : permission === null ? (
					<Centered><ActivityIndicator color={colors.textDim} /></Centered>
				) : !permission.granted ? (
					<Centered>
						<Text style={styles.title}>{permission.canAskAgain ? 'デスクトップとペアリング' : 'カメラへのアクセスがオフです'}</Text>
						<Text style={styles.subtitle}>
							{permission.canAskAgain
								? 'PC の Para Code に出した QR コードを読み取ります。リンクを貼り付けてもつなげます。'
								: '設定でカメラへのアクセスを許可するか、リンクを貼り付けてつないでください。'}
						</Text>
						<View style={styles.actions}>
							<Button
								label={permission.canAskAgain ? '続ける' : '設定を開く'}
								icon={permission.canAskAgain ? QrCode : undefined}
								onPress={() => {
									if (permission.canAskAgain) {
										void requestPermission();
									} else {
										void Linking.openSettings();
									}
								}}
							/>
						</View>
						<PasteLink onPress={() => setPasteOpen(true)} label="リンクを貼り付ける" />
					</Centered>
				) : (
					<>
						<View style={styles.steps}>
							<PairStep number={1} text="PC で Para Code を開く" />
							<PairStep number={2} text="コマンドパレットで「Para Code: モバイルデバイスを接続」を実行する" />
							<PairStep number={3} text="表示された QR コードを枠に収める" />
						</View>
						{/* 貼り付けのシートを出している間はカメラを外す（裏で読み取って勝手に始まらないように） */}
						{pasteOpen ? <PairScannerPlaceholder /> : <PairScanner onScanned={onScanned} />}
						<PasteLink onPress={() => setPasteOpen(true)} label="または、リンクを貼り付ける" />
					</>
				)}
			</View>
			<TextInputDrawer
				visible={pasteOpen}
				title="リンクを貼り付ける"
				message="PC に出たリンク（paracode-mobile://pair?d=…）を貼り付けます"
				placeholder="paracode-mobile://pair?d=…"
				submitLabel="接続"
				selectTextOnFocus={false}
				onSubmit={value => { scanLock.current = true; startWith(value); }}
				onClose={() => setPasteOpen(false)}
			/>
		</Screen>
	);
}

function Centered({ children }: { children: ReactNode }) {
	return <View style={styles.centered}>{children}</View>;
}

/** 読み取りの下の「リンクを貼り付ける」（Orca の pasteButton。文字だけのボタン）。 */
function PasteLink({ label, onPress }: { label: string; onPress: () => void }) {
	return (
		<Pressable
			onPress={() => { hapticSelection(); onPress(); }}
			hitSlop={hitSlopToMinimum(36)}
			style={({ pressed }) => [styles.paste, pressed ? styles.pastePressed : undefined]}
			accessibilityRole="button"
			accessibilityLabel={label}
		>
			<Icon icon={Clipboard} color={colors.textDim} />
			<Text style={styles.pasteText}>{label}</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	body: {
		flex: 1,
		paddingHorizontal: space.lg,
	},
	centered: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		paddingBottom: space.xl * 2,
	},
	steps: {
		gap: space.sm,
		marginTop: space.sm,
		marginBottom: space.lg,
		marginLeft: space.xs + 3,
	},
	title: {
		fontSize: type.title,
		fontWeight: '600',
		color: colors.text,
		textAlign: 'center',
		marginBottom: space.sm,
		maxWidth: TEXT_MAX_WIDTH,
	},
	sasTitle: {
		marginTop: space.xl,
	},
	subtitle: {
		fontSize: type.body,
		lineHeight: 20,
		color: colors.textDim,
		textAlign: 'center',
		maxWidth: TEXT_MAX_WIDTH,
	},
	sas: {
		fontSize: type.display,
		fontWeight: '700',
		letterSpacing: 6,
		color: colors.text,
		fontVariant: ['tabular-nums'],
		marginVertical: space.xl,
	},
	connecting: {
		fontSize: type.body,
		color: colors.textDim,
		marginTop: space.lg,
	},
	error: {
		fontSize: type.body,
		lineHeight: 20,
		color: colors.red,
		textAlign: 'center',
		maxWidth: TEXT_MAX_WIDTH,
	},
	actions: {
		width: '100%',
		maxWidth: ACTIONS_MAX_WIDTH,
		gap: space.sm,
		marginTop: space.xl,
	},
	paste: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		alignSelf: 'center',
		gap: space.xs,
		marginTop: space.md,
		paddingVertical: space.sm,
		paddingHorizontal: space.md,
	},
	pastePressed: {
		opacity: 0.6,
	},
	pasteText: {
		fontSize: type.body,
		fontWeight: '500',
		color: colors.textDim,
	},
});
