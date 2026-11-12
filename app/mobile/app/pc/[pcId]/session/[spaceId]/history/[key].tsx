// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CircleAlert } from 'lucide-react-native';
import { AGENT_RESUME_CAPABILITY, AGENT_RESUME_PROMPT_LIMIT, parseAgentPastSessionPreview, type AgentPastSessionPreview } from '../../../../../../src/agentSessions.js';
import { enqueueAgentSend, resumeAndSend, useAgentSendLive, type AgentResumeCodexAccount } from '../../../../../../src/agentSendQueue.js';
import { sendPcRequest, useAppStore } from '../../../../../../src/appState.js';
import { scaleChatStyles } from '../../../../../../src/chatTextScale.js';
import { MarkdownText } from '../../../../../../src/components/markdownText.js';
import { ChatTextScaleProvider, useChatTextScaleFor } from '../../../../../../src/ui/chatTextScale.js';
import { useParaToast } from '../../../../../../src/paraToast.js';
import { CenterSpinner, useReadableColumn } from '../../../../../../src/features/code/codeParts.js';
import { MessageContextMenu, chatTextSelectable } from '../../../../../../src/features/session/messageContextMenu.js';
import { QueuedSendsBanner } from '../../../../../../src/features/session/queuedSends.js';
import { haptic } from '../../../../../../src/haptics.js';
import { paraAlert } from '../../../../../../src/paraAlert.js';
import { usePcCapability } from '../../../../../../src/hooks/usePcCapability.js';
import { useRouteSpace } from '../../../../../../src/hooks/useRouteTargets.js';
import { useStableInsets } from '../../../../../../src/hooks/useStableInsets.js';
import { firstParam, routes } from '../../../../../../src/routes.js';
import { colors, radius, space, type } from '../../../../../../src/theme.js';
import { formatRelativeTime, useNow } from '../../../../../../src/time.js';
import { Button, EmptyState, Screen, ScreenHeader } from '../../../../../../src/ui/index.js';

/**
 * 過去の会話 1 つ（`/pc/[pcId]/session/[spaceId]/history/[key]`、W2-29）。
 *
 * 会話の中身を読み、下の入力欄から続きを頼める。［再開して送る］で PC が裏で会話を再開し（PC の画面のスペースは
 * 切り替えない。権限は PC の既定）、準備ができたら依頼を渡す。PC に届かないときは、この端末に預かり
 * （24 時間まで）、つながった後に「再開して送る」を確かめてから送る。
 */
/** PC で選んでいる Codex のアカウントに無い会話を、どちらのアカウントで開くか尋ねる。やめたら undefined。 */
function chooseCodexAccount(message: string | undefined): Promise<Exclude<AgentResumeCodexAccount, 'ask'> | undefined> {
	return new Promise(resolve => {
		paraAlert.alert('前のアカウントの会話です', message, [
			{ text: '選んでいるアカウントで続ける', onPress: () => resolve('selected') },
			{ text: '前のアカウントで開く', onPress: () => resolve('previous') },
			{ text: 'やめる', style: 'cancel', onPress: () => resolve(undefined) },
		], { cancelable: true, onDismiss: () => resolve(undefined) });
	});
}

