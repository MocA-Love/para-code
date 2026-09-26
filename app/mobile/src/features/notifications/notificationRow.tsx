// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CircleAlert, CircleCheck, CircleHelp, Unplug } from 'lucide-react-native';
import type { NotifyKind, NotifyPayload } from '@para/protocol';
import { colors, radius, space, type } from '../../theme.js';
import { formatRelativeTime } from '../../time.js';
import { Icon, type LucideIcon } from '../../ui/index.js';
import { notificationBody, notificationTitle } from './notificationListModel.js';

/** 出来事ごとのアイコンと色（モックの通知の一覧。色は状態のときだけ: 要対応・エラー=赤、完了=緑）。 */
const KIND_ICON: Record<NotifyKind, { readonly icon: LucideIcon; readonly color: string }> = {
	'agent-question': { icon: CircleHelp, color: colors.red },
	'agent-done': { icon: CircleCheck, color: colors.green },
	'agent-error': { icon: CircleAlert, color: colors.red },
	'disconnected': { icon: Unplug, color: colors.textMuted },
};

/** アイコンの台（pt。モックの `.nicon` 32×32）。 */
const ICON_TILE = 32;

/**
 * 通知の一覧の1行（モックの `.nrow`）。左に出来事のアイコンの台、見出し（出来事 · スペース）と本文、右に時刻。
 * 押すとそのエージェントのセッション（切断の通知はその PC の画面）を開く。
 */
export function NotificationRow({ notification, now, onPress }: {
	notification: NotifyPayload;
	now: number;
	onPress: () => void;
}) {
	const kind = KIND_ICON[notification.kind] ?? KIND_ICON['agent-done'];
	const title = notificationTitle(notification);
	const body = notificationBody(notification);
	return (
		<Pressable
			onPress={onPress}
			style={({ pressed }) => [styles.row, pressed ? styles.pressed : undefined]}
			accessibilityRole="button"
			accessibilityLabel={`${title}、${body}`}
		>
			<View style={styles.icon}><Icon icon={kind.icon} color={kind.color} /></View>
			<View style={styles.body}>
				<Text style={styles.title} numberOfLines={1}>{title}</Text>
				<Text style={styles.text} numberOfLines={2}>{body}</Text>
			</View>
			<Text style={styles.time}>{formatRelativeTime(notification.at, now)}</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: space.sm + 2,
		paddingVertical: space.md,
		paddingHorizontal: space.md + 2,
	},
	pressed: {
		backgroundColor: colors.raised,
	},
	icon: {
		width: ICON_TILE,
		height: ICON_TILE,
		borderRadius: radius.row,
		backgroundColor: colors.raised,
		alignItems: 'center',
		justifyContent: 'center',
	},
	body: {
		flex: 1,
		minWidth: 0,
	},
	title: {
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
	},
	text: {
		fontSize: type.meta,
		lineHeight: 16,
		color: colors.textDim,
		marginTop: 2,
	},
	time: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
});
