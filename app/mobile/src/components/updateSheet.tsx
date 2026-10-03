// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useAppStore } from '../appState.js';
import { useAppLocked } from '../appLock.js';
import { lockedModalVisible } from '../appLockPolicy.js';
import { GlassSurface, liquidGlass } from './glassSurface.js';
import { pendingReleases, type MobileChangelogItem, type MobileRelease } from '../changelog.js';
import { secureKeyStore } from '../platform.js';
import { useIsRegularWidth } from '../hooks/useSizeClass.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { alpha, colors, radius, squircle, tint, type } from '../theme.js';
import { Badge } from './badge.js';
import { Button } from './button.js';
import { haptic } from '../haptics.js';

/** iPadの広い幅でお知らせシートを中央寄せするときの最大幅（pt）。 */
const SHEET_MAX_WIDTH = 640;

/**
 * アップデートのお知らせ（案A: Liquid Glass のボトムシート）。
 *
 * 出しすぎないことを最優先にしている:
 *  - 新規インストールでは出さない（現在バージョンを既読にするだけ）
 *  - 同じバージョンでは二度と出さない
 *  - 飛ばした複数バージョンはまとめて1回だけ
 *  - items が空の版（内部整備のみ）はスキップ
 *  - ペアリング前・認証ゲート中は出さない（初期設定を邪魔しない）
 */

/** 既読バージョンの保存キー（Keychain / Keystore）。 */
const SEEN_KEY = 'update-seen-version';
/** 起動直後は接続処理とレイアウトで画面が動くので、落ち着いてから出す。 */
const APPEAR_DELAY_MS = 600;

export const APP_VERSION: string = Constants.expoConfig?.version ?? '0.0.0';

export function UpdateSheetHost() {
	const ready = useAppStore(state => state.ready);
	const paired = useAppStore(state => state.paired);
	// ロック中は出さない。解除後に改めて落ち着くのを待ってから出す。
	const locked = useAppLocked();
	const [releases, setReleases] = useState<readonly MobileRelease[]>([]);
	useEffect(() => {
		if (!ready || !paired || locked) {
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			void secureKeyStore.getItem(SEEN_KEY)
				.then(seen => {
					if (cancelled) {
						return;
					}
					const pending = pendingReleases(APP_VERSION, seen ?? undefined);
					if (pending.length > 0) {
						setReleases(pending);
					} else {
						// 新規インストール・既読済み・内容なし。いずれも黙って既読にするだけ。
						void secureKeyStore.setItem(SEEN_KEY, APP_VERSION).catch(() => undefined);
					}
				})
				.catch(() => undefined);
		}, APPEAR_DELAY_MS);
		return () => { cancelled = true; clearTimeout(timer); };
	}, [ready, paired, locked]);

	const dismiss = () => {
		haptic('move');
		setReleases([]);
		void secureKeyStore.setItem(SEEN_KEY, APP_VERSION).catch(() => undefined);
	};
	if (releases.length === 0) {
		return null;
	}
	return <UpdateSheet releases={releases} onDismiss={dismiss} />;
}

/** シート本体。履歴画面からのプレビューにも使えるよう、表示するリリースを受け取る。 */
export function UpdateSheet({ releases, onDismiss }: { releases: readonly MobileRelease[]; onDismiss: () => void }) {
	const insets = useStableInsets();
	// iPadの広い幅では画面いっぱいに広げず、中央へ寄せた読みやすい幅に収める。
	const regular = useIsRegularWidth();
	const { width: windowWidth } = useWindowDimensions();
	const sideInset = regular ? Math.max(0, Math.round((windowWidth - SHEET_MAX_WIDTH) / 2)) : 0;
	const single = releases.length === 1 ? releases[0] : undefined;
	const total = releases.reduce((count, release) => count + release.items.length, 0);
	const oldest = releases[releases.length - 1];
	// Modal はロック画面より上に出るので、ロック中は隠す。閉じる（既読にする）とは扱わない。
	const locked = useAppLocked();
	return (
		<Modal visible={lockedModalVisible(true, locked)} transparent animationType={locked ? 'none' : 'slide'} onRequestClose={onDismiss} statusBarTranslucent>
			<Pressable style={styles.scrim} onPress={onDismiss} accessibilityLabel="閉じる" />
			<View style={[styles.sheetWrap, sideInset > 0 && { left: sideInset, right: sideInset }]}>
				{/* Liquid Glass は面そのもの。上に載せる操作要素（CTA）は Apple HIG に従い
				    glass を重ねず不透明にする */}
				<GlassSurface style={styles.glass} />
				<View style={[styles.sheet, !liquidGlass && styles.sheetFallback]}>
					<View style={styles.handle} />
					<View style={styles.head}>
						<Badge
							tone="accent"
							icon="sparkles"
							style={styles.badge}
							label={single !== undefined ? `バージョン ${single.version}` : `${oldest?.version} → ${releases[0]?.version}`}
						/>
						<Text style={styles.title}>{single?.headline ?? (releases.length > 1 ? `${releases.length} 回ぶんの更新があります` : '今回の変更')}</Text>
						<Text style={styles.subtitle}>
							{single !== undefined ? `前回のご利用から ${total} 件の改善があります` : `あわせて ${total} 件の改善があります`}
						</Text>
					</View>
					<ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator={false}>
						{releases.map((release, index) => (
							<View key={release.version} style={styles.group}>
								{/* 複数バージョンをまとめたときだけ、どの版の内容かを示す */}
								{releases.length > 1 ? (
									<View style={styles.versionRow}>
										<Badge tone={index > 0 ? 'neutral' : 'accent'} label={release.version} />
										<Text style={styles.versionDate}>{formatDate(release.date)}</Text>
									</View>
								) : null}
								{release.items.map(item => <ChangelogRow key={item.title} item={item} />)}
							</View>
						))}
					</ScrollView>
					<View style={[styles.foot, { paddingBottom: insets.bottom + 14 }]}>
						{/* glass の上に glass を重ねない（HIG）。CTA は不透明の主ボタンにする。 */}
						<Button label="はじめる" variant="primary" onPress={onDismiss} accessibilityLabel="はじめる" />
					</View>
				</View>
			</View>
		</Modal>
	);
}

