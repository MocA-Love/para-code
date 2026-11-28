// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronDown, ChevronRight, Shield, Bot as BotIcon } from 'lucide-react-native';
import { useAppStore } from '../../appState.js';
import { haptic } from '../../haptics.js';
import { useRoutePc } from '../../hooks/useRouteTargets.js';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import { useContentColumnStyle } from '../../ipad/useContentColumn.js';
import { monoFamily } from '../../monoFont.js';
import { useParaToast } from '../../paraToast.js';
import { PcCapability, pcHasCapability } from '../../pcCompat.js';
import { routes } from '../../routes.js';
import type { WorktreeAgentDef } from '../../store.js';
import { colors, radius, space, type } from '../../theme.js';
import { formatRelativeTime, useNow } from '../../time.js';
import { Button, Card, ConfirmDrawer, EmptyState, Icon, ListGroup, ListRow, PickerDrawer, Screen, ScreenHeader, SectionHeader, TextInputDrawer, iconSize, type PickerOption } from '../../ui/index.js';
import { Segments } from '../code/codeParts.js';
import { HumanAskCard } from '../humanAsks/humanAskCard.js';
import { useHumanAsks, useHumanAskSync } from '../humanAsks/humanAskStore.js';
import { SettingsSwitch } from '../settings/settingsScaffold.js';
import { useBotConversation } from './botConversation.js';
import { BotFace } from './botFace.js';
import {
	BotHeldChoice,
	botAgentLabel,
	botAskFor,
	botSendConfirmedChange,
	botItemGroups,
	botItemStatusLabel,
	botRefusalText,
	botFieldChange,
	botConfirmMessage,
	botFaceState,
	botStatusLine,
	newBotOpId,
	type BotChanges,
	type BotFile,
	type BotItemRow,
	type MobileBot,
} from './bots.js';
import { actOnBotSuggestion, botFileKey, botKey, readBotFile, refreshBotPage, updateBot, useBotPages, useBotPageSync, writeBotFile } from './botStore.js';

type Tab = 'items' | 'chat' | 'files' | 'settings';

const TABS: readonly { readonly key: Tab; readonly label: string }[] = [
	{ key: 'items', label: '項目' },
	{ key: 'chat', label: '会話' },
	{ key: 'files', label: 'ファイル' },
	{ key: 'settings', label: '設定' },
];

/** Bot ごとに最後に見ていたタブ（ページを開き直しても同じ所を見せる。アプリを閉じれば消える）。 */
const lastTabs = new Map<string, Tab>();

const NO_ASKS: readonly never[] = [];
const NO_ROWS: readonly BotItemRow[] = [];

function warn(key: string, text: string, sub?: string): void {
	useParaToast.getState().show({ key, text, ...(sub !== undefined ? { sub } : {}), icon: 'alert-circle-outline', tone: 'warn' }, 3_500);
}

/**
 * Bot のページ（`/pc/[pcId]/bot/[botId]`。設計 5 章、モックのスマホの右の画面）。上に 項目・会話・ファイル・設定。
 *
 *  - 項目: 要対応（台帳の質問カードで答える）・進行中・予定・後回し・提案・終わった。行を押すと項目のページ
 *  - 会話: 新しい画面は作らず、その Bot のペインのセッションの画面へ移る（無ければ PC に起動を頼む）
 *  - ファイル: SOUL.md（読むだけ）と MEMORY.md（書ける。開いた後に書き換わっていれば書かない）
 *  - 設定: 一時停止・ピン留め・名前・エージェント・権限。エージェント・権限は PC と同じ確認の本文をシートで確かめる
 *
 * 許可（ツールの承認）はここに出さない（要対応とセッションの画面のまま）。iPad では詳細の列に入る。
 */
