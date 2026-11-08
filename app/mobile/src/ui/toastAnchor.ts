// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { View } from 'react-native';
import { create } from 'zustand';

/**
 * お知らせ（`toast.tsx` の札）を置く位置の手がかり。画面の下に帯（クイック返信・入力欄など）を持つ画面が、
 * その帯の塊の画面の上の四角を知らせる。札はその上端のすぐ上に、塊の幅の中央に出す（帯に重ねない。iPad の 2 列でも
 * 詳細の列の中に出す）。知らせる画面が無いときは今までどおり画面の下寄りの決まった位置に出す。
 *
 * 知らせるのは前面の画面だけ（裏に回ったら外す）。外すときは自分が置いたものだけを外す（後から前面に来た画面の
 * 手がかりを、前の画面の後片付けで消さないように）。
 */

/** 帯の塊の、画面（ウィンドウ）の座標の四角（pt）。 */
export interface ToastAnchorRect {
	readonly top: number;
	readonly left: number;
	readonly width: number;
}

interface ToastAnchorStore {
	readonly owner: object | undefined;
	readonly rect: ToastAnchorRect | undefined;
}

export const useToastAnchor = create<ToastAnchorStore>()(() => ({ owner: undefined, rect: undefined }));

/** `owner` の手がかりを置く（置き直す）。 */
export function setToastAnchor(owner: object, rect: ToastAnchorRect): void {
	const current = useToastAnchor.getState();
	if (current.owner === owner && current.rect !== undefined && sameRect(current.rect, rect)) {
		return;
	}
	useToastAnchor.setState({ owner, rect });
}

/** `owner` が置いた手がかりを外す（別の画面のものは残す）。 */
export function clearToastAnchor(owner: object): void {
	if (useToastAnchor.getState().owner === owner) {
		useToastAnchor.setState({ owner: undefined, rect: undefined });
	}
}

function sameRect(a: ToastAnchorRect, b: ToastAnchorRect): boolean {
	return Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5;
}

/** 手がかりが無いときの、下端（セーフエリアの内側）からの位置（pt。モックの `bottom:196px` から、ホームインジケーターの 34 を引いた値）。 */
export const TOAST_DEFAULT_BOTTOM_GAP = 162;
/** 帯の上端と札の間（pt）。 */
export const TOAST_ANCHOR_GAP = 8;

/** 札の置き場所（ルートの層の中の位置）。`left` / `width` が無ければ画面の幅いっぱいの中央。 */
export interface ToastPlacement {
	readonly bottom: number;
	readonly left?: number;
	readonly width?: number;
}

/**
 * 札の置き場所を決める。手がかりがあれば帯の塊の上端のすぐ上・塊の幅の中央、無ければ下寄りの決まった位置。
 * 壊れた値（画面の外・幅 0）の手がかりは使わない。
 */
export function toastPlacement(anchor: ToastAnchorRect | undefined, window: { readonly width: number; readonly height: number }, bottomInset: number): ToastPlacement {
	const fallback: ToastPlacement = { bottom: bottomInset + TOAST_DEFAULT_BOTTOM_GAP };
	if (anchor === undefined || !Number.isFinite(anchor.top) || !Number.isFinite(anchor.left) || !Number.isFinite(anchor.width)) {
		return fallback;
	}
	if (anchor.top <= 0 || anchor.top > window.height || anchor.width <= 0) {
		return fallback;
	}
	const left = Math.max(0, anchor.left);
	const width = Math.min(window.width - left, anchor.width);
	if (width <= 0) {
		return fallback;
	}
	return { bottom: Math.round(window.height - anchor.top + TOAST_ANCHOR_GAP), left: Math.round(left), width: Math.round(width) };
}

/**
 * 帯の塊の View に付けて、前面にある間だけ手がかりを置く。`ref` と `onLayout` をその View に渡す
 * （`collapsable={false}` も付ける。平らにされると測れない）。`remeasureKey` が変わったら測り直す
 * （キーボードの出入りなど、親の中の位置が変わらずに画面の上の位置だけ変わるとき）。
 */
export function useToastAnchorView(active: boolean, remeasureKey?: unknown): { ref: RefObject<View | null>; onLayout: () => void } {
	const ref = useRef<View>(null);
	const owner = useRef({}).current;
	const activeRef = useRef(active);
	activeRef.current = active;
	const measure = useCallback(() => {
		const view = ref.current;
		if (view === null || !activeRef.current) {
			return;
		}
		view.measureInWindow((left, top, width) => {
			if (activeRef.current) {
				setToastAnchor(owner, { top, left, width });
			}
		});
	}, [owner]);
	useEffect(() => {
		if (!active) {
			clearToastAnchor(owner);
			return undefined;
		}
		measure();
		return () => clearToastAnchor(owner);
	}, [active, measure, owner, remeasureKey]);
	return { ref, onLayout: measure };
}