/** 1項目（アイコン＋見出し＋説明）。履歴画面からも使う。 */
export function ChangelogRow({ item }: { item: MobileChangelogItem }) {
	const tone = toneStyle(item.tone);
	return (
		<View style={styles.item}>
			<View style={[styles.itemIcon, tone.wrap]}>
				<Ionicons name={item.icon as never} size={15} color={tone.color} />
			</View>
			<View style={styles.itemBody}>
				<Text style={styles.itemTitle}>{item.title}</Text>
				{item.body !== undefined ? <Text style={styles.itemText}>{item.body}</Text> : null}
			</View>
		</View>
	);
}

function toneStyle(tone: MobileChangelogItem['tone']): { wrap: { backgroundColor: string; borderColor: string }; color: string } {
	switch (tone) {
		case 'green': return { wrap: { backgroundColor: tint(colors.green, alpha.wash), borderColor: tint(colors.green, alpha.line) }, color: colors.green };
		case 'purple': return { wrap: { backgroundColor: tint(colors.purple, alpha.wash), borderColor: tint(colors.purple, alpha.line) }, color: colors.purple };
		case 'yellow': return { wrap: { backgroundColor: tint(colors.yellow, alpha.wash), borderColor: tint(colors.yellow, alpha.line) }, color: colors.yellow };
		default: return { wrap: { backgroundColor: colors.accentWash, borderColor: tint(colors.accent, alpha.line) }, color: colors.accent };
	}
}

/** '2026-07-28' → '2026年7月28日'。 */
export function formatDate(date: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (match === null) {
		return date;
	}
	return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

const styles = StyleSheet.create({
	scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
	sheetWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '82%', borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, ...squircle, overflow: 'hidden' },
	glass: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, ...squircle, overflow: 'hidden' },
	sheet: { borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, ...squircle, borderTopWidth: 1, borderColor: colors.glassBorder },
	// Liquid Glass 非対応（iOS 26未満 / Android）では GlassSurface が BlurView に落ちる。
	// それでも文字が沈むので、面の色をわずかに足して可読性を確保する。
	sheetFallback: { backgroundColor: 'rgba(12,12,15,0.72)' },
	handle: { width: 36, height: 5, borderRadius: 2.5, backgroundColor: colors.borderStrong, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
	head: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
	badge: { marginBottom: 10 },
	title: { color: colors.text, fontSize: type.large, fontWeight: '800', lineHeight: 26 },
	subtitle: { color: colors.textDim, fontSize: type.meta, marginTop: 5 },
	body: { flexGrow: 0 },
	bodyContent: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 4, gap: 14 },
	group: { gap: 14 },
	versionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	versionDate: { color: colors.textDim, fontSize: type.badge },
	item: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
	itemIcon: { width: 32, height: 32, borderRadius: radius.control, ...squircle, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
	itemBody: { flex: 1, minWidth: 0 },
	itemTitle: { color: colors.text, fontSize: type.body, fontWeight: '700' },
	itemText: { color: colors.textDim, fontSize: type.meta, lineHeight: 19, marginTop: 3 },
	foot: { paddingHorizontal: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
});
