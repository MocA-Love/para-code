// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { ArrowLeftRight, Pencil, RefreshCw, Trash2, Unplug } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../appState.js';
import { useParaToast } from '../../paraToast.js';
import { ActionSheet, ConfirmDrawer, TextInputDrawer, connectionKind, type ActionSheetAction } from '../../ui/index.js';
import { useLastSession } from './lastSessionStore.js';
import { usePcListView } from '../pc/pcListViewStore.js';

/**
 * PC のカードの ⋮ と長押しで開く PC のメニュー（モックの `hostMenu`）と、そこから開く名前の変更・
 * ペアリング解除の確認。操作は既存のストアの処理（switchPc・connectRelay・disconnectRelay・
 * renamePc・removePc）を呼ぶ。
 */
export function PcActions({ pcId, onClose }: {
	/** 開いている PC。undefined なら閉じている。 */
	pcId: string | undefined;
	onClose: () => void;
}) {
	const { pcs, activePcId, keepBackgroundPcs, switchPc, connectRelay, disconnectRelay, renamePc, removePc } = useAppStore(useShallow(s => ({
		pcs: s.pcs, activePcId: s.activePcId, keepBackgroundPcs: s.keepBackgroundPcs, switchPc: s.switchPc,
		connectRelay: s.connectRelay, disconnectRelay: s.disconnectRelay, renamePc: s.renamePc, removePc: s.removePc,
	})));
	const toast = useParaToast(s => s.show);
	// シートを閉じても、名前の変更・解除の確認のために対象を持ち続ける。
	const [heldId, setHeldId] = useState<string | undefined>(pcId);
	if (pcId !== undefined && pcId !== heldId) {
		setHeldId(pcId);
	}
	const [renaming, setRenaming] = useState(false);
	const [confirmingRemove, setConfirmingRemove] = useState(false);
	const pc = pcs.find(item => item.id === heldId);
	const kind = pc !== undefined ? connectionKind(pc.connection, pc.pcOnline) : 'offline';
	const active = pc !== undefined && pc.id === activePcId;

	const actions: ActionSheetAction[] = pc === undefined ? [] : [
		{
			label: active ? '表示中の PC' : 'この PC に切り替える',
			icon: ArrowLeftRight,
			hint: active ? undefined : '使用量と新しいスペースの作成先がこの PC になります',
			disabled: active,
			onPress: () => switchPc(pc.id),
		},
		{
			label: kind === 'connected' ? '再接続' : '今すぐ再接続',
			icon: RefreshCw,
			onPress: () => {
				// 見ていない PC とは接続を保たない設定なら、つなぐにはその PC へ切り替える必要がある。
				if (!active && !keepBackgroundPcs) {
					switchPc(pc.id);
				}
				connectRelay();
				toast({ key: 'pc-reconnect', text: `${pc.name} に再接続しています…`, icon: 'refresh-outline', tone: 'info' }, 2_500);
			},
		},
		{
			label: '切断',
			icon: Unplug,
			hint: 'すべての PC との接続を止めます',
			disabled: kind !== 'connected',
			onPress: () => disconnectRelay(),
		},
		{ label: '名前を変更', icon: Pencil, onPress: () => setRenaming(true) },
		{ label: 'ペアリングを解除', icon: Trash2, destructive: true, onPress: () => setConfirmingRemove(true) },
	];

	return (
		<>
			<ActionSheet
				visible={pcId !== undefined}
				title={pc?.name}
				message={pc !== undefined ? (active ? '表示中' : undefined) : undefined}
				actions={actions}
				onClose={onClose}
			/>
			<TextInputDrawer
				visible={renaming}
				title="PC の名前を変更"
				message="この端末の一覧に出す名前です。PC 側の設定は変わりません。"
				defaultValue={pc?.name ?? ''}
				onSubmit={name => {
					if (pc === undefined) {
						return;
					}
					renamePc(pc.id, name).catch((error: unknown) => {
						toast({ key: 'pc-rename', text: '名前を変更できませんでした', sub: error instanceof Error ? error.message : String(error), icon: 'alert-circle', tone: 'warn' }, 4_000);
					});
				}}
				onClose={() => setRenaming(false)}
			/>
			<ConfirmDrawer
				visible={confirmingRemove}
				title="ペアリングを解除しますか？"
				message={pc !== undefined ? `${pc.name} とのペアリング情報を削除します。もう一度つなぐには、PC で QR コードを出してペアリングし直します。` : undefined}
				confirmLabel="解除する"
				onConfirm={() => {
					if (pc === undefined) {
						return;
					}
					if (useLastSession.getState().value?.pcId === pc.id) {
						useLastSession.getState().clear();
					}
					usePcListView.getState().forgetPc(pc.id);
					removePc(pc.id).catch((error: unknown) => {
						toast({ key: 'pc-remove', text: 'ペアリングを解除できませんでした', sub: error instanceof Error ? error.message : String(error), icon: 'alert-circle', tone: 'warn' }, 4_000);
					});
				}}
				onClose={() => setConfirmingRemove(false)}
			/>
		</>
	);
}
