// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { CircleAlert, CircleCheck, RotateCw } from 'lucide-react-native';
import { canRetrySubmission, type AnswerSubmissionState } from '../../components/answerSubmission.js';
import { haptic } from '../../haptics.js';
import { HIT_SIZE, colors, space, type } from '../../theme.js';
import { useChatIconSize, useChatStyles } from '../../ui/chatTextScale.js';
import { Button, Icon, iconSize } from '../../ui/index.js';

/**
 * 回答カードの送信後の表示（状態の決まりは既存の `answerSubmission.ts`。ここは見た目だけ）。
 *  - 送信中〜PC の応答待ち: 「送信済み・PC の応答を待っています」
 *  - 送信中のまま時間切れ: 「PC から応答がありません」と「選び直す」「再送」
 *  - PC が受け付けたあとに時間切れ: 再送は出さず PC での確認を促す（二重に入力されるため）
 */
export function SubmissionStatus({ state, onRetry, onReselect }: {
	state: AnswerSubmissionState;
	onRetry: () => void;
	onReselect: () => void;
}) {
	const styles = useChatStyles(baseStyles);
	const statusIconSize = useChatIconSize(iconSize.md);
	if (state.phase === 'idle') {
		return null;
	}
	if (state.phase === 'acceptedNoResponse') {
		return (
			<View style={styles.block} accessibilityLiveRegion="polite">
				<View style={styles.row}>
					<Icon icon={CircleCheck} size={statusIconSize} color={colors.textDim} />
					<Text style={styles.title}>PC は受け付けました</Text>
				</View>
				<Text style={styles.hint}>PC の画面で確認してください。</Text>
			</View>
		);
	}
	if (canRetrySubmission(state)) {
		return (
			<View style={styles.block} accessibilityLiveRegion="polite">
				<View style={styles.row}>
					<Icon icon={CircleAlert} size={statusIconSize} color={colors.amber} />
					<Text style={styles.title}>PC から応答がありません</Text>
				</View>
				<Text style={styles.hint}>PC に届いていない可能性があります。再送するか、PC の画面で確認してください。</Text>
				<View style={styles.buttons}>
					<Button label="選び直す" variant="secondary" style={styles.flex} onPress={() => { haptic('move'); onReselect(); }} />
					<Button label="再送" icon={RotateCw} style={styles.flex} onPress={() => { haptic('commit'); onRetry(); }} />
				</View>
			</View>
		);
	}
	return (
		<View style={styles.row} accessibilityLiveRegion="polite">
			<ActivityIndicator size="small" color={colors.textDim} />
			<Text style={styles.title}>{state.phase === 'sending' ? '送信しています…' : '送信済み・PC の応答を待っています'}</Text>
		</View>
	);
}

const baseStyles = StyleSheet.create({
	block: { gap: space.sm },
	row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: HIT_SIZE },
	title: { flexShrink: 1, fontSize: type.body, fontWeight: '600', color: colors.text },
	hint: { fontSize: type.meta, lineHeight: 17, color: colors.textDim },
	buttons: { flexDirection: 'row', gap: space.sm },
	flex: { flex: 1 },
});
