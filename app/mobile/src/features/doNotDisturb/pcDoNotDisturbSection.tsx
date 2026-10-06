// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { useAppStore, sendPcRequest, type PcSummary } from '../../appState.js';
import { haptic } from '../../haptics.js';
import { useParaToast } from '../../paraToast.js';
import { useNow } from '../../time.js';
import { ListGroup, ListRow, PickerDrawer } from '../../ui/index.js';
import { GroupHeader, GroupNote, SettingsSwitch } from '../settings/settingsScaffold.js';
import {
	DO_NOT_DISTURB_DURATION_OPTIONS,
	doNotDisturbResultText,
	doNotDisturbSetReplyState,
	doNotDisturbSetRequest,
	isDoNotDisturbOn,
	newDoNotDisturbOpId,
	pcDoNotDisturbRow,
	type DoNotDisturbDuration,
	type PcDoNotDisturb,
} from './pcDoNotDisturb.js';

/** PC の応答を待つ長さ。過ぎたら「確認できませんでした」と出し、勝手に送り直さない。 */
const SET_TIMEOUT_MS = 10_000;

/** 応答で受け取った状態。PC からの State がそれと違う値に変わるまで表示に使う（送り直しが届く前のちらつきを防ぐ）。 */
interface AppliedOverride {
	readonly state: PcDoNotDisturb;
	/** 送った時点で PC から届いていた状態（これが変わったら PC の最新値に従う）。 */
	readonly base: PcDoNotDisturb | undefined;
	/** 応答を受けた時刻。{@link APPLIED_OVERRIDE_MS} を過ぎたら PC の値に従う（押し出しを取りこぼしても固まらない）。 */
	readonly at: number;
}

/** 応答で覚えた状態を表示に使う長さ。PC の押し出しは普通これより十分早く届く。 */
const APPLIED_OVERRIDE_MS = 5_000;

function sameState(a: PcDoNotDisturb | undefined, b: PcDoNotDisturb | undefined): boolean {
	return a?.enabled === b?.enabled && a?.until === b?.until;
}

function isConnected(pc: PcSummary): boolean {
	return pc.connection === 'online' && pc.pcOnline && !pc.pairingRejected && pc.updateRequired === undefined;
}

/**
 * 設定 →「通知と音声」の「PC のおやすみモード」（Q253 B、モックの案 B）。ペアリング済みの PC ごとに 1 行。
 *
 * - 対応している PC（`notify.dnd-remote.v1`）だけにスイッチを出し、古い PC には更新の案内を出す（Q256）
 * - 入れるときは期限を選ぶシート（PC と同じ 4 つ）、切るときはすぐ送る
 * - 状態は PC から押し出された最新値（PC で切り替えても追う）。つながっていない PC は押せない
 */
export function PcDoNotDisturbSection() {
	const pcs = useAppStore(s => s.pcs);
	const now = useNow(30_000);
	const [pickerPcId, setPickerPcId] = useState<string | undefined>(undefined);
	// 閉じるアニメーションの間も説明文を残すため、最後に開いた PC の名前を持つ
	const [pickerPcName, setPickerPcName] = useState<string | undefined>(undefined);
	const [lastDuration, setLastDuration] = useState<DoNotDisturbDuration | undefined>(undefined);
	const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
	const [applied, setApplied] = useState<Readonly<Record<string, AppliedOverride>>>({});

	// PC から届いた値が送った時点から変わったら、応答で覚えた値は捨てる（PC の最新値が正）
	useEffect(() => {
		setApplied(current => {
			const next = Object.fromEntries(Object.entries(current).filter(([pcId, override]) => sameState(pcs.find(pc => pc.id === pcId)?.doNotDisturb, override.base)));
			return Object.keys(next).length === Object.keys(current).length ? current : next;
		});
	}, [pcs]);

	if (pcs.length === 0) {
		return null;
	}

	const stateOf = (pc: PcSummary): PcDoNotDisturb | undefined => {
		const override = applied[pc.id];
		return override !== undefined && Date.now() - override.at < APPLIED_OVERRIDE_MS ? override.state : pc.doNotDisturb;
	};

	const send = (pc: PcSummary, duration: DoNotDisturbDuration | undefined) => {
		const base = pc.doNotDisturb;
		setPending(current => new Set(current).add(pc.id));
		sendPcRequest(pc.id, 'fs', doNotDisturbSetRequest(newDoNotDisturbOpId(), duration), { timeoutMs: SET_TIMEOUT_MS })
			.then(reply => {
				const state = doNotDisturbSetReplyState(reply);
				if (state === undefined) {
					throw new Error('empty dndSet reply');
				}
				const at = Date.now();
				setApplied(current => ({ ...current, [pc.id]: { state, base, at } }));
				// 期限が来たら捨てて描き直す（PC の押し出しを取りこぼしても応答の値で固まらない）
				setTimeout(() => setApplied(current => {
					if (current[pc.id]?.at !== at) {
						return current;
					}
					const { [pc.id]: _expired, ...rest } = current;
					return rest;
				}), APPLIED_OVERRIDE_MS);
				const result = doNotDisturbResultText(pc.name, state, Date.now());
				haptic('success');
				useParaToast.getState().show({ key: `dnd-${pc.id}`, text: result.text, ...(result.sub !== undefined ? { sub: result.sub } : {}), icon: isDoNotDisturbOn(state, Date.now()) ? 'moon-outline' : 'notifications-outline', tone: 'done' }, 3_000);
			})
			.catch(() => {
				haptic('warning');
				useParaToast.getState().show({ key: `dnd-${pc.id}`, text: '確認できませんでした', sub: `${pc.name} のおやすみモードは PC で確かめてください`, icon: 'alert-circle-outline', tone: 'warn' }, 3_500);
			})
			.finally(() => {
				setPending(current => {
					const next = new Set(current);
					next.delete(pc.id);
					return next;
				});
			});
	};

	const pickerPc = pcs.find(pc => pc.id === pickerPcId);

	return (
		<>
			<GroupHeader title="PC のおやすみモード" first />
			<ListGroup>
				{pcs.map(pc => {
					const row = pcDoNotDisturbRow({ supported: pc.remoteDoNotDisturb, connected: isConnected(pc), state: stateOf(pc), pending: pending.has(pc.id) }, now);
					return (
						<ListRow
							key={pc.id}
							label={pc.name}
							hint={row.hint}
							value={row.showSwitch ? undefined : row.value}
							trailing={row.showSwitch
								? (
									<SettingsSwitch
										value={row.on}
										disabled={row.disabled}
										onValueChange={next => {
											if (next) {
												haptic('move');
												setPickerPcId(pc.id);
												setPickerPcName(pc.name);
											} else {
												send(pc, undefined);
											}
										}}
										accessibilityLabel={`${pc.name} のおやすみモード`}
										accessibilityHint={row.disabled ? row.hint : undefined}
									/>
								)
								: 'none'}
						/>
					);
				})}
			</ListGroup>
			<GroupNote after>PC の通知音・デスクトップ通知・読み上げを止めます。この端末へのプッシュは止まりません。</GroupNote>
			<PickerDrawer
				visible={pickerPc !== undefined}
				title="いつまで止めますか"
				message={pickerPcName !== undefined ? `${pickerPcName} の通知音・デスクトップ通知・読み上げを止めます` : undefined}
				options={DO_NOT_DISTURB_DURATION_OPTIONS}
				selected={lastDuration}
				onSelect={duration => {
					setLastDuration(duration);
					if (pickerPc !== undefined) {
						send(pickerPc, duration);
					}
				}}
				onClose={() => setPickerPcId(undefined)}
			/>
		</>
	);
}
