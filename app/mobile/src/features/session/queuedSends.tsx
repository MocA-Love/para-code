// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { agentSendResumeTarget, agentSendStatusText, type AgentSendQueueItem } from '../../agentSessions.js';
import { confirmResumeAndSend, mobileSpaceIdFor, removeAgentSend, retryAgentSend, sendToLiveTerminal, useAgentSendQueue } from '../../agentSendQueue.js';
import { useAppStore } from '../../appState.js';
import { hapticSelection, hapticSuccess, hapticWarning } from '../../haptics.js';
import { routes } from '../../routes.js';
import { colors, radius, space, type } from '../../theme.js';
import { BottomDrawer, Button, DrawerCaption, DrawerTitle } from '../../ui/index.js';

/** 行の点の大きさ。 */
const DOT = 8;

/**
 * PC に届かない間に預かった送信（W2-29）の帯。押すと一覧のシートを開く。預かりが無ければ何も出さない。
 * `terminalKey` を渡すとそのターミナル宛てだけ、`ws` を渡すとそのスペース宛てだけを数える。
 */
export function QueuedSendsBanner({ pcId, terminalKey, ws }: { pcId: string | undefined; terminalKey?: string; ws?: string }) {
	const items = useAgentSendQueue(useShallow(state => state.items.filter(item => item.pcId === pcId
		&& (terminalKey === undefined || (item.target.kind === 'live' && item.target.terminalKey === terminalKey))
		&& (ws === undefined || item.target.ws === ws))));
	const [open, setOpen] = useState(false);
	const summary = useMemo(() => {
		const attention = items.filter(item => item.status !== 'waiting' && item.status !== 'sending').length;
		return attention > 0 ? `確認が必要な送信 ${attention} 件` : `PC に届き次第送る ${items.length} 件`;
	}, [items]);
	if (items.length === 0 || pcId === undefined) {
		return null;
	}
	const attention = items.some(item => item.status !== 'waiting' && item.status !== 'sending');
	return (
		<>
			<Pressable
				style={styles.banner}
				onPress={() => { hapticSelection(); setOpen(true); }}
				accessibilityRole="button"
				accessibilityLabel={`${summary}。一覧を開く`}
			>
				<View style={[styles.dot, { backgroundColor: attention ? colors.red : colors.yellow }]} />
				<Text style={styles.bannerText}>{summary}</Text>
			</Pressable>
			<QueuedSendsDrawer visible={open} pcId={pcId} items={items} onClose={() => setOpen(false)} />
		</>
	);
}

function QueuedSendsDrawer({ visible, pcId, items, onClose }: { visible: boolean; pcId: string; items: readonly AgentSendQueueItem[]; onClose: () => void }) {
	const router = useRouter();
	const [busy, setBusy] = useState<string | undefined>(undefined);
	const [message, setMessage] = useState<string | undefined>(undefined);
	// 宛先のエージェントのターミナルが今も開いているもの（「このターミナルへ送る」を出す）。
	const openAgentTerminals = useAppStore(useShallow(state => (state.workspace?.terminals ?? []).filter(terminal => terminal.agent === true).map(terminal => terminal.terminalKey)));
	const sendHere = async (item: AgentSendQueueItem) => {
		setBusy(item.id);
		setMessage(undefined);
		await sendToLiveTerminal(item, true);
		setBusy(undefined);
		hapticSelection();
	};
	const resume = async (item: AgentSendQueueItem) => {
		const target = agentSendResumeTarget(item);
		if (target === undefined) {
			return;
		}
		setBusy(item.id);
		setMessage(undefined);
		const result = await confirmResumeAndSend(item);
		setBusy(undefined);
		if (result === undefined) {
			hapticWarning();
			return;
		}
		hapticSuccess();
		if (result.message !== undefined) {
			setMessage(result.message);
		}
		const spaceId = mobileSpaceIdFor(target.ws);
		if (result.terminalKey !== undefined && result.status !== 'running' && spaceId !== undefined) {
			onClose();
			router.push(routes.session(pcId, spaceId, { tab: { kind: 'terminal', terminalKey: result.terminalKey } }));
		}
	};
	return (
		<BottomDrawer visible={visible} onClose={onClose} accessibilityLabel="預かっている送信">
			<DrawerTitle title="預かっている送信" />
			<DrawerCaption message="PC に届かない間に送ったものです。ターミナルが閉じていたものと過去の会話宛てのものは、会話を再開して送るか確かめてから送ります。24 時間を過ぎたものは送りません。" />
			{message !== undefined ? <Text style={styles.message}>{message}</Text> : null}
			<View style={styles.list}>
				{items.map(item => {
					const resumable = agentSendResumeTarget(item) !== undefined;
					const terminalOpen = item.target.kind === 'live' && openAgentTerminals.includes(item.target.terminalKey);
					return (
						<View key={item.id} style={styles.row}>
							{item.target.title !== undefined ? <Text style={styles.target} numberOfLines={1}>{item.target.title}</Text> : null}
							<Text style={styles.body} numberOfLines={4} selectable>{item.text}</Text>
							<Text style={[styles.status, item.status === 'failed' || item.status === 'expired' ? styles.statusError : undefined]}>{agentSendStatusText(item)}</Text>
							<View style={styles.actions}>
								{item.status === 'needs-confirm' && terminalOpen ? (
									<Button label="このターミナルへ送る" size="sm" loading={busy === item.id} disabled={busy !== undefined} onPress={() => { void sendHere(item); }} />
								) : null}
								{((item.status === 'needs-confirm' && resumable && (item.reason !== 'stale' || !terminalOpen)) || (item.status === 'failed' && resumable && item.target.kind === 'resume')) ? (
									<Button label="再開して送る" size="sm" variant={item.status === 'needs-confirm' && terminalOpen ? 'secondary' : 'primary'} loading={busy === item.id && !terminalOpen} disabled={busy !== undefined} onPress={() => { void resume(item); }} />
								) : null}
								{item.status === 'failed' && item.target.kind === 'live' ? (
									<Button label="もう一度送る" size="sm" variant="secondary" disabled={busy !== undefined} onPress={() => { hapticSelection(); retryAgentSend(pcId, item.id); }} />
								) : null}
								{/* 送っている最中は取り消せない（一覧から消しても PC への送信は止まらず、取り消したと誤解させる）。 */}
								<Button label={item.status === 'expired' ? '消す' : '取り消す'} size="sm" variant="ghost" disabled={busy === item.id || item.status === 'sending'} onPress={() => { hapticSelection(); removeAgentSend(pcId, item.id); }} />
							</View>
						</View>
					);
				})}
			</View>
		</BottomDrawer>
	);
}

const styles = StyleSheet.create({
	banner: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		paddingHorizontal: space.lg,
		paddingVertical: space.xs,
		minHeight: 32,
	},
	dot: {
		width: DOT,
		height: DOT,
		borderRadius: radius.pill,
	},
	bannerText: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.textDim,
	},
	message: {
		fontSize: type.meta,
		color: colors.textDim,
		paddingBottom: space.sm,
	},
	list: {
		gap: space.sm,
	},
	row: {
		gap: space.xs,
		padding: space.md,
		borderRadius: radius.group,
		backgroundColor: colors.panel,
	},
	target: {
		fontSize: type.caption,
		fontWeight: '600',
		color: colors.textMuted,
	},
	body: {
		fontSize: type.body,
		color: colors.text,
	},
	status: {
		fontSize: type.meta,
		color: colors.textDim,
	},
	statusError: {
		color: colors.red,
	},
	actions: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.sm,
		paddingTop: space.xs,
	},
});
