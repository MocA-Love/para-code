// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Fragment } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { ProviderLogo } from '../../components/providerLogo.js';
import { alpha, colors, radius, space, type } from '../../theme.js';
import { formatRelativeTime } from '../../time.js';
import { updatedAtLabel } from '../../usageFormat.js';
import { Icon, Meter, MeterRow, iconSize } from '../../ui/index.js';
import { AccountRow, UnavailableAccountsGroup, UsageRow, UsageRowTitle, UsageSection, UsageSeparator } from '../settings/usageSections.js';
import { accountName, providerEmptyMessage } from '../settings/usageSummary.js';
import { DetailMessage } from '../settings/usageDetailParts.js';
import {
	entryKindLabel,
	entryTitle,
	isNoResponseError,
	staleOf,
	usageErrorText,
	type AggregatedAccount,
	type SeenOn,
	type UsageEntry,
	type UsageKind,
} from './usageAggregate.js';
import type { RateLimitProviderSnapshot } from '../../store.js';
import type { PcResourceSummary } from '../../appState.js';
import type { UsageOverview } from './usageStore.js';

/**
 * 使用量の「全 PC の合計」（案 B）の部品。束（`UsageSection`）と行（`UsageRow`）は 1 台ぶんの画面と同じものを使い、
 * 違いは「見えている PC のチップ」と「PC ごと」の行だけにする。
 */

/** 「5分前」「たった今」（取得した時刻の言い方）。 */
export function fetchedAtPhrase(at: number, now: number): string {
	return now - at < 60_000 ? 'たった今' : formatRelativeTime(at, now);
}

/** CPU・メモリ・SSD の読み上げ（取れているものだけ）。 */
function resourcesSpeech(resources: PcResourceSummary): string {
	return [
		resources.cpu !== undefined ? `CPU ${resources.cpu}%` : undefined,
		resources.memPercent !== undefined ? `メモリ ${resources.memPercent}%` : undefined,
		resources.diskPercent !== undefined ? `SSD ${resources.diskPercent}%` : undefined,
	].filter((part): part is string => part !== undefined).join('、');
}

/** 値の古さの一文（オンラインなら「5分前に更新」、オフラインなら「3時間前の値（オフライン）」）。 */
export function entryFreshness(online: boolean, at: number | undefined, now: number): string | undefined {
	if (at === undefined) {
		return online ? undefined : 'オフライン';
	}
	return online ? updatedAtLabel(at, now) : `${fetchedAtPhrase(at, now)}の値（オフライン）`;
}

/** そのアカウント（GitHub のアカウント）が見えている PC のチップ。古い値の PC は薄くする。 */
export function SeenOnChips({ chips }: { chips: readonly SeenOn[] }) {
	if (chips.length === 0) {
		return null;
	}
	return (
		<View style={styles.chips}>
			{chips.map(chip => (
				<Text
					key={chip.key}
					style={[styles.chip, chip.old ? styles.chipOld : undefined]}
					numberOfLines={1}
					accessible
					// 薄さは読み上げに出ないので、古い値かどうかを言葉で添える
					accessibilityLabel={`${chip.label} で使用${chip.old ? '（古い値）' : ''}`}
				>
					{chip.label}
				</Text>
			))}
		</View>
	);
}

/**
 * Claude / Codex の束（全 PC の合計）。アカウントごとに1行で、見えている PC をチップで添える。
 * `showChips` は PC が2台以上のときだけ（1台なら PC の名前は要らない）。
 */