export function BotScreen() {
	const router = useRouter();
	const params = useLocalSearchParams<{ pcId?: string; botId?: string }>();
	const { pcId, pc, status } = useRoutePc(params.pcId);
	const botId = typeof params.botId === 'string' ? params.botId : undefined;
	const active = status === 'active';
	const supported = useAppStore(s => active && pcHasCapability(s.workspace, PcCapability.BotsPage));
	const statusKnown = useAppStore(s => active && pcHasCapability(s.workspace, PcCapability.BotsStatus));
	const bot = useAppStore(s => (active && botId !== undefined ? s.workspace?.bots?.find(candidate => candidate.id === botId) : undefined));
	const connected = pc?.connection === 'online';
	const [tab, setTabState] = useState<Tab>(() => (botId !== undefined ? lastTabs.get(botId) : undefined) ?? 'items');
	const setTab = (next: Tab) => {
		if (botId !== undefined) {
			lastTabs.set(botId, next);
		}
		setTabState(next);
	};
	useBotPageSync(pcId, bot, connected);

	const meta = bot !== undefined ? (
		<View style={styles.meta}>
			<BotFace color={bot.faceColor} shape={bot.faceShape} size={16} dim={bot.paused} state={botFaceState(bot, statusKnown)} />
			<Text style={styles.metaText} numberOfLines={1}>{`${botAgentLabel(bot.agent)} · ${botStatusLine(bot)}`}</Text>
		</View>
	) : undefined;

	const body = (() => {
		if (pcId === undefined || botId === undefined || status === 'unknown') {
			return <EmptyState title="この PC は見つかりません" />;
		}
		if (!active) {
			return <EmptyState title="接続しています…" />;
		}
		if (!supported) {
			return <EmptyState title="この PC では Bot を開けません" body="PC の Para Code を更新し、PC の設定で Bot をオンにしてください。" />;
		}
		if (bot === undefined) {
			return <EmptyState title="この Bot は見つかりません" body="PC で消されたか、PC の設定で Bot がオフになっています。" />;
		}
		switch (tab) {
			case 'items': return <ItemsTab pcId={pcId} bot={bot} />;
			case 'chat': return <ChatTab pcId={pcId} bot={bot} active={active} />;
			case 'files': return <FilesTab pcId={pcId} bot={bot} connected={connected} />;
			case 'settings': return <SettingsTab pcId={pcId} bot={bot} />;
		}
	})();

	return (
		<Screen>
			<ScreenHeader title={bot?.name ?? 'Bot'} {...(meta !== undefined ? { meta } : {})} onBack={() => (router.canGoBack() ? router.back() : pcId !== undefined ? router.replace(routes.pc(pcId)) : router.replace('/'))}>
				{bot !== undefined ? <Segments items={TABS} value={tab} onChange={setTab} /> : null}
			</ScreenHeader>
			<View style={styles.fill}>{body}</View>
		</Screen>
	);
}

/** 本文のスクロール（iPad では読みやすい幅の列）。 */
function Body({ children }: { children: ReactNode }) {
	const insets = useStableInsets();
	const column = useContentColumnStyle();
	return (
		<ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }, column]} keyboardShouldPersistTaps="handled">
			{children}
		</ScrollView>
	);
}

// ---- 項目 ---------------------------------------------------------------------------------------

