/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ソース管理のグラフのホバーに、ホバーを出したコミットの変更量だけを後から差し込む。
// 本家の Git の拡張機能は履歴を読むときの `--shortstat` をやめている (extensions/git/src/historyProvider.ts の
// PARA-PATCH)。ここでは、ホバーが出たときに `resolveHistoryItem` (1 件の `git show --shortstat`) で数え、
// 数え終わるまで「変更量を数えています…」を出し、終わったらその行を数字に差し替える。
// 呼び出し元は src/vs/workbench/contrib/scm/browser/scmHistoryViewPane.ts の renderElement (PARA-PATCH)。

import { $, append, isHTMLElement } from '../../../../base/browser/dom.js';
import { IHoverOptions } from '../../../../base/browser/ui/hover/hover.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { asCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { historyItemHoverAdditionsForeground, historyItemHoverDeletionsForeground } from '../../../../workbench/contrib/scm/browser/scmHistory.js';
import { ISCMHistoryItemViewModel } from '../../../../workbench/contrib/scm/common/history.js';
import { ISCMProvider } from '../../../../workbench/contrib/scm/common/scm.js';
import { IParadisScmGraphStats, ParadisScmGraphStatsCache, paradisHasScmGraphStats } from '../common/paradisScmGraphStatsCache.js';

const sharedCache = new ParadisScmGraphStatsCache();

/** ホバーの設定に足す口と、行が描き直されたときの後片付け。 */
export interface IParadisScmGraphLazyStats extends IDisposable {
	readonly hoverOptions: Pick<IHoverOptions, 'onDidShow' | 'onDidHide'>;
}

const NONE: IParadisScmGraphLazyStats = { hoverOptions: {}, dispose: () => { } };

/**
 * グラフの 1 行のホバーに、変更量の行を後から入れる仕掛けを付ける。
 * 変更量が既にある (他の拡張機能が数えて渡している) 行、ホバーの中身が HTML でない行、
 * 未取得・未送信の変更の行には何もしない。
 */
export function paradisSetupScmGraphLazyStats(content: unknown, provider: ISCMProvider, viewModel: ISCMHistoryItemViewModel, cache: ParadisScmGraphStatsCache = sharedCache): IParadisScmGraphLazyStats {
	const historyItem = viewModel.historyItem;
	if (!isHTMLElement(content) || historyItem.statistics !== undefined || viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes') {
		return NONE;
	}

	const key = `${provider.id}\0${historyItem.id}`;
	let section: HTMLElement | undefined;
	let request: CancellationTokenSource | undefined;

	const removeSection = () => {
		section?.remove();
		section = undefined;
	};
	const cancel = () => {
		request?.dispose(true);
		request = undefined;
	};
	const showSection = (stats: IParadisScmGraphStats | undefined) => {
		removeSection();
		section = createSection(stats);
		// 本家の並び (作者とメッセージ → 変更量 → ブランチの札 → コマンド) に合わせ、先頭の節の直後に入れる。
		content.insertBefore(section, content.firstElementChild?.nextSibling ?? null);
	};

	const onDidShow = () => {
		const cached = cache.get(key);
		if (cached !== undefined) {
			if (paradisHasScmGraphStats(cached)) {
				showSection(cached);
			}
			return;
		}

		const historyProvider = provider.historyProvider.get();
		if (!historyProvider) {
			return;
		}

		cancel();
		const source = request = new CancellationTokenSource();
		showSection(undefined);
		cache.request(key, async token => (await historyProvider.resolveHistoryItem(historyItem.id, token))?.statistics, source.token).then(stats => {
			if (source.token.isCancellationRequested) {
				return;
			}
			request = undefined;
			source.dispose();
			if (paradisHasScmGraphStats(stats)) {
				showSection(stats);
			} else {
				// 失敗・タイムアウト・変更なしは、数字の行を出さない。
				removeSection();
			}
		});
	};

	const onDidHide = () => {
		// ホバーが消えたら結果を捨てる。数え終わる前なら「数えています…」も消し、次に出たときにまた数える。
		if (request !== undefined) {
			cancel();
			removeSection();
		}
	};

	return {
		hoverOptions: { onDidShow, onDidHide },
		dispose: () => {
			cancel();
		},
	};
}

/** 本家の Git の拡張機能 (extensions/git/src/hover.ts の appendShortStats) と同じ見た目の 1 節を作る。stats が無ければ「数えています…」。 */
function createSection(stats: IParadisScmGraphStats | undefined): HTMLElement {
	const section = $('div.rendered-markdown.paradis-scm-graph-lazy-stats');
	const paragraph = append(section, $('p'));

	if (stats === undefined) {
		const pending = append(paragraph, $('span'));
		pending.textContent = localize('paradis.scmGraphLazyStats.counting', "変更量を数えています…");
		pending.style.opacity = '0.7';
	} else {
		append(paragraph, $('span')).textContent = localize('paradis.scmGraphLazyStats.files', "{0} 個のファイルが変更済み", stats.files);
		if (stats.insertions) {
			paragraph.append(', ');
			const insertions = append(paragraph, $('span'));
			insertions.style.color = asCssVariable(historyItemHoverAdditionsForeground);
			insertions.textContent = localize('paradis.scmGraphLazyStats.insertions', "{0} 個の挿入{1}", stats.insertions, '(+)');
		}
		if (stats.deletions) {
			paragraph.append(', ');
			const deletions = append(paragraph, $('span'));
			deletions.style.color = asCssVariable(historyItemHoverDeletionsForeground);
			deletions.textContent = localize('paradis.scmGraphLazyStats.deletions', "{0} 個の削除{1}", stats.deletions, '(-)');
		}
	}

	append(section, $('hr'));
	return section;
}
