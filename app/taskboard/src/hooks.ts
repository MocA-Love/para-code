// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { serverNow } from './api.js';

/* ---------------- 時計（1 つのタイマーを全員で共有する） ---------------- */

const tickListeners = new Set<() => void>();
let tickTimer: number | undefined;
let tick = 0;

function subscribeTick(listener: () => void): () => void {
	tickListeners.add(listener);
	if (!tickTimer) {
		tickTimer = window.setInterval(() => {
			tick++;
			tickListeners.forEach(l => l());
		}, 1000);
	}
	return () => {
		tickListeners.delete(listener);
		if (!tickListeners.size) {
			clearInterval(tickTimer);
			tickTimer = undefined;
		}
	};
}

/** 1 秒ごとに更新される「今」（サーバーの時計に合わせる）。 */
export function useNow(): number {
	useSyncExternalStore(subscribeTick, () => tick);
	return serverNow();
}

/* ---------------- 画面幅 ---------------- */

export function useMedia(query: string): boolean {
	const subscribe = useCallback((cb: () => void) => {
		const mql = window.matchMedia(query);
		mql.addEventListener('change', cb);
		return () => mql.removeEventListener('change', cb);
	}, [query]);
	return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/** 電話の幅（下に表示切り替えのバーを出す）。 */
export function usePhone(): boolean {
	return useMedia('(max-width: 640px)');
}

/** 詳細パネルを全面にする幅。 */
export function useNarrow(): boolean {
	return useMedia('(max-width: 900px)');
}

/* ---------------- 保存する設定 ---------------- */

export function useStored<T>(key: string, initial: T): [T, (value: T) => void] {
	const [value, setValue] = useState<T>(() => {
		try {
			const raw = localStorage.getItem(`taskboard:${key}`);
			return raw === null ? initial : JSON.parse(raw) as T;
		} catch {
			return initial;
		}
	});
	const set = useCallback((next: T) => {
		setValue(next);
		try {
			localStorage.setItem(`taskboard:${key}`, JSON.stringify(next));
		} catch { /* 保存できなくても動く */ }
	}, [key]);
	return [value, set];
}

/* ---------------- 非同期の読み込み ---------------- */

export interface IAsync<T> {
	readonly data: T | undefined;
	readonly error: Error | undefined;
	readonly loading: boolean;
	readonly reload: () => void;
}

export function useAsync<T>(load: (force: boolean) => Promise<T>, deps: readonly unknown[]): IAsync<T> {
	const [state, setState] = useState<{ data: T | undefined; error: Error | undefined; loading: boolean }>({ data: undefined, error: undefined, loading: true });
	const [nonce, setNonce] = useState(0);
	const forced = useRef(false);
	useEffect(() => {
		let alive = true;
		setState(s => ({ ...s, loading: true, error: undefined }));
		const force = forced.current;
		forced.current = false;
		load(force).then(data => alive && setState({ data, error: undefined, loading: false }), (error: Error) => alive && setState(s => ({ data: s.data, error, loading: false })));
		return () => {
			alive = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...deps, nonce]);
	const reload = useCallback(() => {
		forced.current = true;
		setNonce(n => n + 1);
	}, []);
	return { ...state, reload };
}

/* ---------------- テーマ ---------------- */

export type ThemeMode = 'system' | 'dark' | 'light';

export function useTheme(): [ThemeMode, (mode: ThemeMode) => void] {
	const [mode, setMode] = useStored<ThemeMode>('theme', 'dark');
	const systemDark = useMedia('(prefers-color-scheme: dark)');
	useEffect(() => {
		const resolved = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
		document.documentElement.dataset.theme = resolved;
		document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolved);
	}, [mode, systemDark]);
	return [mode, setMode];
}

/* ---------------- 外側のクリックで閉じる ---------------- */

/** `also` は、別の場所（body 直下など）に出した中身。そこを押しても閉じない。 */
export function useDismiss(open: boolean, close: () => void, also?: React.RefObject<HTMLElement | null>): React.RefObject<HTMLDivElement | null> {
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!open) {
			return;
		}
		const onDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (ref.current && !ref.current.contains(target) && !also?.current?.contains(target)) {
				close();
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				close();
			}
		};
		document.addEventListener('pointerdown', onDown, true);
		document.addEventListener('keydown', onKey, true);
		return () => {
			document.removeEventListener('pointerdown', onDown, true);
			document.removeEventListener('keydown', onKey, true);
		};
	}, [open, close, also]);
	return ref;
}