export default function AgentHistorySessionScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const column = useReadableColumn();
	const params = useLocalSearchParams<{ pcId?: string; spaceId?: string; key?: string }>();
	const route = useRouteSpace(params.pcId, params.spaceId);
	const key = firstParam(params.key);
	const supported = usePcCapability(AGENT_RESUME_CAPABILITY);
	const live = useAgentSendLive();
	// 会話の文字サイズ（設定 → チャット UI）を、発言と続きの依頼の入力欄にもかける（会話の画面と同じ倍率）。
	const chatFontSize = useAppStore(s => s.chatFontSize);
	const textStyles = scaleChatStyles(styles, useChatTextScaleFor(chatFontSize));
	const [preview, setPreview] = useState<AgentPastSessionPreview | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [text, setText] = useState('');
	const [sending, setSending] = useState(false);
	const [notice, setNotice] = useState<string | undefined>(undefined);
	// 読み直しの失敗の行の［再試行］で読んでいる間
	const [reloading, setReloading] = useState(false);
	const pcId = route.pcId;
	const spaceId = route.spaceId;
	const sourceId = route.space?.sourceId;
	const ready = route.status === 'active' && route.spaceStatus === 'ready' && supported && live;

	const load = useCallback(() => {
		if (!ready || pcId === undefined || spaceId === undefined || key === undefined) {
			return;
		}
		sendPcRequest<Record<string, unknown>>(pcId, 'scm', { t: 'agentSessionPreview', ws: spaceId, key })
			.then(reply => {
				const parsed = parseAgentPastSessionPreview(reply);
				if (parsed === undefined) {
					// 理由の欄に入る文。見出し（読み込めませんでした／読み直せませんでした）と同じ意味を重ねない
					setError('PC の応答を解釈できませんでした');
					return;
				}
				setPreview(parsed);
				setError(undefined);
			})
			.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '会話を読み込めませんでした'))
			.finally(() => setReloading(false));
	}, [ready, pcId, spaceId, key]);
	useEffect(load, [load]);

	const openTerminal = (terminalKey: string) => {
		if (pcId !== undefined && spaceId !== undefined) {
			router.replace(routes.session(pcId, spaceId, { tab: { kind: 'terminal', terminalKey } }));
		}
	};

	const send = async () => {
		const prompt = text.trim();
		if (prompt.length === 0 || pcId === undefined || sourceId === undefined || key === undefined || sending) {
			return;
		}
		setSending(true);
		setNotice(undefined);
		try {
			if (!live) {
				// PC に届かない。預かって、つながった後に「再開して送る」を確かめる（黙って再開しない）。
				await enqueueAgentSend(pcId, prompt, { kind: 'resume', ws: sourceId, key, ...(preview !== undefined ? { title: preview.session.title } : {}) });
				haptic('warning');
				setText('');
				setNotice('PC に届かないため預かりました。つながったら、再開して送るか確かめます（24 時間まで）');
				return;
			}
			let result = await resumeAndSend(pcId, sourceId, key, prompt, undefined, 'ask');
			if (result.status === 'choose-account') {
				// PC で選んでいる Codex のアカウントに無い会話。どちらのアカウントで開くかを選んでから送り直す
				const choice = await chooseCodexAccount(result.message);
				if (choice === undefined) {
					return;
				}
				result = await resumeAndSend(pcId, sourceId, key, prompt, undefined, choice);
			}
			// 依頼まで渡せたときだけ完了。会話は開けたが渡せなかった・確認待ちなどは注意として返す
			haptic(result.delivered === true ? 'success' : 'warning');
			const movedToTerminal = result.terminalKey !== undefined && result.status !== 'needs-trust';
			// 届かなかった（フォルダの信頼の確認待ちなど）ときは、入力欄の文を残す（PC で答えてから送り直せるように）
			if (result.delivered === true || movedToTerminal) {
				setText('');
			}
			if (result.terminalKey !== undefined && result.status !== 'needs-trust') {
				if (result.delivered !== true) {
					// 会話は開けたが依頼を渡せなかった・既に開いていた。開いた先の入力欄へ移して送り直してもらう。
					useAppStore.getState().setAgentDraft(result.terminalKey, prompt);
					useParaToast.getState().show({ key: `agent-resume-${key}`, text: result.message ?? '依頼は入力欄に残しました。送り直してください', icon: 'information-circle-outline', tone: 'warn' }, 6_000);
				}
				openTerminal(result.terminalKey);
				return;
			}
			setNotice(result.message ?? '会話を再開しました');
		} catch (reason) {
			haptic('error');
			setNotice(reason instanceof Error ? reason.message : '送れませんでした');
		} finally {
			setSending(false);
		}
	};

	const session = preview?.session;
	const body = (() => {
		if (!supported && route.status === 'active') {
			return <EmptyState icon={CircleAlert} title="PC の更新が必要です" body="過去の会話を開くには、PC の Para Code を最新にしてください。" />;
		}
		if (!live && preview === undefined) {
			return <EmptyState icon={CircleAlert} title="PC に接続していません" body="つながると会話の中身を読めます。続きの依頼は、下から送っておくと預かります。" />;
		}
		// 読めた会話があるときは、繋ぎ直しの読み直しに失敗しても会話を出したまま（失敗は入力欄の上に出す）
		if (error !== undefined && preview === undefined) {
			return <EmptyState icon={CircleAlert} title="会話を読み込めませんでした" body={error} action={{ label: '再読み込み', onPress: load }} />;
		}
		if (preview === undefined) {
			return <CenterSpinner label="会話を読み込んでいます…" />;
		}
		return <HistoryMessages preview={preview} chatFontSize={chatFontSize} column={column} />;
	})();

	return (
		<ChatTextScaleProvider size={chatFontSize}>
			<Screen>
				<ScreenHeader
					title={session?.title ?? '過去の会話'}
					subtitle={[session !== undefined ? (session.agent === 'opencode' ? 'OpenCode' : session.agent === 'codex' ? 'Codex' : 'Claude Code') : undefined, route.space?.name].filter(part => part !== undefined).join(' · ')}
					backLabel="過去の会話へ戻る"
				/>
				<QueuedSendsBanner pcId={pcId} ws={sourceId} />
				<KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
					<View style={styles.fill}>{body}</View>
					{supported ? (
						<View style={[styles.composer, { paddingBottom: insets.bottom + space.sm }, column]}>
							{error !== undefined && preview !== undefined ? (
								<View style={styles.reloadFailure}>
									<Text style={styles.reloadError}>最新の中身を読み直せませんでした（{error}）。表示は前に読んだときのままです{ready ? '' : '。PC とつながると読み直します'}</Text>
									<Button label="再試行" variant="secondary" size="sm" loading={reloading} disabled={!ready || reloading} onPress={() => {
										setReloading(true);
										load();
									}} />
								</View>
							) : null}
							{notice !== undefined ? <Text style={styles.notice}>{notice}</Text> : null}
							{session?.terminalKey !== undefined ? (
								<Button label="PC で開いている会話を開く" onPress={() => openTerminal(session.terminalKey!)} />
							) : (
								<>
									<TextInput
										style={textStyles.input}
										value={text}
										onChangeText={setText}
										placeholder="続きの依頼を書く"
										placeholderTextColor={colors.textMuted}
										multiline
										maxLength={AGENT_RESUME_PROMPT_LIMIT}
										accessibilityLabel="続きの依頼"
									/>
									<Button
										label={live ? '再開して送る' : 'PC に届き次第送る'}
										loading={sending}
										disabled={text.trim().length === 0 || sourceId === undefined || key === undefined}
										onPress={() => { void send(); }}
									/>
									<Text style={styles.hint}>PC で会話を裏で再開します（PC の画面は切り替えません）。権限は PC の既定のままです。</Text>
								</>
							)}
						</View>
					) : null}
				</KeyboardAvoidingView>
			</Screen>
		</ChatTextScaleProvider>
	);
}

