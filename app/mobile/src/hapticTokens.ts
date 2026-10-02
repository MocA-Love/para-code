// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 触覚の「意味のトークン」と、トークンから実際の鳴らし方・間引きを決める純関数。
 * 鳴らす本体（AppState・設定・ネイティブ）は `haptics.ts`。ここは React Native に依存しない。
 *
 * 設計は `mobile-haptics-design.html`（3-1 の表）。表の値を変えるときはこのファイルと
 * `hapticTokens.test.ts` の表を同時に直す。
 */

/**
 * 触覚の意味。画面ごとに強さを選ばず、操作の意味でここから選ぶ。
 *
 * - `move`: 画面を移った（push・戻る・タブ切り替え・シートを開く/閉じる・展開）。一番弱い
 * - `tick`: 値が 1 段変わった（セグメント・選択肢・スライダーの段・キー）
 * - `commit`: 送信・確定・回答した
 * - `lift`: 長押しが成立し、メニューや掴みが出た
 * - `edge`: しきい値を越えた・端に当たった（引き切り、引っぱって更新の成立、折り返し）
 * - `danger`: 取り消せない操作を実行した（確認を出すときではなく、実行したとき）
 * - `success` / `warning` / `error`: PC 側で結果が確定した（押した瞬間には使わない）
 * - `knock`: 前面にいる間に承認・質問が届いた
 * - `charge`: 段階選択の最大に達した（エフォート max）
 * - `none`: 鳴らさない（スワイプのアクションなど、呼び出し側が種類を渡すときの「無し」）
 */
export type HapticToken = 'move' | 'tick' | 'commit' | 'lift' | 'edge' | 'danger' | 'success' | 'warning' | 'error' | 'knock' | 'charge' | 'none';

export type HapticImpactStyle = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid';
export type HapticNotifyType = 'success' | 'warning' | 'error';
export type HapticPatternName = 'knock' | 'charge';

/** para-haptics（`modules/para-haptics`）へ渡す呼び出し。 */
export type NativeHapticCall =
	| { readonly kind: 'selection' }
	| { readonly kind: 'impact'; readonly style: HapticImpactStyle; readonly intensity: number }
	| { readonly kind: 'notify'; readonly type: HapticNotifyType }
	| { readonly kind: 'transient'; readonly intensity: number; readonly sharpness: number }
	| { readonly kind: 'pattern'; readonly name: HapticPatternName };

/** para-haptics が無いバイナリで使う expo-haptics の呼び出し（強さは指定できない）。 */
export type ExpoHapticCall =
	| { readonly kind: 'selection' }
	| { readonly kind: 'impact'; readonly style: HapticImpactStyle }
	| { readonly kind: 'notify'; readonly type: HapticNotifyType };

export interface HapticPlan {
	readonly native: NativeHapticCall;
	readonly expo: ExpoHapticCall;
	/** 同じトークン（と `key`）がこれより短い間隔で続いたら捨てる。 */
	readonly minIntervalMs: number;
}

/** 呼び出しごとの調整。 */
export interface HapticOptions {
	/**
	 * 強さ（0〜1）の上書き。impact 系のトークンはその強さで鳴らす。`tick` は弱い impact light になる
	 * （ターミナル・ブラウザのキーの 0.3。Core Haptics のエンジンを使わないので、止まっていても遅れない）。
	 * 結果（success 等）とパターン（knock・charge）では無視する。
	 */
	readonly intensity?: number;
	/**
	 * 鋭さ（0〜1）。`intensity` と一緒に渡すと、強さと鋭さを指定した 1 打（transient）になる
	 * （引き切りから戻ったときの `EDGE_RELEASE`）。
	 */
	readonly sharpness?: number;
	/** 間引きを分ける鍵（例: 切断の warning だけ別の間隔にする）。 */
	readonly key?: string;
	/** 間引きの間隔の上書き。 */
	readonly minIntervalMs?: number;
}

type PlayableToken = Exclude<HapticToken, 'none'>;

interface TokenSpec {
	readonly native: NativeHapticCall;
	readonly expo: ExpoHapticCall;
	readonly minIntervalMs: number;
}

/** ターミナル・ブラウザのキーの tick（弱い impact light）。 */
export const KEY_TICK: HapticOptions = { intensity: 0.3 };

/** 引き切りのしきい値から戻ったときの edge（設計の transient、強さ 0.3 / 鋭さ 0.95）。 */
export const EDGE_RELEASE: HapticOptions = { intensity: 0.3, sharpness: 0.95 };

/** トークン → 段階 2（para-haptics）と段階 1（expo-haptics）と間引き。 */
export const HAPTIC_TOKEN_TABLE: Readonly<Record<PlayableToken, TokenSpec>> = {
	move: { native: { kind: 'impact', style: 'light', intensity: 0.35 }, expo: { kind: 'selection' }, minIntervalMs: 250 },
	tick: { native: { kind: 'selection' }, expo: { kind: 'selection' }, minIntervalMs: 50 },
	commit: { native: { kind: 'impact', style: 'medium', intensity: 0.75 }, expo: { kind: 'impact', style: 'medium' }, minIntervalMs: 300 },
	lift: { native: { kind: 'impact', style: 'soft', intensity: 0.7 }, expo: { kind: 'impact', style: 'soft' }, minIntervalMs: 400 },
	edge: { native: { kind: 'impact', style: 'rigid', intensity: 0.55 }, expo: { kind: 'impact', style: 'rigid' }, minIntervalMs: 150 },
	danger: { native: { kind: 'impact', style: 'heavy', intensity: 0.85 }, expo: { kind: 'impact', style: 'heavy' }, minIntervalMs: 500 },
	success: { native: { kind: 'notify', type: 'success' }, expo: { kind: 'notify', type: 'success' }, minIntervalMs: 1_000 },
	warning: { native: { kind: 'notify', type: 'warning' }, expo: { kind: 'notify', type: 'warning' }, minIntervalMs: 1_000 },
	error: { native: { kind: 'notify', type: 'error' }, expo: { kind: 'notify', type: 'error' }, minIntervalMs: 1_000 },
	knock: { native: { kind: 'pattern', name: 'knock' }, expo: { kind: 'impact', style: 'medium' }, minIntervalMs: 3_000 },
	charge: { native: { kind: 'pattern', name: 'charge' }, expo: { kind: 'impact', style: 'rigid' }, minIntervalMs: 500 },
};

