// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 相対時刻表示の共通ヘルパ。通知一覧・Ccusage・ソース管理の3画面で共用する。
 * 設計方針: PC側は事実（epoch ms）だけを送り、見せ方（相対/絶対、言語、
 * タイムゾーン）は表示のたびにモバイル側で決める。整形済み文字列を
 * プロトコルで運ぶと取得時点のスナップショットが古くなっていくため。
 */

import { useEffect, useState } from 'react';
import { useAppIsActive } from './hooks/useAppIsActive.js';

/** これより古い時刻は相対表示をやめて絶対日付に切り替える。 */
const ABSOLUTE_DATE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * epoch msを「今」「〇分前」「〇時間前」「〇日前」に整形する。7日を超えたものは
 * 端末タイムゾーンの絶対日付（同年なら「M/D」、年跨ぎは「YYYY/M/D」）にする。
 * 表示を経時で追従させたい画面では now に useNow() の値を渡す（レンダー間で
 * 値が動かないよう、呼び出し側で1つのnowを共有する）。
 */
export function formatRelativeTime(at: number, now: number = Date.now()): string {
	const diffMs = Math.max(0, now - at);
	if (diffMs >= ABSOLUTE_DATE_THRESHOLD_MS) {
		const date = new Date(at);
		const sameYear = date.getFullYear() === new Date(now).getFullYear();
		return sameYear ? `${date.getMonth() + 1}/${date.getDate()}` : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
	}
	const diffMin = Math.floor(diffMs / 60_000);
	if (diffMin < 1) {
		return '今';
	}
	if (diffMin < 60) {
		return `${diffMin}分前`;
	}
	const diffHour = Math.floor(diffMin / 60);
	if (diffHour < 24) {
		return `${diffHour}時間前`;
	}
	return `${Math.floor(diffHour / 24)}日前`;
}

/**
 * 一定間隔で更新される現在時刻（epoch ms）。相対時刻表示を画面を開いたまま
 * でも追従させるために使う（「3分前」が放置で「1時間前」に育つ）。
 * アプリがactiveの間だけintervalを動かし、復帰時は滞留したtimer callbackを再生せず
 * 現在時刻へ1回で追いつく。
 */
export function useNow(intervalMs: number = 60_000): number {
	const [now, setNow] = useState(() => Date.now());
	const isAppActive = useAppIsActive();
	useEffect(() => {
		if (!isAppActive) {
			return;
		}
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs, isAppActive]);
	return now;
}