function ItemsTab({ pcId, bot }: { pcId: string; bot: MobileBot }) {
	const router = useRouter();
	const now = useNow();
	const pc = useAppStore(s => s.pcs.find(candidate => candidate.id === pcId));
	const pcs = useMemo(() => (pc !== undefined ? [pc] : []), [pc]);
	useHumanAskSync(pcs);
	const asks = useHumanAsks(s => (pc?.humanAskSupported === true ? s.byPc[pcId]?.asks : undefined) ?? NO_ASKS);
	const rows = useBotPages(s => s.items[botKey(pcId, bot.id)]);
	const suggestions = useBotPages(s => s.suggestions[botKey(pcId, bot.id)]);
	const failed = useBotPages(s => s.failed[botKey(pcId, bot.id)] === true);
	const [showClosed, setShowClosed] = useState(false);
	const [busy, setBusy] = useState<string | undefined>(undefined);
	const conversation = useBotConversation(router, pcId, bot.id, true);
	const groups = botItemGroups(rows ?? NO_ROWS, now);
	const openItem = (uid: string) => { haptic('move'); router.push(routes.botItem(pcId, bot.id, uid)); };

	if (rows === undefined) {
		return failed
			? <EmptyState title="項目を読めませんでした" body="PC とのつながりを確かめてください。" action={{ label: '読み直す', onPress: () => void refreshBotPage(pcId, bot.id) }} />
			: <EmptyState title="読み込んでいます…" />;
	}
	const start = (id: string) => {
		setBusy(id);
		// 会話のペインがあると分かってから依頼の文を取り、入力欄へ入れられたときだけ PC で「始めた」にする
		// （入れ損ねた提案は一覧に残る）
		void conversation.open(async () => {
			const result = await actOnBotSuggestion(pcId, bot.id, id, 'start', newBotOpId());
			if (!result.ok) {
				warn(`bot-suggest-${id}`, '始められませんでした', botRefusalText(result.code));
				return false;
			}
			return result.value ?? '';
		}, () => {
			void actOnBotSuggestion(pcId, bot.id, id, 'started', newBotOpId()).then(marked => {
				if (!marked.ok) {
					warn(`bot-suggest-${id}`, '提案を「始めた」にできませんでした', botRefusalText(marked.code));
				}
			});
		}).finally(() => setBusy(undefined));
	};
	const dismiss = async (id: string) => {
		setBusy(id);
		const result = await actOnBotSuggestion(pcId, bot.id, id, 'dismiss', newBotOpId());
		setBusy(undefined);
		if (!result.ok) {
			warn(`bot-suggest-${id}`, '見送れませんでした', botRefusalText(result.code));
		}
	};
	const plain = (title: string | undefined, list: readonly BotItemRow[]) => list.length === 0 ? null : (
		<View style={styles.group}>
			{title !== undefined ? <SectionHeader title={title} count={list.length} /> : null}
			<ListGroup>
				{list.map(row => (
					<ListRow
						key={row.uid}
						label={`#${row.number} ${row.title}`}
						hint={`${botItemStatusLabel(row.status)} · ${formatRelativeTime(row.lastActivityAt, now)}`}
						trailing="chevron"
						onPress={() => openItem(row.uid)}
					/>
				))}
			</ListGroup>
		</View>
	);
	const empty = groups.you.length + groups.working.length + groups.planned.length + groups.snoozed.length + groups.closed.length === 0 && (suggestions?.length ?? 0) === 0;

	return (
		<Body>
			{empty ? <EmptyState title="項目はまだありません" body="Bot が仕事を受けると、ここに並びます。" style={styles.empty} /> : null}
			{groups.you.length > 0 ? (
				<View style={styles.group}>
					<SectionHeader title="要対応" count={groups.you.length} />
					{groups.you.map(row => {
						const ask = botAskFor(asks, row.uid);
						return (
							<View key={row.uid} style={styles.askBlock}>
								<Pressable onPress={() => openItem(row.uid)} accessibilityRole="button" accessibilityLabel={`項目 #${row.number} ${row.title} を開く`} style={({ pressed }) => [styles.askTitle, pressed ? styles.pressed : undefined]}>
									<Text style={styles.askNumber}>{`#${row.number}`}</Text>
									<Text style={styles.askTitleText} numberOfLines={2}>{row.title}</Text>
									<Icon icon={ChevronRight} size={iconSize.xs} color={colors.textMuted} />
								</Pressable>
								{ask !== undefined ? <View style={styles.askCard}><HumanAskCard pcId={pcId} ask={ask} now={now} /></View> : (
									<Text style={styles.note}>{pc?.humanAskSupported === true ? '質問を読み込んでいます…' : '質問には項目のページか PC で答えてください。'}</Text>
								)}
							</View>
						);
					})}
				</View>
			) : null}
			{plain('進行中', groups.working)}
			{plain('予定', groups.planned)}
			{plain('後回し', groups.snoozed)}
			{suggestions !== undefined && suggestions.length > 0 ? (
				<View style={styles.group}>
					<SectionHeader title="提案" count={suggestions.length} />
					{suggestions.map(suggestion => (
						<Card key={suggestion.id} style={styles.card}>
							<Text style={styles.cardTitle}>{suggestion.title}</Text>
							<Text style={styles.cardBody} numberOfLines={4}>{suggestion.request}</Text>
							<View style={styles.buttons}>
								<Button label="始める" size="sm" style={styles.flex} loading={busy === suggestion.id && conversation.opening} disabled={busy !== undefined || conversation.opening} onPress={() => start(suggestion.id)} />
								<Button label="見送る" size="sm" variant="secondary" style={styles.flex} disabled={busy !== undefined || conversation.opening} onPress={() => void dismiss(suggestion.id)} />
							</View>
							<Text style={styles.note}>始めると、依頼の文を会話の入力欄に入れます（送りはしません）。</Text>
						</Card>
					))}
				</View>
			) : null}
			{groups.closed.length > 0 ? (
				<View style={styles.group}>
					<Pressable style={styles.toggle} onPress={() => { haptic('move'); setShowClosed(!showClosed); }} accessibilityRole="button" accessibilityState={{ expanded: showClosed }}>
						<Icon icon={showClosed ? ChevronDown : ChevronRight} size={iconSize.xs} color={colors.textMuted} />
						<Text style={styles.toggleText}>{`終わった項目 ${groups.closed.length}`}</Text>
					</Pressable>
					{showClosed ? plain(undefined, groups.closed) : null}
				</View>
			) : null}
		</Body>
	);
}

