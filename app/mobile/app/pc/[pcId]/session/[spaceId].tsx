// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Construction, Folder, GitBranch, GitCompare, SquareTerminal, Sparkles } from 'lucide-react-native';
import { useSessionRoute } from '../../../../src/hooks/useRouteTargets.js';
import { encodeSessionTab, routes } from '../../../../src/routes.js';
import { space } from '../../../../src/theme.js';
import {
	AgentStateDot,
	EmptyState,
	HeaderButton,
	HeaderMetaText,
	ListGroup,
	ListRow,
	Screen,
	ScreenHeader,
	SectionHeader,
	StatusDot,
	agentKindFromStatus,
	connectionKind,
} from '../../../../src/ui/index.js';

/**
 * セッション（`/pc/[pcId]/session/[spaceId]?tab=…`）。**段階2の仮の画面**で、段階4の担当が
 * Orca の session（タブの列・会話表示とターミナル表示・コマンドドック・クイックコマンド・回答カード）に
 * 作り直す。いまはルートの読み方（`useSessionRoute`）とタブの切り替え（クエリの差し替え）を示すだけ。
 */
export default function SessionScreen() {
	const router = useRouter();
	const route = useSessionRoute();
	const { pcId, spaceId, pc, space: workspaceSpace, terminals, tab } = route;
	const current = tab.status === 'terminal' ? tab.terminal.terminalKey : undefined;
	return (
		<Screen>
			<ScreenHeader
				variant="session"
				surface="panel"
				title={workspaceSpace?.name ?? 'セッション'}
				meta={(
					<>
						<StatusDot kind={pc !== undefined ? connectionKind(pc.connection, pc.pcOnline) : 'offline'} />
						<HeaderMetaText>{`${terminals.length} タブ · ${pc?.name ?? ''}`}</HeaderMetaText>
					</>
				)}
				right={pcId !== undefined && spaceId !== undefined ? (
					<>
						<HeaderButton icon={Folder} label="ファイル" onPress={() => router.push(routes.files(pcId, spaceId))} />
						<HeaderButton icon={GitBranch} label="ソース管理" onPress={() => router.push(routes.sourceControl(pcId, spaceId))} />
						<HeaderButton icon={GitCompare} label="差分レビュー" onPress={() => router.push(routes.review(pcId, spaceId))} />
					</>
				) : undefined}
			/>
			{route.status === 'unknown' || route.spaceStatus === 'missing' ? (
				<EmptyState title="スペースが見つかりません" body="PC で閉じられたか、ペアリングを解除した PC のスペースかもしれません。" />
			) : (
				<ScrollView contentContainerStyle={styles.body}>
					<EmptyState icon={Construction} title="作成中" body={`セッションは作り直しの途中です。\n開くタブ: ${tab.status === 'terminal' ? tab.terminal.title : tab.status}`} style={styles.placeholder} />
					<SectionHeader title="タブ" count={terminals.length} />
					<ListGroup>
						{terminals.map(terminal => (
							<ListRow
								key={terminal.terminalKey}
								icon={terminal.agent === true ? Sparkles : SquareTerminal}
								leading={terminal.agent === true ? <AgentStateDot kind={agentKindFromStatus(terminal.agentStatus)} /> : undefined}
								label={terminal.title}
								selected={terminal.terminalKey === current}
								trailing={terminal.terminalKey === current ? 'check' : 'none'}
								onPress={() => router.setParams({ tab: encodeSessionTab({ kind: 'terminal', terminalKey: terminal.terminalKey }) })}
							/>
						))}
					</ListGroup>
				</ScrollView>
			)}
		</Screen>
	);
}

const styles = StyleSheet.create({
	body: {
		padding: space.lg,
	},
	placeholder: {
		flex: 0,
		marginBottom: space.xl,
	},
});
