// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { AlertButton, AlertStatic } from 'react-native';

/**
 * Alert（`Alert.alert` / `Alert.prompt`）をロックに従わせる仕組みの本体。RN に依存しないので vitest で検査できる。
 * アプリから使うのは `paraAlert.ts`（RN の Alert とネイティブの閉じる関数を差し込んだもの）。
 *
 * Alert は UIAlertController としてネイティブで最前面に出るので、ロック画面を重ねても覆えず、認証なしで
 * ボタンを押せてしまう。そこで:
 *  - ロック中に出そうとした Alert は、解除まで保留する
 *  - ロックしたら、出ている Alert をネイティブで閉じ（`dismissPresented`）、解除後に出し直す
 *  - 閉じられなかった（古いバイナリで閉じる関数が無い）ときに備え、ボタンと確定の処理でもロックを見直す。
 *    ロック中に押されたら処理を走らせず、解除後に同じ Alert を出し直す（確認し直してもらう）
 *
 * ボタンを渡さない `alert` は RN と同じく「OK」1つにする（押されたことを知るため、明示して渡す）。
 * 関数を渡す `prompt` も「キャンセル」「OK」の2つにする（キャンセルを知るため。ラベルは RN の既定と同じ）。
 */

type AlertOptions = Parameters<AlertStatic['alert']>[3];
type PromptType = Parameters<AlertStatic['prompt']>[3];

/** 差し込む RN の Alert（テストでは偽物）。 */
export type NativeAlert = Pick<AlertStatic, 'alert' | 'prompt'>;

/** 差し込むロックの状態（アプリでは `appLockState.ts`）。 */
export interface AlertLockSource {
	isLocked(): boolean;
	onChange(listener: (locked: boolean) => void): () => void;
}

export interface ParaAlert {
	alert(title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions): void;
	prompt(title: string, message?: string, callbackOrButtons?: ((text: string) => void) | AlertButton[], type?: PromptType, defaultValue?: string, keyboardType?: string, options?: AlertOptions): void;
}

/** ボタンの処理（prompt では入力した文字が渡る）。RN の型は2通りの引数の和なので、ここで1つにまとめる。 */
type ButtonAction = (value?: unknown) => void;

interface AlertEntry {
	/** ボタンの処理を包んだうえで、ネイティブに出す。 */
	present(): void;
}

/**
 * ロックに従う Alert を作る。`dismissPresented` は出ている Alert をネイティブで閉じる関数で、閉じられた
 * （関数がある）なら true を返す。
 */
export function createParaAlert(native: NativeAlert, lock: AlertLockSource, dismissPresented?: () => boolean): ParaAlert {
	/** いまネイティブに出ていて、まだボタンが押されていないもの。 */
	const open = new Set<AlertEntry>();
	/** 解除を待って出すもの（出す順）。 */
	const pending: AlertEntry[] = [];

	lock.onChange(locked => {
		if (locked) {
			if (open.size > 0 && dismissPresented?.() === true) {
				// 閉じた Alert のボタンは押されない。解除後に出し直す。
				pending.push(...open);
				open.clear();
			}
			return;
		}
		for (const entry of pending.splice(0)) {
			show(entry);
		}
	});

	function show(entry: AlertEntry): void {
		if (lock.isLocked()) {
			pending.push(entry);
			return;
		}
		open.add(entry);
		entry.present();
	}

	/** ボタン（と確定）の処理を包む。ロック中に押されたら処理を走らせず、解除後に出し直す。 */
	function guard(entry: AlertEntry, action: ButtonAction | undefined): ButtonAction {
		return value => {
			if (!open.has(entry)) {
				// ロックで閉じた後に入れ違いで届いた（既に出し直しを待っている）。
				return;
			}
			open.delete(entry);
			if (lock.isLocked()) {
				pending.push(entry);
				return;
			}
			action?.(value);
		};
	}

	function wrapButtons(entry: AlertEntry, buttons: readonly AlertButton[]): AlertButton[] {
		return buttons.map(button => ({ ...button, onPress: guard(entry, button.onPress as ButtonAction | undefined) }));
	}

	function wrapOptions(entry: AlertEntry, options: AlertOptions): AlertOptions {
		if (options?.onDismiss === undefined) {
			return options;
		}
		const onDismiss = options.onDismiss;
		return { ...options, onDismiss: guard(entry, () => onDismiss()) };
	}

	return {
		alert(title, message, buttons, options) {
			const given = buttons !== undefined && buttons.length > 0 ? buttons : [{ text: 'OK' }];
			const entry: AlertEntry = {
				present: () => native.alert(title, message, wrapButtons(entry, given), wrapOptions(entry, options)),
			};
			show(entry);
		},
		prompt(title, message, callbackOrButtons, type, defaultValue, keyboardType, options) {
			const given: AlertButton[] = typeof callbackOrButtons === 'function'
				? [{ text: 'Cancel', style: 'cancel' }, { text: 'OK', onPress: (value?: string) => callbackOrButtons(value ?? '') }]
				: callbackOrButtons !== undefined && callbackOrButtons.length > 0 ? callbackOrButtons : [{ text: 'Cancel', style: 'cancel' }, { text: 'OK' }];
			const entry: AlertEntry = {
				present: () => native.prompt(title, message, wrapButtons(entry, given), type, defaultValue, keyboardType, wrapOptions(entry, options)),
			};
			show(entry);
		},
	};
}