// ---- 会話 ---------------------------------------------------------------------------------------

function ChatTab({ pcId, bot, active }: { pcId: string; bot: MobileBot; active: boolean }) {
	const router = useRouter();
	const conversation = useBotConversation(router, pcId, bot.id, active);
	const pane = conversation.pane;
	return (
		<Body>
			<Card style={styles.card}>
				<View style={styles.chatHead}>
					<Icon icon={BotIcon} size={iconSize.sm} color={colors.textDim} />
					<Text style={styles.cardTitle} numberOfLines={1}>{pane !== undefined ? pane.title : 'PC でペインが開いていません'}</Text>
				</View>
				<Text style={styles.cardBody}>
					{pane !== undefined
						? '会話は、このペインのセッションの画面で読み書きします。'
						: bot.paused ? '一時停止中です。設定のタブで動かしてから開いてください。' : 'PC で Bot のペインを起動し、現れたらセッションの画面を開きます。'}
				</Text>
				<Button
					label={pane !== undefined ? '会話を開く' : 'PC で起動して開く'}
					loading={conversation.opening}
					disabled={pane === undefined && bot.paused}
					onPress={() => void conversation.open()}
				/>
			</Card>
		</Body>
	);
}

// ---- ファイル -----------------------------------------------------------------------------------

