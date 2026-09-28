// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CircleAlert, History } from 'lucide-react-native';
import { AGENT_RESUME_CAPABILITY, parseAgentPastSessionPage, type AgentPastSession } from '../../../../../src/agentSessions.js';
import { sendPcRequest } from '../../../../../src/appState.js';
import { CenterSpinner, useReadableColumn } from '../../../../../src/features/code/codeParts.js';
import { QueuedSendsBanner } from '../../../../../src/features/session/queuedSends.js';
import { hapticSelection } from '../../../../../src/haptics.js';
import { usePcCapability } from '../../../../../src/hooks/usePcCapability.js';
import { useRouteSpace } from '../../../../../src/hooks/useRouteTargets.js';
import { useStableInsets } from '../../../../../src/hooks/useStableInsets.js';
import { routes } from '../../../../../src/routes.js';
import { colors, radius, space, type } from '../../../../../src/theme.js';
import { formatRelativeTime, useNow } from '../../../../../src/time.js';
import { Button, EmptyState, ListRow, Screen, ScreenHeader } from '../../../../../src/ui/index.js';

/** 検索の入力が止まってから一覧を引き直すまで。 */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * スペースの過去の会話（`/pc/[pcId]/session/[spaceId]/history`、W2-29）。
 *
 * PC のセッション履歴と同じ一覧を新しい順に 30 件ずつ出す。押すと会話の中身を開き、そこから続きを頼める
 * （`history/[key]`）。PC で今開いている会話は、そのタブを開く（二重に再開しない）。
 */
export default function AgentHistoryScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const column = useReadableColumn();
	const now = useNow();
	const params = useLocalSearchParams<{ pcId?: string; spaceId?: string }>();
	const route = useRouteSpace(params.pcId, params.spaceId);
	const supported = usePcCapability(AGENT_RESUME_CAPABILITY);
	const [sessions, setSessions] = useState<readonly AgentPastSession[] | undefined>(undefined);
	const [nextOffset, setNextOffset] = useState<number | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [loadingMore, setLoadingMore] = useState(false);
	const [query, setQuery] = useState('');
	const requestSeq = useRef(0);
	const pcId = route.pcId;
	const spaceId = route.spaceId;
	const ready = route.status === 'active' && route.spaceStatus === 'ready' && supported;

	const load = useCallback((offset: number, search: string) => {
		if (!ready || pcId === undefined || spaceId === undefined) {
			return;
		}
		const seq = ++requestSeq.current;
		if (offset > 0) {
			setLoadingMore(true);
		}
		sendPcRequest<Record<string, unknown>>(pcId, 'scm', { t: 'agentSessions', ws: spaceId, offset, ...(search.trim().length > 0 ? { query: search.trim() } : {}) })
			.then(reply => {
				if (seq !== requestSeq.current) {
					return;
				}
				const page = parseAgentPastSessionPage(reply);
				setSessions(previous => offset === 0 || previous === undefined ? page.sessions : [...previous, ...page.sessions]);
				setNextOffset(page.nextOffset);
				setError(undefined);
			})
			.catch((reason: unknown) => {
				if (seq === requestSeq.current) {
					setError(reason instanceof Error ? reason.message : '一覧を読み込めませんでした');
				}
			})
			.finally(() => {
				if (seq === requestSeq.current) {
					setLoadingMore(false);
				}
			});
	}, [ready, pcId, spaceId]);

	useEffect(() => {
		const timer = setTimeout(() => load(0, query), query.length > 0 ? SEARCH_DEBOUNCE_MS : 0);
		return () => clearTimeout(timer);
	}, [load, query]);

	const open = (session: AgentPastSession) => {
		if (pcId === undefined || spaceId === undefined) {
			return;
		}
		hapticSelection();
		router.push(session.terminalKey !== undefined
			? routes.session(pcId, spaceId, { tab: { kind: 'terminal', terminalKey: session.terminalKey } })
			: routes.agentHistorySession(pcId, spaceId, session.key));
	};

	const body = (() => {
		if (!supported && route.status === 'active') {
			return <EmptyState icon={CircleAlert} title="PC の更新が必要です" body="過去の会話を開くには、PC の Para Code を最新にしてください。" />;
		}
		if (error !== undefined && sessions === undefined) {
			return <EmptyState icon={CircleAlert} title="一覧を読み込めませんでした" body={error} action={{ label: '再読み込み', onPress: () => load(0, query) }} />;
		}
		if (sessions === undefined) {
			return <CenterSpinner label="過去の会話を読み込んでいます…" />;
		}
		return (
			<FlatList
				data={sessions}
				keyExtractor={session => session.key}
				contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }, column]}
				keyboardShouldPersistTaps="handled"
				ItemSeparatorComponent={Separator}
				renderItem={({ item }) => (
					<View style={styles.row}>
						<ListRow
							label={item.title}
							hint={[item.agent === 'codex' ? 'Codex' : 'Claude Code', formatRelativeTime(item.updatedAt, now), item.terminalKey !== undefined ? 'PC で開いています' : undefined, item.preview].filter(part => part !== undefined).join(' · ')}
							onPress={() => open(item)}
						/>
					</View>
				)}
				ListEmptyComponent={<EmptyState icon={History} title={query.length > 0 ? '見つかりませんでした' : '過去の会話はありません'} body={query.length > 0 ? '別の言葉で探してください。' : 'このスペースで Claude Code や Codex と話すと、ここに並びます。'} />}
				ListFooterComponent={nextOffset !== undefined ? (
					<Button label="さらに読み込む" variant="secondary" loading={loadingMore} onPress={() => load(nextOffset, query)} style={styles.more} />
				) : null}
			/>
		);
	})();

	return (
		<Screen>
			<ScreenHeader title="過去の会話" subtitle={route.space?.name} backLabel="セッションへ戻る">
				<View style={[styles.searchWrap, column]}>
					<TextInput
						style={styles.search}
						value={query}
						onChangeText={setQuery}
						placeholder="題名や最後の発言で探す"
						placeholderTextColor={colors.textMuted}
						autoCorrect={false}
						autoCapitalize="none"
						clearButtonMode="while-editing"
						returnKeyType="search"
						accessibilityLabel="過去の会話を探す"
					/>
				</View>
			</ScreenHeader>
			<QueuedSendsBanner pcId={pcId} ws={route.space?.sourceId} />
			<View style={styles.fill}>{body}</View>
		</Screen>
	);
}

function Separator() {
	return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
	fill: {
		flex: 1,
	},
	content: {
		paddingHorizontal: space.lg,
		paddingTop: space.sm,
	},
	row: {
		borderRadius: radius.group,
		overflow: 'hidden',
		backgroundColor: colors.panel,
	},
	separator: {
		height: space.sm,
	},
	more: {
		marginTop: space.lg,
	},
	searchWrap: {
		paddingHorizontal: space.lg,
		paddingBottom: space.sm,
	},
	search: {
		minHeight: 36,
		paddingHorizontal: space.md,
		borderRadius: radius.control,
		backgroundColor: colors.panel,
		color: colors.text,
		fontSize: type.body,
	},
});
