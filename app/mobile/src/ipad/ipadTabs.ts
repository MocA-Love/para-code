// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { Ionicons } from '@expo/vector-icons';

/** サイドバー下部のセグメント1つぶんの定義。 */
export interface SidebarTab {
	/** タブのルート名（`app/(tabs)/` 配下のファイル名に対応）。 */
	name: 'index' | 'terminal' | 'scm' | 'files';
	label: string;
	href: '/' | '/terminal' | '/scm' | '/files';
	icon: keyof typeof Ionicons.glyphMap;
	iconActive: keyof typeof Ionicons.glyphMap;
	/**
	 * 応答待ち件数のバッジを出すか（iPhone版のNativeTabsと合わせてホームだけ）。
	 *
	 * 同じ件数を隣り合う2タブへ同時に出すと合計が倍あるように読めるため、
	 * 出すのはホームの1箇所に絞る。
	 */
	badge?: boolean;
}

/**
 * iPhone版の下部タブ（`app/(tabs)/_layout.tsx`）と同じ4つ・同じ順序・同じラベル。
 * iPadでも「同じ場所に同じものがある」ことを保つため、ここを独自に増やさない。
 */
export const SIDEBAR_TABS: readonly SidebarTab[] = [
	{ name: 'index', label: 'ホーム', href: '/', icon: 'home-outline', iconActive: 'home', badge: true },
	{ name: 'terminal', label: 'ターミナル', href: '/terminal', icon: 'terminal-outline', iconActive: 'terminal' },
	{ name: 'scm', label: 'ソース管理', href: '/scm', icon: 'git-branch-outline', iconActive: 'git-branch' },
	{ name: 'files', label: 'ファイル', href: '/files', icon: 'folder-outline', iconActive: 'folder' },
];

/**
 * タブ本体ではないが、そのタブから開くスタック画面。開いている間も出発点のタブを
 * 選択状態のままにして、「今どの区画にいるのか」を見失わせない
 * （iPhone版はスタック画面が全画面を覆うので同じ問題が起きない）。
 */
const HOME_DESCENDANTS = new Set([
	'/agent', '/agent-activity', '/agent-activity-detail', '/agent-launch',
	'/archive', '/notifications', '/browser',
]);

/**
 * 現在のパスから選択中のタブを決める。
 *
 * 設定やダッシュボード類（`/settings` `/ccusage` `/system` など）はサイドバーの
 * 設定ボタンから開くタブ非依存の画面なので、どのタブも選択しない（`undefined`）。
 */
export function activeSidebarTab(pathname: string): SidebarTab['name'] | undefined {
	// クエリやハッシュが付く場合に備えて落とす（`/browser?token=...` など）。
	const path = pathname.replace(/[?#].*$/, '');
	if (path === '/' || path === '/index' || HOME_DESCENDANTS.has(path)) {
		return 'index';
	}
	if (path === '/terminal' || path === '/scm' || path === '/files') {
		return path.slice(1) as SidebarTab['name'];
	}
	return undefined;
}

/**
 * スペースを切り替えた（または「すべて表示」を押した）ときに、ホームへ戻すべきか。
 *
 * ターミナル・ソース管理・ファイルの各タブは、いま選んでいるスペースの中身を映している。
 * スペースを変えたのにそこへ留まると、開いていたファイルや差分だけが前のスペースの文脈で
 * 残り、どちらの話を見ているのか分からなくなる。エージェント詳細のようなホーム配下の
 * スタック画面も同じ（そのエージェントは前のスペースのもの）。
 *
 * ただし設定やダッシュボード類（`/settings` `/ccusage` など）はスペースに属さないので閉じない。
 * スペースを選んだだけで開いていた設定が消えるのは、行き過ぎたお節介になる。
 */
export function shouldReturnHomeOnSpaceChange(pathname: string): boolean {
	const path = pathname.replace(/[?#].*$/, '');
	if (path === '/' || path === '/index') {
		return false;
	}
	// タブには属さないが、開いているスペースの持ち物を映している画面。
	// `/space-note` は開いてもドロワー／サイドバーを閉じないので、ここから
	// スペースを選び直せてしまう。畳まないと前のスペースのメモが残る。
	if (path === '/space-note') {
		return true;
	}
	return activeSidebarTab(path) !== undefined;
}