function FilesTab({ pcId, bot, connected }: { pcId: string; bot: MobileBot; connected: boolean }) {
	const soul = useBotPages(s => s.files[botFileKey(pcId, bot.id, 'SOUL.md')]);
	const memory = useBotPages(s => s.files[botFileKey(pcId, bot.id, 'MEMORY.md')]);
	const [failed, setFailed] = useState(false);
	// `theirs` は保存したときに PC で書き換わっていた今の中身（書いた文は残し、上書きか読み直しを選ばせる）
	const [editing, setEditing] = useState<{ readonly base: string; text: string; readonly theirs?: string } | undefined>(undefined);
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		if (!connected) {
			return;
		}
		void Promise.all([readBotFile(pcId, bot.id, 'SOUL.md'), readBotFile(pcId, bot.id, 'MEMORY.md')]).then(results => setFailed(results.some(result => !result.ok)));
	}, [pcId, bot.id, connected]);

	const save = async () => {
		if (editing === undefined) {
			return;
		}
		setSaving(true);
		const result = await writeBotFile(pcId, bot.id, 'MEMORY.md', editing.text, editing.base, newBotOpId());
		setSaving(false);
		if (!result.ok) {
			warn('bot-memory', '保存できませんでした', botRefusalText(result.code));
			return;
		}
		if (result.value === 'conflict') {
			// 書いた文は残す。土台を今の中身に替えるので、もう一度「保存」を押すと今の中身へ上書きする
			const theirs = useBotPages.getState().files[botFileKey(pcId, bot.id, 'MEMORY.md')] ?? editing.base;
			warn('bot-memory', 'ほかの場所で書き換わっていました', '書いた文は残しています。今の中身を見て、上書きするか読み直すかを選んでください。');
			setEditing({ base: theirs, text: editing.text, theirs });
			return;
		}
		haptic('success');
		setEditing(undefined);
	};

	const file = (path: BotFile, text: string | undefined, hint: string, editable: boolean) => (
		<View style={styles.group}>
			<SectionHeader
				title={path}
				right={editable && editing === undefined && text !== undefined ? <Button label="編集" size="sm" variant="ghost" onPress={() => setEditing({ base: text, text })} /> : undefined}
			/>
			<Text style={styles.note}>{hint}</Text>
			{editable && editing !== undefined ? (
				<>
					{editing.theirs !== undefined ? (
						<>
							<Text style={styles.note}>PC の今の中身（保存すると、下の書いた文で上書きします）</Text>
							<View style={styles.fileBox}>
								<Text style={styles.fileText} selectable>{editing.theirs.length > 0 ? editing.theirs : '（空）'}</Text>
							</View>
							<Button label="今の中身を読み直す" size="sm" variant="secondary" disabled={saving} onPress={() => setEditing({ base: editing.theirs ?? editing.base, text: editing.theirs ?? editing.base })} />
						</>
					) : null}
					<TextInput
						style={styles.editor}
						multiline
						value={editing.text}
						onChangeText={next => setEditing({ ...editing, text: next })}
						autoCorrect={false}
						autoCapitalize="none"
						accessibilityLabel={`${path} の本文`}
					/>
					<View style={styles.buttons}>
						<Button label={editing.theirs !== undefined ? '上書きする' : '保存'} size="sm" style={styles.flex} loading={saving} disabled={editing.text === editing.base} onPress={() => void save()} />
						<Button label="やめる" size="sm" variant="secondary" style={styles.flex} disabled={saving} onPress={() => setEditing(undefined)} />
					</View>
				</>
			) : (
				<View style={styles.fileBox}>
					<Text style={styles.fileText} selectable>{text === undefined ? (failed ? '読めませんでした' : '読み込んでいます…') : text.length > 0 ? text : '（空）'}</Text>
				</View>
			)}
		</View>
	);

	return (
		<Body>
			{file('SOUL.md', soul, '役割。書き換えは PC の Bot のページの設定から（確かめてから当てます）。', false)}
			{file('MEMORY.md', memory, 'Bot が覚えていること。開いた後に Bot が書き換えていたら、上書きせずに読み直します。', true)}
		</Body>
	);
}

// ---- 設定 ---------------------------------------------------------------------------------------

type Sheet = 'name' | 'agent' | 'permission';