/** 低電力モードで重いパターンを置き換える先（knock は impact 1 回、charge は tick）。 */
const LOW_POWER_NATIVE: Readonly<Record<HapticPatternName, NativeHapticCall>> = {
	knock: { kind: 'impact', style: 'medium', intensity: 0.6 },
	charge: { kind: 'selection' },
};

/** 意図しない切断の warning の間隔（設計: 30 秒に 1 回）。`haptic('warning', DISCONNECT_WARNING)` で使う。 */
export const DISCONNECT_WARNING: HapticOptions = { key: 'disconnect', minIntervalMs: 30_000 };

function clampUnit(value: number): number {
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

/**
 * トークンの鳴らし方。`none` は undefined。
 * @param lowPower 低電力モード（knock・charge を軽い 1 打に落とす）
 */
export function hapticPlan(token: HapticToken, options: { readonly intensity?: number; readonly sharpness?: number; readonly lowPower?: boolean } = {}): HapticPlan | undefined {
	if (token === 'none') {
		return undefined;
	}
	const spec = HAPTIC_TOKEN_TABLE[token];
	let native = spec.native;
	if (native.kind === 'pattern' && options.lowPower === true) {
		native = LOW_POWER_NATIVE[native.name];
	} else if (options.intensity !== undefined) {
		const intensity = clampUnit(options.intensity);
		if (native.kind === 'impact' || native.kind === 'selection') {
			native = options.sharpness !== undefined
				? { kind: 'transient', intensity, sharpness: clampUnit(options.sharpness) }
				: native.kind === 'impact' ? { ...native, intensity } : { kind: 'impact', style: 'light', intensity };
		}
	}
	return { native, expo: spec.expo, minIntervalMs: spec.minIntervalMs };
}

/** generator を先に温めるときの種類（`prepareHaptic`）。パターンはエンジンを起こす。 */
export type HapticPrepareKind = 'selection' | `impact-${HapticImpactStyle}` | 'notification' | 'engine';

export function hapticPrepareKind(token: HapticToken, options: Pick<HapticOptions, 'intensity' | 'sharpness'> = {}): HapticPrepareKind | undefined {
	const plan = hapticPlan(token, options);
	if (plan === undefined) {
		return undefined;
	}
	switch (plan.native.kind) {
		case 'selection': return 'selection';
		case 'impact': return `impact-${plan.native.style}`;
		case 'notify': return 'notification';
		case 'transient':
		case 'pattern': return 'engine';
	}
}

/** move は他のトークンが鳴った直後には重ねない（送信して画面が移るときなど、後の弱い方を捨てる）。 */
export const MOVE_YIELD_MS = 150;

/**
 * 間引き。同じトークン（と鍵）が `minIntervalMs` 以内に続いたら捨てる。knock の 3 秒はこれで
 * 「3 秒以内の到着はまとめて 1 回（先頭で鳴らす）」になる。時刻は呼び出し側が渡す（テストのため）。
 */
export class HapticGate {
	private readonly lastAt = new Map<string, number>();
	private lastOtherAt = Number.NEGATIVE_INFINITY;

	admit(token: PlayableToken, now: number, minIntervalMs: number, key?: string): boolean {
		const slot = key === undefined ? token : `${token}:${key}`;
		const previous = this.lastAt.get(slot);
		if (previous !== undefined && now - previous < minIntervalMs) {
			return false;
		}
		if (token === 'move' && now - this.lastOtherAt < MOVE_YIELD_MS) {
			return false;
		}
		this.lastAt.set(slot, now);
		if (token !== 'move') {
			this.lastOtherAt = now;
		}
		return true;
	}
}

/**
 * いま鳴らしてよいか。設定でオフ・アプリが前面でない・端末が触覚を持たない（iPad・シミュレータ。
 * `supportsHaptics === false`）なら鳴らさない。`supportsHaptics` が undefined（para-haptics の無い古い
 * バイナリ）なら expo-haptics に任せる（iPad では OS が何もしない）。
 */
export function hapticsAllowed(state: { readonly enabled: boolean; readonly appState: string; readonly supportsHaptics: boolean | undefined }): boolean {
	return state.enabled && state.appState === 'active' && state.supportsHaptics !== false;
}

/** 触覚の設定の保存値を読む（既定はオン。`'0'` だけがオフ）。 */
export function parseHapticsEnabled(raw: string | null | undefined): boolean {
	return raw !== '0';
}

export function serializeHapticsEnabled(enabled: boolean): string {
	return enabled ? '1' : '0';
}