export function AggregatedProviderSection({ provider, title, accounts, emptySnapshot, anyLimits, loading, now, showChips, expandResets = false }: {
	provider: 'claude' | 'codex';
	title: string;
	accounts: readonly AggregatedAccount[];
	/** アカウントが1つも無いときの説明に使うスナップショット。 */
	emptySnapshot: RateLimitProviderSnapshot | undefined;
	/** どこかの PC から上限を1度でも取れたか（「読み込み中」と「アカウントが無い」を分ける）。 */
	anyLimits: boolean;
	loading: boolean;
	now: number;
	showChips: boolean;
	/** リセットの期限の一覧を最初から開いておく（iPad の広い幅）。 */
	expandResets?: boolean;
}) {
	// 取得できていないアカウントは1行に畳む（接続先のログインは畳まない）
	const folded = (item: AggregatedAccount) => item.account.status === 'unavailable' && item.remoteHost === undefined;
	const shown = accounts.filter(item => !folded(item));
	const unavailable = accounts.filter(folded);
	const row = (item: AggregatedAccount) => (
		<AccountRow
			account={item.account}
			now={now}
			remoteHost={item.remoteHost}
			dimmed={item.old}
			expandResets={expandResets}
			extra={showChips ? <SeenOnChips chips={item.seenOn} /> : undefined}
		/>
	);
	return (
		<UsageSection title={title} logo={<ProviderLogo provider={provider} size={iconSize.sm} />}>
			{!anyLimits ? (
				<UsageRow><UsageRowTitle title={loading ? '取得しています…' : 'まだ取得していません'} /></UsageRow>
			) : accounts.length === 0 ? (
				<UsageRow><UsageRowTitle title="アカウントがありません" hint={emptySnapshot !== undefined ? providerEmptyMessage(emptySnapshot) : undefined} /></UsageRow>
			) : (
				<>
					{shown.map((item, index) => (
						<View key={item.key}>
							{index > 0 ? <UsageSeparator /> : null}
							{row(item)}
						</View>
					))}
					<UnavailableAccountsGroup names={unavailable.map(item => accountName(item.account))} separated={shown.length > 0}>
						{unavailable.map((item, index) => (
							<Fragment key={item.key}>
								{index > 0 ? <UsageSeparator /> : null}
								{row(item)}
							</Fragment>
						))}
					</UnavailableAccountsGroup>
				</>
			)}
		</UsageSection>
	);
}

/** 「PC ごと」の1行に添える値（今日のコストなど）。 */
export interface EntryRowValue {
	readonly value?: string | undefined;
	/** 値の取得時刻（古さの一文に使う）。 */
	readonly at?: number | undefined;
}

/**
 * 「PC ごと」の行。PC の名前（同じ機械へ SSH でも繋いでいれば添える）、オンラインか・いつの値か、CPU・メモリ・SSD
 * （PC のみ。desktop state の値）、右に今日のコストなどを出す。押すとその PC だけの表示へ。
 */
export function UsageEntryRows({ entries, values, now, onOpen, showResources = true }: {
	entries: readonly UsageEntry[];
	values: Readonly<Record<string, EntryRowValue | undefined>>;
	now: number;
	onOpen: (entry: UsageEntry) => void;
	showResources?: boolean;
}) {
	return (
		<View style={styles.card}>
			{entries.map((entry, index) => {
				const value = values[entry.key];
				const hint = [entryKindLabel(entry), entryFreshness(entry.online, value?.at, now)].filter((part): part is string => part !== undefined).join(' · ');
				const resources = showResources ? entry.resources : undefined;
				return (
					<View key={entry.key}>
						{index > 0 ? <UsageSeparator /> : null}
						<Pressable
							onPress={() => onOpen(entry)}
							style={({ pressed }) => [styles.entry, pressed ? styles.pressed : undefined]}
							accessibilityRole="button"
							// 値・状態・いつの値かも読み上げる（行の中の文字は1つのボタンにまとまって読まれない）
							accessibilityLabel={[
								entryTitle(entry),
								entry.online ? 'オンライン' : 'オフライン',
								hint.length > 0 ? hint : undefined,
								value?.value !== undefined ? value.value : undefined,
								resources !== undefined ? resourcesSpeech(resources) : undefined,
							].filter((part): part is string => part !== undefined).join('、')}
							accessibilityHint="この PC の使用量を開きます"
						>
							<View style={[styles.entryMain, entry.online ? undefined : styles.old]}>
								<View style={styles.entryTitleRow}>
									<View style={[styles.dot, { backgroundColor: entry.online ? colors.green : colors.textMuted }]} />
									<Text style={styles.entryTitle} numberOfLines={1}>{entryTitle(entry)}</Text>
									{value?.value !== undefined ? <Text style={styles.entryValue}>{value.value}</Text> : null}
								</View>
								{hint.length > 0 ? <Text style={styles.entryHint} numberOfLines={2}>{hint}</Text> : null}
								{/* メーターは2つずつ（3つ並べると iPhone の幅で数字が詰まる）。 */}
								{resources !== undefined ? (
									<>
										<MeterRow>
											<Meter label="CPU" percent={resources.cpu} />
											<Meter label="メモリ" percent={resources.memPercent} />
										</MeterRow>
										<MeterRow>
											<Meter label="SSD" percent={resources.diskPercent} />
											<View style={styles.meterSpacer} />
										</MeterRow>
									</>
								) : null}
							</View>
							<View style={styles.trailing}><Icon icon={ChevronRight} color={colors.textMuted} /></View>
						</Pressable>
					</View>
				);
			})}
		</View>
	);
}

/**
 * 取得の失敗と古い値の注記。時間切れはエラー文の代わりに「前回の値を表示しています」と書き、PC が前回の値を
 * 返した（`stale`）ときは取得時刻を添える。
 */