function SettingsTab({ pcId, bot }: { pcId: string; bot: MobileBot }) {
	const [agents, setAgents] = useState<readonly WorktreeAgentDef[] | undefined>(undefined);
	const [sheet, setSheet] = useState<Sheet | undefined>(undefined);
	// 確認のシートの中身（閉じる途中も同じ文のまま出す）と、確かめたら送り直す変更（閉じても消えない控え）
	const [confirmVisible, setConfirmVisible] = useState(false);
	const [confirmText, setConfirmText] = useState<{ readonly detail: string; readonly wider: boolean }>({ detail: '', wider: false });
	const heldChange = useRef(new BotHeldChoice<{ readonly changes: BotChanges; readonly opId: string }>());
	// 選択のシートで選んだ変更（シートが閉じ切ってから送る。閉じる途中で確認のシートを開かない）
	const picked = useRef(new BotHeldChoice<BotChanges | undefined>());
	const [sending, setSending] = useState(false);
	useEffect(() => {
		let cancelled = false;
		useAppStore.getState().worktreeForm({ agentsOnly: true }).then(form => {
			if (!cancelled) {
				setAgents(form.agents);
			}
		}, () => {
			if (!cancelled) {
				setAgents([]);
			}
		});
		return () => { cancelled = true; };
	}, [pcId]);

	const permissionsOf = (agent: string) => agents?.find(candidate => candidate.id === agent)?.permissions ?? [];
	const permissionLabel = (agent: string, id: string | undefined) => permissionsOf(agent).find(option => option.id === (id ?? 'default'))?.label ?? (id === undefined || id === 'default' ? '既定' : id);

	const send = async (changes: BotChanges, confirmed: boolean, opId: string) => {
		setSending(true);
		const result = await updateBot(pcId, bot.id, changes, confirmed, opId);
		setSending(false);
		if (!result.ok) {
			warn(`bot-update-${bot.id}`, '変えられませんでした', botRefusalText(result.code));
			return;
		}
		if (result.value.kind === 'confirm') {
			heldChange.current.hold({ changes, opId });
			setConfirmText({ detail: result.value.detail, wider: result.value.wider });
			setConfirmVisible(true);
			return;
		}
		haptic('success');
	};
	const change = (changes: BotChanges | undefined) => {
		if (changes !== undefined) {
			// 確かめる変更は、まず確認の本文を取りに行く（同じ opId で確かめた後に送り直す）
			void send(changes, false, newBotOpId());
		}
	};

	const agentIds = ['claude', 'codex', ...(bot.agent === 'claude' || bot.agent === 'codex' ? [] : [bot.agent])];
	const agentOptions: PickerOption[] = agentIds.map(id => ({ value: id, label: botAgentLabel(id) }));
	const permissionOptions: PickerOption[] = permissionsOf(bot.agent).map(option => ({ value: option.id, label: option.label, ...(option.hint !== undefined ? { hint: option.hint } : {}), icon: Shield }));

	return (
		<Body>
			<ListGroup style={styles.group}>
				<ListRow label="動かす" hint={bot.paused ? '一時停止中（見回り・依頼を受けません）' : '見回りと依頼を受けます'} trailing={<SettingsSwitch value={!bot.paused} disabled={sending} onValueChange={value => change({ paused: !value })} accessibilityLabel="動かす" />} />
				<ListRow label="ピン留め" hint="PC の一覧で上に置きます" trailing={<SettingsSwitch value={bot.pinned} disabled={sending} onValueChange={value => change({ pinned: value })} accessibilityLabel="ピン留め" />} />
			</ListGroup>
			<ListGroup style={styles.group}>
				<ListRow label="名前" value={bot.name} trailing="chevron" disabled={sending} onPress={() => setSheet('name')} />
				<ListRow label="エージェント" value={botAgentLabel(bot.agent)} trailing="chevron" disabled={sending} onPress={() => setSheet('agent')} />
				<ListRow
					label="権限"
					value={agents === undefined ? '読み込んでいます…' : permissionLabel(bot.agent, bot.permissionId)}
					trailing="chevron"
					disabled={sending || permissionOptions.length === 0}
					onPress={() => setSheet('permission')}
				/>
			</ListGroup>
			<Text style={styles.note}>エージェントと権限を変えるときは、PC と同じ確認を出します。エージェントを変えると権限は既定に戻ります。顔の色と形・役割（SOUL.md）は PC で変えます。</Text>
			<TextInputDrawer
				visible={sheet === 'name'}
				title="名前"
				defaultValue={bot.name}
				maxLength={64}
				onSubmit={value => { setSheet(undefined); change(botFieldChange(bot, { name: value })); }}
				onClose={() => setSheet(undefined)}
			/>
			<PickerDrawer<string>
				visible={sheet === 'agent'}
				title="エージェント"
				options={agentOptions}
				selected={bot.agent}
				onSelect={value => picked.current.hold(botFieldChange(bot, { agent: value }))}
				onClose={() => setSheet(undefined)}
				onAfterClose={() => change(picked.current.take())}
			/>
			<PickerDrawer<string>
				visible={sheet === 'permission'}
				title="権限"
				options={permissionOptions}
				selected={bot.permissionId ?? 'default'}
				onSelect={value => picked.current.hold(botFieldChange(bot, { permissionId: value }))}
				onClose={() => setSheet(undefined)}
				onAfterClose={() => change(picked.current.take())}
			/>
			<ConfirmDrawer
				visible={confirmVisible}
				title={`${bot.name} の設定を変えますか`}
				message={botConfirmMessage(confirmText.detail, confirmText.wider)}
				confirmLabel="変える"
				destructive={confirmText.wider}
				onConfirm={() => botSendConfirmedChange(heldChange.current, (changes, confirmed, opId) => void send(changes, confirmed, opId))}
				onCancelled={() => heldChange.current.take()}
				onClose={() => setConfirmVisible(false)}
			/>
		</Body>
	);
}