/**
 * 過去の会話の発言の一覧（最大 200 件）。入力欄と別の部品にして memo し、続きの依頼を 1 文字打つたびに
 * 全部の発言（MarkdownText）を描き直さない。経過時間の 1 分ごとの描き直しもここだけで済ませる。
 */
const HistoryMessages = memo(function HistoryMessages({ preview, chatFontSize, column }: {
	preview: AgentPastSessionPreview;
	chatFontSize: Parameters<typeof useChatTextScaleFor>[0];
	column: StyleProp<ViewStyle>;
}) {
	const now = useNow();
	const textStyles = scaleChatStyles(styles, useChatTextScaleFor(chatFontSize));
	const session = preview.session;
	return (
		<ScrollView contentContainerStyle={[styles.content, column]} keyboardShouldPersistTaps="handled">
			{preview.truncated ? <Text style={textStyles.truncated}>古い発言は省略しています</Text> : null}
			{preview.messages.map((message, index) => (
				<View key={index} style={[textStyles.message, message.role === 'user' ? styles.user : undefined]}>
					<Text style={textStyles.role}>{message.role === 'user' ? 'あなた' : session.agent === 'opencode' ? 'OpenCode' : session.agent === 'codex' ? 'Codex' : 'Claude Code'}{message.ts !== undefined ? ` · ${formatRelativeTime(message.ts, now)}` : ''}</Text>
					{/* 長押しで会話と同じ発言のメニュー（コピー・範囲を選んでコピー・共有）。ここには入力欄への引用は無い */}
					<MessageContextMenu text={message.text} markdown={message.role === 'assistant'} plain="body" speaker={message.role === 'user' ? '自分の発言' : 'エージェントの発言'}>
						{message.role === 'assistant' ? <MarkdownText text={message.text} selectable={chatTextSelectable} /> : <Text style={textStyles.text} selectable={chatTextSelectable}>{message.text}</Text>}
					</MessageContextMenu>
				</View>
			))}
		</ScrollView>
	);
});

const styles = StyleSheet.create({
	fill: {
		flex: 1,
	},
	content: {
		paddingHorizontal: space.lg,
		paddingVertical: space.sm,
		gap: space.sm,
	},
	truncated: {
		textAlign: 'center',
		fontSize: type.caption,
		color: colors.textMuted,
	},
	message: {
		gap: space.xs,
		padding: space.md,
		borderRadius: radius.group,
		backgroundColor: colors.panel,
	},
	user: {
		backgroundColor: colors.raised,
	},
	role: {
		fontSize: type.caption,
		fontWeight: '600',
		color: colors.textMuted,
	},
	text: {
		fontSize: type.body,
		color: colors.text,
	},
	composer: {
		gap: space.sm,
		paddingHorizontal: space.lg,
		paddingTop: space.sm,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	input: {
		minHeight: 44,
		maxHeight: 160,
		paddingHorizontal: space.md,
		paddingVertical: space.sm,
		borderRadius: radius.control,
		backgroundColor: colors.panel,
		color: colors.text,
		fontSize: type.body,
	},
	notice: {
		fontSize: type.meta,
		color: colors.textDim,
	},
	hint: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	reloadFailure: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	reloadError: {
		flex: 1,
		fontSize: type.meta,
		color: colors.red,
	},
});