export function UsageFetchNote({ error, hasPrevious, staleAt, now }: {
	error: unknown;
	hasPrevious: boolean;
	/** PC が前回の値を返したときの、その値の取得時刻。 */
	staleAt?: number | undefined;
	now: number;
}) {
	if (error !== undefined) {
		return <DetailMessage tone={hasPrevious ? 'note' : 'error'}>{usageErrorText(error, hasPrevious)}</DetailMessage>;
	}
	if (staleAt !== undefined) {
		return <DetailMessage tone="note">{`PC の集計に時間がかかっています。${fetchedAtPhrase(staleAt, now)}に取得した値を表示しています`}</DetailMessage>;
	}
	return null;
}

/** 全 PC の合計で、出どころ1つぶんの取得の状態。 */
export interface FetchNoteItem {
	readonly label: string;
	readonly error?: unknown;
	readonly hasPrevious: boolean;
	/** PC が前回の値を返したときの、その値の取得時刻。 */
	readonly staleAt?: number | undefined;
}

/** 「PC ごと」の行それぞれの、その指標の取得の状態（失敗したか・PC が前回の値を返したか）。何も無い行は含めない。 */
export function fetchNoteItems(overview: UsageOverview, kind: UsageKind): FetchNoteItem[] {
	return overview.entries.flatMap(entry => {
		const value = entry.values[kind];
		const error = entry.sourceKeys.map(key => overview.errorOf(key, kind)).find(item => item !== undefined);
		const stale = staleOf(value);
		if (error === undefined && !stale) {
			return [];
		}
		return [{ label: entry.label, error, hasPrevious: value !== undefined, staleAt: stale ? value?.at : undefined }];
	});
}

/**
 * 全 PC の合計での取得の失敗と古い値の注記。時間切れの PC はまとめて「前回の値を表示しています」と書き、
 * それ以外の失敗は PC の名前を添えてそのまま出す。
 */
export function AggregatedFetchNotes({ items, now }: { items: readonly FetchNoteItem[]; now: number }) {
	const slow = items.filter(item => item.error !== undefined && isNoResponseError(item.error));
	const failed = items.filter(item => item.error !== undefined && !isNoResponseError(item.error));
	const stale = items.filter(item => item.error === undefined && item.staleAt !== undefined);
	return (
		<>
			{slow.length > 0 ? (
				<DetailMessage tone="note">
					{`${slow.map(item => item.label).join('・')} の集計に時間がかかっています。${slow.every(item => item.hasPrevious) ? '前回の値を表示しています' : 'しばらくしてから取り直してください'}`}
				</DetailMessage>
			) : null}
			{stale.map(item => (
				<DetailMessage key={`stale-${item.label}`} tone="note">{`${item.label} の集計に時間がかかっています。${fetchedAtPhrase(item.staleAt!, now)}に取得した値を表示しています`}</DetailMessage>
			))}
			{failed.map(item => (
				<DetailMessage key={`error-${item.label}`} tone={item.hasPrevious ? 'note' : 'error'}>{`${item.label}: ${usageErrorText(item.error, item.hasPrevious)}`}</DetailMessage>
			))}
		</>
	);
}

const DOT = 7;

const styles = StyleSheet.create({
	chips: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.xs,
		marginTop: space.xs,
	},
	chip: {
		fontSize: type.badge,
		fontWeight: '600',
		color: colors.textDim,
		backgroundColor: colors.raised,
		borderRadius: radius.key,
		paddingHorizontal: space.xs + 2,
		paddingVertical: 2,
		overflow: 'hidden',
		maxWidth: 200,
	},
	chipOld: {
		opacity: alpha.strong,
	},
	card: {
		backgroundColor: colors.panel,
		borderRadius: radius.card,
		overflow: 'hidden',
		marginBottom: space.xl,
	},
	entry: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingVertical: space.md,
		paddingHorizontal: space.md + 2,
		gap: space.sm,
	},
	pressed: {
		opacity: 0.7,
	},
	entryMain: {
		flex: 1,
		minWidth: 0,
		gap: space.xs,
	},
	entryTitleRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	dot: {
		width: DOT,
		height: DOT,
		borderRadius: DOT / 2,
	},
	meterSpacer: {
		flex: 1,
	},
	entryTitle: {
		flex: 1,
		minWidth: 0,
		fontSize: type.body,
		fontWeight: '500',
		color: colors.text,
	},
	entryHint: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textDim,
	},
	entryValue: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
		fontVariant: ['tabular-nums'],
	},
	old: {
		opacity: alpha.strong,
	},
	trailing: {
		marginLeft: space.xs,
	},
});
