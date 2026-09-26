// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../appState.js';
import { isPairingCancelled, pairingErrorMessage } from './pairingInput.js';

/**
 * ペアリング画面の進み具合。
 *  - `idle`: 読み取り・貼り付けを待っている
 *  - `connecting`: 中継サーバーへつないでいる（確認コードがまだ出ていない）
 *  - `sas`: 確認コードを出して、PC での承認を待っている
 *  - `error`: 失敗した（`message` を出して、やり直してもらう）
 */
export type PairingPhase =
	| { readonly kind: 'idle' }
	| { readonly kind: 'connecting' }
	| { readonly kind: 'sas'; readonly code: string }
	| { readonly kind: 'error'; readonly message: string };

/** PC 側の承認の画面に出る、この端末の名前（旧ペアリング画面と同じ）。 */
const DEVICE_NAME = 'モバイルデバイス';

/**
 * ペアリングを1回ずつ進めるフック。処理そのものは既存の `pairFromUri` / `cancelPairing`
 * （`src/appState.ts`）で、ここは画面の状態と、途中で離れたときの後始末だけを持つ。
 *
 *  - 画面を閉じたら進行中のペアリングを中断する（旧画面と同じ。無応答のソケットを残さず、
 *    離れた後に裏で成立してしまうのを防ぐ）
 *  - 中断・やり直しの後に遅れて届いた結果（確認コード・成功・失敗）は捨てる
 */
export function usePairingFlow(onPaired: () => void): {
	readonly phase: PairingPhase;
	/** ペアリングのリンクで始める（形の確認は呼ぶ側の `extractPairingUri`）。 */
	readonly start: (uri: string) => void;
	/** 進行中なら中断して、読み取りの状態へ戻す。 */
	readonly cancel: () => void;
	/** 失敗を出す（読み取った QR が Para Code のものでなかったなど、始める前の失敗）。 */
	readonly fail: (message: string) => void;
	/** 失敗の表示を消して、読み取りの状態へ戻す。 */
	readonly reset: () => void;
} {
	const pairFromUri = useAppStore(s => s.pairFromUri);
	const cancelPairing = useAppStore(s => s.cancelPairing);
	const [phase, setPhase] = useState<PairingPhase>({ kind: 'idle' });
	// 何回目の試みか。中断・やり直しで進め、古い試みの結果を捨てる目印にする。
	const attempt = useRef(0);

	useEffect(() => () => {
		attempt.current += 1;
		cancelPairing();
	}, [cancelPairing]);

	const start = useCallback((uri: string) => {
		attempt.current += 1;
		const id = attempt.current;
		setPhase({ kind: 'connecting' });
		pairFromUri(uri, DEVICE_NAME, code => {
			if (attempt.current === id) {
				setPhase({ kind: 'sas', code });
			}
		}).then(() => {
			if (attempt.current === id) {
				onPaired();
			}
		}, (error: unknown) => {
			if (attempt.current !== id || isPairingCancelled(error)) {
				return;
			}
			setPhase({ kind: 'error', message: pairingErrorMessage(error) });
		});
	}, [pairFromUri, onPaired]);

	const cancel = useCallback(() => {
		attempt.current += 1;
		cancelPairing();
		setPhase({ kind: 'idle' });
	}, [cancelPairing]);

	const fail = useCallback((message: string) => {
		attempt.current += 1;
		setPhase({ kind: 'error', message });
	}, []);

	const reset = useCallback(() => {
		attempt.current += 1;
		setPhase({ kind: 'idle' });
	}, []);

	return { phase, start, cancel, fail, reset };
}