const styles = StyleSheet.create({
	// 要対応のカードは画面の端から余白を取る作り（要対応の一覧と同じ）。本文の余白と二重にしない
	askCard: {
		marginHorizontal: -space.lg,
	},
	fill: {
		flex: 1,
	},
	content: {
		paddingHorizontal: space.lg,
		paddingTop: space.md,
		gap: space.md,
	},
	meta: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		minWidth: 0,
	},
	metaText: {
		flexShrink: 1,
		fontSize: type.caption,
		color: colors.textDim,
	},
	group: {
		gap: space.sm,
	},
	empty: {
		flex: 0,
		paddingVertical: space.xl,
	},
	askBlock: {
		gap: space.xs,
	},
	askTitle: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingVertical: space.xs,
		borderRadius: radius.row,
	},
	askNumber: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	askTitleText: {
		flex: 1,
		minWidth: 0,
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	pressed: {
		backgroundColor: colors.raised,
	},
	card: {
		gap: space.sm,
		padding: space.md,
	},
	cardTitle: {
		flexShrink: 1,
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	cardBody: {
		fontSize: type.label,
		color: colors.textDim,
	},
	chatHead: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		minWidth: 0,
	},
	buttons: {
		flexDirection: 'row',
		gap: space.sm,
	},
	flex: {
		flex: 1,
	},
	note: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	toggle: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		paddingVertical: space.xs,
	},
	toggleText: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	fileBox: {
		padding: space.md,
		borderRadius: radius.group,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.panel,
	},
	fileText: {
		fontFamily: monoFamily,
		fontSize: type.caption,
		color: colors.text,
	},
	editor: {
		minHeight: 220,
		maxHeight: 420,
		padding: space.md,
		borderRadius: radius.input,
		borderWidth: 1,
		borderColor: colors.borderStrong,
		backgroundColor: colors.panel,
		fontFamily: monoFamily,
		fontSize: type.caption,
		color: colors.text,
		textAlignVertical: 'top',
	},
});
