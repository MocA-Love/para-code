// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Archive, CheckCheck, Folder, GitBranch, NotebookPen, Pencil, Pin, PinOff, Trash2 } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../appState.js';
import { resetDetailColumnFor } from '../../ipad/detailColumn.js';
import { isAgentWaiting, pinKeyForTerminal } from '../../store.js';
import { useParaToast } from '../../paraToast.js';
import { routes, type RouteHref } from '../../routes.js';
import { ActionSheet, ConfirmDrawer, TextInputDrawer, type ActionSheetAction } from '../../ui/index.js';

/** 長押し・⋯ の操作の対象（行1つ）。 */
export interface RowActionTarget {
	readonly terminalKey: string;
	readonly title: string;
	readonly agent: boolean;
	readonly agentStatus: string | undefined;
	readonly pinned: boolean;
	readonly spaceId: string | undefined;
	readonly spaceName: string | undefined;
	readonly branch: string | undefined;
}

/** アーカイブの「元に戻す」を出しておく時間（旧ホームと同じ）。 */
const UNDO_ARCHIVE_MS = 6_000;

/**
 * 行の長押しと ⋯ で開く操作のシート（モックの「行の長押しメニュー」、Orca の ActionSheetModal）と、
 * そこから開く名前の変更・削除の確認。操作はすべて既存のストアの処理（renameTerminal・togglePin・
 * ackAgentStatus・setArchived・closeTerminal）を呼ぶ。
 *
 * シートは木から外さず `visible` を切り替える。次のシートを開くのは ActionSheet が閉じ切った後
 * （`onPress` は既定で閉じた後に呼ばれる）。
 */
export function RowActions({ pcId, target, onClose }: {
	pcId: string | undefined;
	/** 開いている対象。undefined なら閉じている。 */
	target: RowActionTarget | undefined;
	onClose: () => void;
}) {
	const router = useRouter();
	const { renameTerminal, togglePin, ackAgentStatus, setArchived, closeTerminal } = useAppStore(useShallow(s => ({
		renameTerminal: s.renameTerminal, togglePin: s.togglePin, ackAgentStatus: s.ackAgentStatus,
		setArchived: s.setArchived, closeTerminal: s.closeTerminal,
	})));
	// シートを閉じても、名前の変更・削除の確認のために対象を持ち続ける。
	const [held, setHeld] = useState<RowActionTarget | undefined>(target);
	if (target !== undefined && target !== held) {
		setHeld(target);
	}
	const [renaming, setRenaming] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const toast = useParaToast(s => s.show);

	// 2列では詳細の列を積み増さず入れ替える（行を押してセッションを開くときと同じ。`openSession` を参照）。
	const openInDetail = (href: RouteHref) => {
		if (pcId !== undefined) {
			resetDetailColumnFor(pcId);
		}
		router.push(href);
	};

	const actions: ActionSheetAction[] = [];
	if (held !== undefined) {
		const key = pinKeyForTerminal(held);
		const waiting = held.agent && isAgentWaiting(held.agentStatus);
		const { spaceId } = held;
		if (pcId !== undefined && spaceId !== undefined) {
			actions.push(
				{ label: 'ソース管理', icon: GitBranch, onPress: () => openInDetail(routes.sourceControl(pcId, spaceId)) },
				{ label: 'ファイル', icon: Folder, onPress: () => openInDetail(routes.files(pcId, spaceId)) },
				{ label: 'メモ', hint: held.spaceName !== undefined ? `${held.spaceName} のメモ` : 'このスペースのメモ', icon: NotebookPen, onPress: () => openInDetail(routes.note(pcId, spaceId)) },
			);
		}
		actions.push(
			{
				label: '確認済みにする',
				icon: CheckCheck,
				// 既読の概念があるのは未確認だけ（実行中・待機に確認するものは無く、要対応は答えて解消する）。
				disabled: held.agentStatus !== 'review',
				onPress: () => {
					ackAgentStatus(held.terminalKey);
					toast({ key: 'row-ack', text: '確認済みにしました', icon: 'checkmark-circle', tone: 'done' }, 1_900);
				},
			},
			{
				label: held.pinned ? 'ピン留めを外す' : 'ピン留め',
				icon: held.pinned ? PinOff : Pin,
				onPress: () => {
					togglePin(key);
					toast({ key: 'row-pin', text: held.pinned ? 'ピン留めを外しました' : 'ピン留めしました', icon: 'pin-outline', tone: 'done' }, 1_900);
				},
			},
			{ label: '名前を変更', icon: Pencil, onPress: () => setRenaming(true) },
			{
				label: 'アーカイブ',
				icon: Archive,
				// 要対応はアーカイブしてもすぐ一覧へ戻る（archivedAgents.ts）ので、押せても意味が無い。
				hint: waiting ? '要対応のあいだはアーカイブできません' : 'PC ではそのまま動き続けます',
				disabled: waiting,
				onPress: () => {
					setArchived(key, true);
					toast({
						key: 'row-archive',
						text: `「${held.title}」をアーカイブしました`,
						icon: 'file-tray-full-outline',
						tone: 'done',
						action: { label: '元に戻す', onPress: () => setArchived(key, false) },
					}, UNDO_ARCHIVE_MS);
				},
			},
			{ label: '削除', icon: Trash2, destructive: true, onPress: () => setConfirmingDelete(true) },
		);
	}

	const caption = held !== undefined
		? [held.spaceName, held.branch].filter((part): part is string => part !== undefined && part.length > 0).join(' · ')
		: undefined;

	return (
		<>
			<ActionSheet
				visible={target !== undefined}
				title={held?.title}
				message={caption !== undefined && caption.length > 0 ? caption : undefined}
				actions={actions}
				onClose={onClose}
			/>
			<TextInputDrawer
				visible={renaming}
				title={held?.agent === true ? 'エージェントの名前を変更' : 'ターミナルの名前を変更'}
				defaultValue={held?.title ?? ''}
				onSubmit={name => {
					if (held !== undefined) {
						renameTerminal(held.terminalKey, name);
					}
				}}
				onClose={() => setRenaming(false)}
			/>
			<ConfirmDrawer
				visible={confirmingDelete}
				title={held?.agent === true ? 'エージェントを削除しますか？' : 'ターミナルを閉じますか？'}
				message={held !== undefined ? `「${held.title}」を PC のターミナルごと閉じます。元に戻せません。` : undefined}
				confirmLabel="削除"
				onConfirm={() => {
					if (held !== undefined) {
						closeTerminal(held.terminalKey);
					}
				}}
				onClose={() => setConfirmingDelete(false)}
			/>
		</>
	);
}
