// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, View } from 'react-native';
import { SquareTerminal } from 'lucide-react-native';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { colors } from '../theme.js';
import { EmptyState } from '../ui/index.js';

/**
 * iPad の2列で、右の列にまだ何も開いていないときの表示（モックの「エージェントが開かれていません」）。
 */
export function DetailPlaceholder() {
	const insets = useStableInsets();
	return (
		<View style={[styles.root, { paddingTop: insets.top }]}>
			<EmptyState
				icon={SquareTerminal}
				title="エージェントが開かれていません"
				body={'左の一覧から選ぶと、ここに会話とターミナルが開きます。\n外付けキーボードでは ⌥⌘↓ で上から順に開けます。'}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	root: {
		flex: 1,
		backgroundColor: colors.bg,
	},
});
