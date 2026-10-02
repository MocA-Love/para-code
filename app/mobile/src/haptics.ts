// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * アプリ全域の触覚の入口。画面は強さを選ばず、操作の意味（`HapticToken`）で `haptic(token)` を呼ぶ。
 * トークンの意味と値の表は `hapticTokens.ts`（純関数、テストあり）。
 *
 * ここだけで扱うこと:
 * - 設定（`hapticPreference.ts`）がオフなら全部捨てる
 * - アプリが前面（AppState が active）でなければ鳴らさない
 * - 端末が触覚を持たない（iPad・シミュレータ）なら呼び出しごと省く
 * - 間引き（同じトークンの連続、画面移動の重なり）
 * - para-haptics（`modules/para-haptics`）があればそれで、無い古いバイナリでは expo-haptics で鳴らす
 *
 * 例外は画面操作へ伝えない（鳴らなかっただけにする）。
 */

import * as Haptics from 'expo-haptics';
import { AppState } from 'react-native';
import { paraHapticsModule, type ParaHapticsNative } from '../modules/para-haptics/index.js';
import { useHapticPreference } from './hapticPreference.js';
import {
	HapticGate,
	hapticPlan,
	hapticPrepareKind,
	hapticsAllowed,
	type ExpoHapticCall,
	type HapticImpactStyle,
	type HapticOptions,
	type HapticToken,
	type NativeHapticCall,
} from './hapticTokens.js';

export type { HapticOptions, HapticToken } from './hapticTokens.js';
export { DISCONNECT_WARNING, EDGE_RELEASE, KEY_TICK } from './hapticTokens.js';

const native: ParaHapticsNative | null = paraHapticsModule;
const supportsHaptics: boolean | undefined = readSupportsHaptics();
const gate = new HapticGate();

function readSupportsHaptics(): boolean | undefined {
	try {
		return native?.supportsHaptics;
	} catch {
		return undefined;
	}
}

function allowed(): boolean {
	return hapticsAllowed({ enabled: useHapticPreference.getState().enabled, appState: AppState.currentState, supportsHaptics });
}

/**
 * 触覚を 1 回鳴らす（鳴らすかどうかは設定・前面・間引きで決まる）。
 *
 * ```ts
 * haptic('commit');                     // 送信した
 * haptic('tick', KEY_TICK);           // ターミナル・ブラウザのキー
 * haptic('edge', EDGE_RELEASE);       // 引き切りのしきい値から戻った
 * ```
 */
export function haptic(token: HapticToken, options: HapticOptions = {}): void {
	if (token === 'none' || !allowed()) {
		return;
	}
	try {
		const lowPower = native !== null && (token === 'knock' || token === 'charge') ? native.isLowPowerMode() : false;
		const plan = hapticPlan(token, { intensity: options.intensity, sharpness: options.sharpness, lowPower });
		if (plan === undefined || !gate.admit(token, Date.now(), options.minIntervalMs ?? plan.minIntervalMs, options.key)) {
			return;
		}
		if (native !== null) {
			playNative(native, plan.native);
		} else {
			playExpo(plan.expo);
		}
	} catch {
		// 触覚が鳴らなかっただけ。操作は止めない
	}
}

/**
 * 次に鳴らすトークンに備えて、ネイティブの generator（またはエンジン）を温める。押し始め・入力欄に
 * 入ったときなど、鳴らす少し前に呼ぶ。para-haptics が無いバイナリでは何もしない。
 */
export function prepareHaptic(token: HapticToken, options: HapticOptions = {}): void {
	if (native === null || !allowed()) {
		return;
	}
	const kind = hapticPrepareKind(token, options);
	if (kind === undefined) {
		return;
	}
	try {
		native.prepare(kind);
	} catch {
		// 温められなかっただけ
	}
}

function playNative(module: ParaHapticsNative, call: NativeHapticCall): void {
	switch (call.kind) {
		case 'selection':
			module.selection();
			return;
		case 'impact':
			module.impact(call.style, call.intensity);
			return;
		case 'notify':
			module.notify(call.type);
			return;
		case 'transient':
			module.transient(call.intensity, call.sharpness);
			return;
		case 'pattern':
			module.playPattern(call.name);
			return;
	}
}

const EXPO_IMPACT: Readonly<Record<HapticImpactStyle, Haptics.ImpactFeedbackStyle>> = {
	light: Haptics.ImpactFeedbackStyle.Light,
	medium: Haptics.ImpactFeedbackStyle.Medium,
	heavy: Haptics.ImpactFeedbackStyle.Heavy,
	soft: Haptics.ImpactFeedbackStyle.Soft,
	rigid: Haptics.ImpactFeedbackStyle.Rigid,
};

const EXPO_NOTIFY: Readonly<Record<'success' | 'warning' | 'error', Haptics.NotificationFeedbackType>> = {
	success: Haptics.NotificationFeedbackType.Success,
	warning: Haptics.NotificationFeedbackType.Warning,
	error: Haptics.NotificationFeedbackType.Error,
};

function playExpo(call: ExpoHapticCall): void {
	const done = call.kind === 'selection'
		? Haptics.selectionAsync()
		: call.kind === 'impact'
			? Haptics.impactAsync(EXPO_IMPACT[call.style])
			: Haptics.notificationAsync(EXPO_NOTIFY[call.type]);
	done.catch(() => undefined);
}

/**
 * @deprecated 旧 API。`legacy-screens/` と、どこからも読まれていない `src/components/` の 7 ファイル
 * （別の PR で削除予定）のためだけに残す。新しいコードは `haptic(token)` を使う。
 */
export function hapticSelection(): void {
	haptic('tick');
}

/** @deprecated `hapticSelection` と同じ理由で残す。light は画面移動、medium は確定、heavy は破壊的操作として鳴らす。 */
export function hapticImpact(style: 'light' | 'medium' | 'heavy'): void {
	haptic(style === 'light' ? 'move' : style === 'medium' ? 'commit' : 'danger');
}

/** @deprecated `hapticSelection` と同じ理由で残す。 */
export function hapticSuccess(): void {
	haptic('success');
}

/** @deprecated `hapticSelection` と同じ理由で残す。 */
export function hapticWarning(): void {
	haptic('warning');
}
