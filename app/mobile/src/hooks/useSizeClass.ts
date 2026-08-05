// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Platform, useWindowDimensions } from 'react-native';
import { sizeClassFor, type SizeClass } from '../sizeClass.js';

/**
 * このデバイスがタブレットか（iPadのみ対象。Androidタブレットは未検証のため含めない）。
 * 端末固有の値なので毎回同じ結果になり、フックの外で1度だけ解決してよい。
 */
const tablet = Platform.OS === 'ios' && Platform.isPad === true;

/**
 * 現在のsize class。Split View/Slide Overの幅変更や回転にも追従する
 * （`useWindowDimensions`はアプリのウィンドウ幅を返すため、Split View中は分割後の幅になる）。
 */
export function useSizeClass(): SizeClass {
	const { width } = useWindowDimensions();
	return sizeClassFor(width, tablet);
}

/** サイドバー常設の2カラム表示中かどうか（`useSizeClass() === 'regular'` の読みやすい別名）。 */
export function useIsRegularWidth(): boolean {
	return useSizeClass() === 'regular';
}
