/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「大きさの管理…」: 名前付きの大きさの一覧・追加・編集・削除・全体の既定に設定。
//
// モックの表形式の管理画面は次の PR に回し、ここではクイックピックで同じ操作をできるようにしている
// （行のボタンで編集・削除・既定に設定、先頭の行で追加）。スペースごとの既定は、chip の一覧の
// 「既定にする: このスペース」で付け外しする。

import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputButton, IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import {
	IParadisViewportSize,
	paradisFindViewportSize,
	paradisFormatViewportDimensions,
	paradisParseViewportDimensions,
	paradisSanitizeViewportName,
} from '../common/paradisBrowserViewport.js';
import { IParadisBrowserViewportService } from './paradisBrowserViewportService.js';

interface ISizeItem extends IQuickPickItem {
	readonly size?: IParadisViewportSize;
}

export async function paradisShowViewportManager(accessor: ServicesAccessor): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const viewportService = accessor.get(IParadisBrowserViewportService);

	const editButton: IQuickInputButton = { iconClass: ThemeIcon.asClassName(Codicon.edit), tooltip: localize('paradis.browserViewport.manage.edit', "編集") };
	const defaultButton: IQuickInputButton = { iconClass: ThemeIcon.asClassName(Codicon.pin), tooltip: localize('paradis.browserViewport.manage.setDefault', "全体の既定に設定") };
	const removeButton: IQuickInputButton = { iconClass: ThemeIcon.asClassName(Codicon.trash), tooltip: localize('paradis.browserViewport.manage.remove', "削除") };

	const store = new DisposableStore();
	const picker = store.add(quickInputService.createQuickPick<ISizeItem>());
	picker.title = localize('paradis.browserViewport.manage.title', "ブラウザの大きさ");
	picker.placeholder = localize('paradis.browserViewport.manage.placeholder', "選ぶと編集します。行の右のボタンで既定に設定・削除できます");

	const render = () => {
		const globalDefault = viewportService.getGlobalDefault();
		const items: ISizeItem[] = [{ label: `$(add) ${localize('paradis.browserViewport.manage.add', "大きさを追加…")}` }];
		for (const size of viewportService.getSizes()) {
			const isDefault = paradisFindViewportSize([size], globalDefault) !== undefined;
			const kind = size.mobile
				? localize('paradis.browserViewport.manage.mobile', "モバイル（タッチ）")
				: localize('paradis.browserViewport.manage.desktop', "パソコン");
			items.push({
				size,
				label: size.name,
				description: [paradisFormatViewportDimensions(size.width, size.height), kind, ...(isDefault ? [localize('paradis.browserViewport.manage.isDefault', "全体の既定")] : [])].join('  '),
				buttons: [editButton, defaultButton, removeButton],
			});
		}
		picker.items = items;
	};
	render();
	store.add(viewportService.onDidChange(() => render()));

	const edit = async (existing: IParadisViewportSize | undefined) => {
		picker.hide();
		const name = await quickInputService.input({
			prompt: localize('paradis.browserViewport.manage.namePrompt', "名前"),
			value: existing?.name ?? '',
			validateInput: async value => paradisSanitizeViewportName(value) ? undefined : localize('paradis.browserViewport.save.invalid', "1〜40 文字で、「1366x768」の形ではない名前にしてください。"),
		});
		const cleaned = name !== undefined ? paradisSanitizeViewportName(name) : undefined;
		if (!cleaned) {
			return;
		}
		const dimensionsText = await quickInputService.input({
			prompt: localize('paradis.browserViewport.manage.sizePrompt', "大きさ（幅x高さ。例: 1366x768）"),
			value: existing ? `${existing.width}x${existing.height}` : '',
			validateInput: async value => paradisParseViewportDimensions(value) ? undefined : localize('paradis.browserViewport.manage.sizeInvalid', "「1366x768」の形で、100〜9999 の数を入れてください。"),
		});
		const dimensions = dimensionsText !== undefined ? paradisParseViewportDimensions(dimensionsText) : undefined;
		if (!dimensions) {
			return;
		}
		const size: IParadisViewportSize = { ...existing, name: cleaned, width: dimensions.width, height: dimensions.height };
		if (existing) {
			await viewportService.replaceSize(existing.name, size);
		} else {
			viewportService.saveSize(size);
		}
	};

	store.add(picker.onDidTriggerItemButton(event => {
		const size = event.item.size;
		if (!size) {
			return;
		}
		if (event.button === editButton) {
			void edit(size);
		} else if (event.button === defaultButton) {
			void viewportService.setGlobalDefault(size.name);
		} else if (event.button === removeButton) {
			viewportService.removeSize(size.name);
		}
	}));
	store.add(picker.onDidAccept(() => {
		const item = picker.selectedItems[0];
		void edit(item?.size);
	}));
	store.add(picker.onDidHide(() => store.dispose()));
	picker.show();
}
