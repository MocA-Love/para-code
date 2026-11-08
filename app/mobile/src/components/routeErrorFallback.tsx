// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import type { ErrorBoundaryProps } from 'expo-router';
import { CircleAlert } from 'lucide-react-native';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { useWindowControlsInset } from '../ipad/windowControls.js';
import { reportMobileDiagnosticError } from '../mobileDiagnostics.js';
import { colors } from '../theme.js';
import { EmptyState } from '../ui/index.js';

/**
 * 画面の描画中に投げられた例外を受け止めて出す画面（Expo Router のルートの `ErrorBoundary` に使う）。
 * 受け止める所が無いと、画面 1 つの例外でアプリ全体が落ちる。例外は Sentry へ送り（本文は載せない）、
 * 「再試行」でその画面を描き直す。
 */
export function RouteErrorFallback({ error, retry, where }: ErrorBoundaryProps & { readonly where: string }) {
	useEffect(() => {
		reportMobileDiagnosticError('navigation', 'route-render', error, { safe_where: where });
	}, [error, where]);
	// 自前の見出しを持たない全面の画面なので、上端のセーフエリアと iPad のウィンドウ操作ボタン（左上）を自分で避ける
	const insets = useStableInsets();
	const controlsInset = useWindowControlsInset();
	return (
		<View style={[styles.root, { paddingTop: insets.top, paddingLeft: controlsInset }]}>
			<EmptyState
				icon={CircleAlert}
				title="画面を表示できませんでした"
				body="表示の途中で問題が起きました。再試行しても直らないときは、アプリを開き直してください。"
				action={{ label: '再試行', onPress: () => { void retry(); } }}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	root: {
		flex: 1,
		backgroundColor: colors.bg,
		justifyContent: 'center',
	},
});
