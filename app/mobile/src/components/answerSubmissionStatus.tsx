// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from './button.js';
import { HIT_SIZE, colors, space, type } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';
import { canRetrySubmission, type AnswerSubmissionState } from './answerSubmission.js';

/**
 * 承認・質問カードの送信後の表示。送信中〜応答待ちは「送信済み・PC の応答を待っています」、
 * 送信中のまま待ち時間を過ぎたら「PC から応答がありません」と再送・選び直しを出す。
 * PCが受け付けたあとに待ち時間を過ぎた場合は、再送も選び直しも出さずPCでの確認を促す
 * （受け付け済みの回答を再送すると二重に入力されるため）。
 * 押せる状態へ黙って戻すことはしない（{@link ./answerSubmission.ts}）。
 */
export function AnswerSubmissionStatus({ state, onRetry, onReselect }: {
	state: AnswerSubmissionState;
	onRetry: () => void;
	/** 送信前の選択へ戻す。 */
	onReselect: () => void;
}) {
	if (state.phase === 'idle') {
		return null;
	}
	if (state.phase === 'acceptedNoResponse') {
		return (
			<View style={styles.block} accessibilityLiveRegion="polite">
				<View style={styles.row}>
					<Ionicons name="checkmark-circle-outline" size={16} color={colors.textDim} />
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
					<Ionicons name="alert-circle-outline" size={16} color={colors.yellow} />
					<Text style={styles.title}>PC から応答がありません</Text>
				</View>
				<Text style={styles.hint}>PC に届いていない可能性があります。再送するか、PC の画面で確認してください。</Text>
				<View style={styles.buttons}>
					<Button label="選び直す" variant="secondary" flex onPress={() => { hapticSelection(); onReselect(); }} />
					<Button label="再送" icon="refresh" variant="primary" flex onPress={() => { hapticImpact('medium'); onRetry(); }} />
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

const styles = StyleSheet.create({
	block: { gap: space.sm },
	row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: HIT_SIZE },
	title: { color: colors.text, fontSize: type.body, fontWeight: '600', flexShrink: 1 },
	hint: { color: colors.textDim, fontSize: type.meta, lineHeight: 17 },
	buttons: { flexDirection: 'row', gap: space.sm },
});
