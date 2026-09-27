// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Activity, EllipsisVertical, Monitor, Pencil, QrCode, SquareArrowOutUpRight, Trash2 } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { hapticImpact, hapticSelection } from '../../src/haptics.js';
import { useParaToast } from '../../src/paraToast.js';
import { routes } from '../../src/routes.js';
import { colors } from '../../src/theme.js';
import { useNow } from '../../src/time.js';
import { ActionSheet, ConfirmDrawer, Icon, ListGroup, ListRow, TextInputDrawer, type ActionSheetAction } from '../../src/ui/index.js';
import { useLastSession } from '../../src/features/home/lastSessionStore.js';
import { GroupGap, GroupHeader, GroupNote, SettingsScreen, SettingsSwitch } from '../../src/features/settings/settingsScaffold.js';
import { pcRowHint } from '../../src/features/settings/settingsSummary.js';

type Sheet = { readonly kind: 'menu' | 'rename' | 'remove'; readonly pcId: string };

function showFailure(text: string, error: unknown): void {
	useParaToast.getState().show({
		key: `pc-failure:${text}`,
		text,
		sub: error instanceof Error ? error.message : String(error),
		icon: 'alert-circle-outline',
		tone: 'warn',
	}, 4_000);
}

/**
 * PC（`/settings/pcs`。モックの「PC」、旧 設定の PC の束と PC の詳細画面）。
 *
 * ペアリング済みの PC を並べ、行（⋮）から「開く・使用量・名前を変更・ペアリングを解除」を出す
 * （旧来は名前の変更と解除を PC の詳細画面に分けていた。モックに合わせて行のメニューにまとめた）。
 * 下に「見ていない PC との接続を保つ」と「PC を追加でペアリング」。
 *
 * モックの「再接続」「切断」「ネットワーク診断」は、Para Code では PC ごとに持たない（接続・切断は
 * 端末全体の操作）ので置いていない。
 */
export default function PcSettingsScreen() {
	const router = useRouter();
	const now = useNow();
	const { pcs, activePcId, switchPc, renamePc, removePc, keepBackgroundPcs, setKeepBackgroundPcs } = useAppStore(useShallow(s => ({
		pcs: s.pcs,
		activePcId: s.activePcId,
		switchPc: s.switchPc,
		renamePc: s.renamePc,
		removePc: s.removePc,
		keepBackgroundPcs: s.keepBackgroundPcs,
		setKeepBackgroundPcs: s.setKeepBackgroundPcs,
	})));
	const [sheet, setSheet] = useState<Sheet | undefined>(undefined);
	// 閉じる動きの間も見出しや名前を出し続けるため、最後に選んだ PC を覚えておく
	const [lastPcId, setLastPcId] = useState<string | undefined>(undefined);
	const target = pcs.find(pc => pc.id === (sheet?.pcId ?? lastPcId));
	const close = () => setSheet(undefined);
	const openSheet = (next: Sheet) => {
		setLastPcId(next.pcId);
		setSheet(next);
	};

	const actions: ActionSheetAction[] = target === undefined ? [] : [
		{
			label: 'この PC を開く',
			icon: SquareArrowOutUpRight,
			onPress: () => router.push(routes.pc(target.id)),
		},
		{
			label: '使用量を見る',
			icon: Activity,
			hint: target.id === activePcId ? undefined : '見ている PC がこの PC に切り替わります',
			onPress: () => {
				// 使用量の画面は「いま見ている PC」の数字を出すので、先に切り替える（旧 PC の詳細画面と同じ）
				if (target.id !== activePcId) {
					switchPc(target.id);
				}
				router.push(routes.settings('usage'));
			},
		},
		{ label: '名前を変更', icon: Pencil, onPress: () => openSheet({ kind: 'rename', pcId: target.id }) },
		{ label: 'ペアリングを解除', icon: Trash2, destructive: true, onPress: () => openSheet({ kind: 'remove', pcId: target.id }) },
	];

	return (
		<SettingsScreen
			title="PC"
			footer={(
				<>
					<ActionSheet
						visible={sheet?.kind === 'menu'}
						title={target?.name}
						message={target !== undefined ? pcRowHint(target, target.id === activePcId, now) : undefined}
						actions={actions}
						onClose={close}
					/>
					<TextInputDrawer
						visible={sheet?.kind === 'rename'}
						title="PC の名前を変更"
						message="この端末だけで使う呼び名です（PC 側の名前より優先されます）"
						defaultValue={target?.name ?? ''}
						onSubmit={name => {
							if (target !== undefined) {
								renamePc(target.id, name).catch(error => showFailure('名前を変更できませんでした', error));
							}
						}}
						onClose={close}
					/>
					<ConfirmDrawer
						visible={sheet?.kind === 'remove'}
						title="PC のペアリングを解除しますか？"
						message={`「${target?.name ?? ''}」の接続情報をこの端末から削除します。もう一度つなぐには、PC で QR コードを出し直してペアリングします。`}
						confirmLabel="解除"
						onConfirm={() => {
							if (target !== undefined) {
								hapticImpact('medium');
								// ホームの「再開」がこの PC のセッションを指していれば消す（ホームの PC の操作と同じ）。
								if (useLastSession.getState().value?.pcId === target.id) {
									useLastSession.getState().clear();
								}
								removePc(target.id).catch(error => showFailure('ペアリングを解除できませんでした', error));
							}
						}}
						onClose={close}
					/>
				</>
			)}
		>
			{pcs.length > 0 ? (
				<ListGroup>
					{pcs.map(pc => {
						const online = pc.connection === 'online' && pc.pcOnline;
						return (
							<ListRow
								key={pc.id}
								leading={<Icon icon={Monitor} color={online ? colors.text : colors.textDim} />}
								label={pc.name}
								hint={pcRowHint(pc, pc.id === activePcId, now)}
								trailing={<Icon icon={EllipsisVertical} color={colors.textDim} />}
								accessibilityLabel={`${pc.name} の操作`}
								onPress={() => { hapticSelection(); openSheet({ kind: 'menu', pcId: pc.id }); }}
							/>
						);
					})}
				</ListGroup>
			) : null}
			{pcs.length > 0 ? <GroupGap /> : null}
			<ListGroup>
				<ListRow icon={QrCode} label="PC を追加でペアリング" trailing="chevron" onPress={() => { hapticSelection(); router.push(routes.pair()); }} />
			</ListGroup>

			<GroupHeader title="接続" />
			<ListGroup>
				<ListRow
					label="見ていない PC との接続を保つ"
					hint="ほかの PC の様子も更新し続けます"
					trailing={<SettingsSwitch value={keepBackgroundPcs} onValueChange={setKeepBackgroundPcs} accessibilityLabel="見ていない PC との接続を保つ" />}
				/>
			</ListGroup>
			<GroupNote after>オフにすると通信量は減りますが、切り替えるまでほかの PC の件数は分かりません（通知は届きます）。</GroupNote>
		</SettingsScreen>
	);
}
