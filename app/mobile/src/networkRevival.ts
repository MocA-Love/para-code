// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * 回線が戻った・切り替わった（オフライン → オンライン、Wi-Fi ⇄ セルラー）ことを、短い間の変化を
 * まとめて1回知らせる（W2-05。
 * Orca の connection-revival-triggers.ts に倣った）。
 *
 * 回線が切り替わると古いソケットの経路は死ぬが、iOS は onclose を返さないことが多い。これが無いと
 * バックオフの待ち（最大30秒）か、25秒おきの心拍まで「接続中」のまま止まって見える。
 *
 * `expo-network` のネイティブ部品が入っていないビルド（入れる前のバイナリ）でも落ちないよう、
 * `expo-network` の JS は import しない（import した時点で `requireNativeModule` が投げる）。
 * `requireOptionalNativeModule` で引き、無ければ何もしない。
 */

/** 回線の状態（expo-network の NetworkState のうち使う分）。 */
export interface NetworkSnapshot {
	readonly isConnected?: boolean;
	readonly type?: string;
}

interface NetworkEventSubscription {
	remove(): void;
}

/** expo-network のネイティブ部品（ExpoNetwork）のうち使う分。 */
export interface NetworkModuleLike {
	getNetworkStateAsync(): Promise<NetworkSnapshot>;
	addListener(eventName: 'onNetworkStateChanged', listener: (state: NetworkSnapshot) => void): NetworkEventSubscription;
}

/**
 * 変化を受けて繋ぎ直しを促すべきか。繋がっていない状態への変化では促さない（繋ぎようがない）。
 * - 繋がっていなかった → 繋がった
 * - 繋がったまま種類が変わった（Wi-Fi → セルラー。古いソケットは死んでいる）
 * 前の状態が分からない最初の1回は促さない（アプリが開いただけで繋ぎ直さない）。
 */
export function shouldNudgeForNetworkChange(previous: NetworkSnapshot | undefined, next: NetworkSnapshot): boolean {
	if (next.isConnected !== true || previous === undefined) {
		return false;
	}
	const cameOnline = previous.isConnected !== true;
	const switchedNetworks = previous.type !== undefined && next.type !== previous.type;
	return cameOnline || switchedNetworks;
}

/**
 * 変化のイベントをまとめる時間。回線の切り替えでは「切れた・繋がった・種類が変わった」が
 * 短い間に続けて届くので、1回ずつ繋ぎ直すと張ったばかりのソケットを自分で捨てることになる。
 */
export const NETWORK_REVIVAL_DEBOUNCE_MS = 750;

function loadNetworkModule(): NetworkModuleLike | undefined {
	try {
		return requireOptionalNativeModule<NetworkModuleLike>('ExpoNetwork') ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * 回線の変化を購読し、繋ぎ直すべき変化のたびに `onNudge` を呼ぶ。解除する関数を返す。
 * ネイティブ部品が無ければ何もしない（解除関数も何もしない）。
 */
export function subscribeNetworkRevival(onNudge: () => void, module: NetworkModuleLike | undefined = loadNetworkModule(), debounceMs = NETWORK_REVIVAL_DEBOUNCE_MS): () => void {
	if (module === undefined) {
		return () => undefined;
	}
	let last: NetworkSnapshot | undefined;
	let disposed = false;
	let pending: ReturnType<typeof setTimeout> | undefined;
	const schedule = () => {
		if (pending !== undefined) {
			clearTimeout(pending);
		}
		pending = setTimeout(() => {
			pending = undefined;
			if (!disposed) {
				onNudge();
			}
		}, debounceMs);
	};
	// 変化のイベントしか来ないので、最初の状態を読んでおく（読む前の変化はそのまま基準にする）。
	module.getNetworkStateAsync().then(state => {
		if (!disposed && last === undefined) {
			last = { isConnected: state.isConnected, type: state.type };
		}
	}).catch(() => { /* 読めなければ最初の変化を基準にする */ });
	let subscription: NetworkEventSubscription | undefined;
	try {
		subscription = module.addListener('onNetworkStateChanged', state => {
			const next = { isConnected: state.isConnected, type: state.type };
			const previous = last;
			last = next;
			if (!disposed && shouldNudgeForNetworkChange(previous, next)) {
				schedule();
			}
		});
	} catch (err) {
		console.warn('[network] failed to watch the network state', err);
	}
	return () => {
		disposed = true;
		if (pending !== undefined) {
			clearTimeout(pending);
		}
		subscription?.remove();
	};
}
