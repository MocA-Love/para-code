/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMobileDevice } from '../../common/paradisMobileCanvas.js';
import { IParadisMobileTarget, IParadisMobileToolResult, PARADIS_MOBILE_DEVICE_ARGUMENT, PARADIS_MOBILE_MAX_DEVICES_PER_PANE, PARADIS_MOBILE_NO_DEVICE_MESSAGE, ParadisMobileAttachmentBook, paradisStampMobileDevice, paradisWithMobileDeviceArgument } from '../../common/paradisMobileAttachmentBook.js';

const PANE = 'pane-a';
const OTHER = 'pane-b';

function device(id: string, name = id, extra: Partial<IParadisMobileDevice> = {}): IParadisMobileDevice {
	return { id, udid: `udid-of-${id}`, name, platform: 'ios', state: 'booted', isRunning: true, ...extra };
}

const IPHONE = device('ios:iphone', 'iPhone 17');
const PIXEL = device('android:serial:emulator-5556', 'Para_Code_CLI_Test', { platform: 'android', udid: 'emulator-5556', avdId: 'android:avd:Para_Code_CLI_Test' });
const IPAD = device('ios:ipad', 'iPad Air');
const DEVICES = [IPHONE, PIXEL, IPAD];

suite('Paradis mobile: the devices of one terminal pane (up to ten)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const failure = (promise: Promise<unknown>) => promise.then(() => 'resolved', error => (error as Error).message);

	test('adds devices up to the limit, never twice, and the one attached last is the current one', () => {
		const book = new ParadisMobileAttachmentBook();
		const many = Array.from({ length: PARADIS_MOBILE_MAX_DEVICES_PER_PANE + 1 }, (_, index) => device(`ios:sim-${index}`));
		const results = many.map((entry, index) => book.attach(PANE, entry, many, undefined, index));
		const again = book.attach(PANE, many[2], many, undefined, 99);
		// 上限のとき: 外す端末を選べば、外すのと足すのを一度に行う。そのペインの端末でない id では何も変えない
		const foreign = book.attach(PANE, many[10], many, undefined, 100, { releaseDeviceId: 'ios:elsewhere' });
		const swapped = book.attach(PANE, many[10], many, undefined, 101, { releaseDeviceId: 'ios:sim-0' });
		assert.deepStrictEqual({
			added: results.map(result => result.refused !== undefined ? result.refused : result.added),
			again: again.refused !== undefined ? again.refused : [again.attachment.deviceId, again.added],
			foreign,
			swapped: swapped.refused !== undefined ? swapped.refused : [swapped.attachment.deviceId, swapped.released?.deviceId],
			pane: book.listPane(PANE).map(attachment => attachment.deviceId),
			current: book.list().filter(attachment => attachment.current).map(attachment => attachment.deviceId),
		}, {
			added: [...Array.from({ length: PARADIS_MOBILE_MAX_DEVICES_PER_PANE }, () => true), 'full'],
			again: ['ios:sim-2', false],
			foreign: { refused: 'releaseNotAttached' },
			swapped: ['ios:sim-10', 'ios:sim-0'],
			pane: ['ios:sim-1', 'ios:sim-2', 'ios:sim-3', 'ios:sim-4', 'ios:sim-5', 'ios:sim-6', 'ios:sim-7', 'ios:sim-8', 'ios:sim-9', 'ios:sim-10'],
			current: ['ios:sim-10'],
		});
	});

	test('an agent request never takes a device another pane uses, and a pane never holds one device under two ids', () => {
		const book = new ParadisMobileAttachmentBook();
		// 起動する前の AVD で割り当てた端末（台帳の id は起動前のもの）
		const stopped = device('android:avd:Para_Code_CLI_Test', 'Para_Code_CLI_Test', { platform: 'android', udid: undefined, isRunning: false });
		book.attach(OTHER, stopped, [IPHONE, stopped], undefined, 0);
		const taken = book.attach(PANE, PIXEL, DEVICES, undefined, 1, { onlyIfFree: true });
		// 利用者が共有ダイアログから渡すときは、同じ端末を複数のペインへ渡せる
		const byUser = book.attach(PANE, PIXEL, DEVICES, undefined, 2);
		const sameUnderNewId = book.attach(OTHER, PIXEL, DEVICES, undefined, 3);
		assert.deepStrictEqual({
			taken,
			byUser: byUser.refused !== undefined ? byUser.refused : byUser.added,
			sameUnderNewId: sameUnderNewId.refused !== undefined ? sameUnderNewId.refused : [sameUnderNewId.attachment.deviceId, sameUnderNewId.added],
			held: book.findInPane(OTHER, PIXEL, DEVICES)?.deviceId,
			other: book.listPane(OTHER).length,
		}, {
			taken: { refused: 'heldByAnotherPane' },
			byUser: true,
			sameUnderNewId: ['android:avd:Para_Code_CLI_Test', false],
			held: 'android:avd:Para_Code_CLI_Test',
			other: 1,
		});
	});

	// device を省いたら最後に割り当てた端末。device を付けた呼び出しでは、省いたときの端末を動かさない
	test('a tool acts on the device it names, or on the one attached last; naming a device does not change that', async () => {
		const book = new ParadisMobileAttachmentBook();
		book.attach(PANE, IPHONE, DEVICES, undefined, 0);
		book.attach(PANE, PIXEL, DEVICES, undefined, 1);
		book.attach(OTHER, IPAD, DEVICES, undefined, 2);
		let listed = 0;
		const list = async () => {
			listed++;
			return DEVICES;
		};
		const resolve = (wanted: unknown) => book.resolve(PANE, wanted, list, 10).then(target => [target.attachment.deviceId, target.byDefault, target.attachedCount]);
		const results = {
			omitted: await resolve(undefined),
			empty: await resolve('  '),
			byId: await resolve('ios:iphone'),
			byName: await resolve('iPhone 17'),
			afterNaming: await resolve(undefined),
		};
		const listedForStoredIds = listed;
		assert.deepStrictEqual({
			results,
			listedForStoredIds,
			// 一覧の今の番号（UDID / シリアル）・起動前の id でも引ける
			bySerial: await resolve('emulator-5556'),
			byAvdId: await resolve('android:avd:Para_Code_CLI_Test'),
			// ほかのペインの端末は、id を知っていても引けない
			foreign: await failure(resolve('ios:ipad')),
			notAString: await failure(resolve(7)),
			emptyPane: await failure(book.resolve('pane-none', undefined, list, 10)),
		}, {
			results: {
				omitted: ['android:serial:emulator-5556', true, 2],
				empty: ['android:serial:emulator-5556', true, 2],
				byId: ['ios:iphone', false, 2],
				byName: ['ios:iphone', false, 2],
				afterNaming: ['android:serial:emulator-5556', true, 2],
			},
			// 台帳の id・名前で決まるときは、端末の一覧を取りに行かない
			listedForStoredIds: 0,
			bySerial: ['android:serial:emulator-5556', false, 2],
			byAvdId: ['android:serial:emulator-5556', false, 2],
			foreign: '"ios:ipad" is not attached to this terminal pane. Attached: iPhone 17 (ios:iphone), Para_Code_CLI_Test (android:serial:emulator-5556). Pass one of these as "device" (id or exact name), or call mobile_request_device to ask the user for another device.',
			notAString: '"device" must be the id or the exact name of a device attached to this terminal pane.',
			emptyPane: PARADIS_MOBILE_NO_DEVICE_MESSAGE,
		});
	});

	test('two attached devices with the same name must be named by id, and detaching the current device makes the previous one current', async () => {
		const book = new ParadisMobileAttachmentBook();
		const first = device('ios:one', 'iPhone 17');
		const second = device('ios:two', 'iPhone 17');
		const all = [first, second, PIXEL];
		book.attach(PANE, first, all, undefined, 0);
		book.attach(PANE, second, all, undefined, 1);
		book.attach(PANE, PIXEL, all, undefined, 2);
		const current = async () => (await book.resolve(PANE, undefined, async () => all, 5)).attachment.deviceId;
		const before = await current();
		const ambiguous = await failure(book.resolve(PANE, 'iPhone 17', async () => all, 5));
		const removedOne = book.detach(PANE, 'android:serial:emulator-5556').map(attachment => attachment.deviceId);
		const afterOne = await current();
		const removedAll = book.detach(PANE).length;
		assert.deepStrictEqual({ before, ambiguous, removedOne, afterOne, removedAll, left: book.list().length, nothing: book.detach(PANE, 'ios:one') }, {
			before: 'android:serial:emulator-5556',
			ambiguous: 'More than one device attached to this terminal pane is named "iPhone 17". Pass its id instead: iPhone 17 (ios:one), iPhone 17 (ios:two).',
			removedOne: ['android:serial:emulator-5556'],
			afterOne: 'ios:two',
			removedAll: 2,
			left: 0,
			nothing: [],
		});
	});

	// 端末の名前はエージェントも付けられる。ほかの端末の id と同じ名前を付けた端末があっても、id を渡した呼び出しは id の端末へ行く
	test('an id is matched as an id before it is matched as a name', async () => {
		const book = new ParadisMobileAttachmentBook();
		const stopped = device('android:avd:Para_Code_CLI_Test', 'Para_Code_CLI_Test', { platform: 'android', udid: undefined, isRunning: false });
		const impostors = ['android:serial:emulator-5556', 'emulator-5556', 'A1B2C3D4-0000-1111-2222-333344445555'].map((name, index) => device(`ios:impostor-${index}`, name));
		const before = [IPHONE, stopped, ...impostors];
		// 起動前の id で割り当てた Android と、その起動後の id・シリアルと同じ名前を付けた端末
		book.attach(PANE, stopped, before, undefined, 0);
		impostors.forEach((impostor, index) => book.attach(PANE, impostor, before, undefined, index + 1));
		const uuidDevice = device('ios:real', 'Real', { udid: 'A1B2C3D4-0000-1111-2222-333344445555' });
		book.attach(PANE, uuidDevice, [...before, uuidDevice], undefined, 9);
		const after = [IPHONE, PIXEL, ...impostors, uuidDevice];
		const resolve = async (wanted: string) => (await book.resolve(PANE, wanted, async () => after, 10)).attachment.deviceId;
		assert.deepStrictEqual({
			byLiveId: await resolve('android:serial:emulator-5556'),
			bySerial: await resolve('emulator-5556'),
			byUdid: await resolve('A1B2C3D4-0000-1111-2222-333344445555'),
			// id の形でない名前は、名前で引ける
			byName: await resolve('Real'),
			// 一覧を読めないときは、id の形の文字列を名前では決めない（同じ名前を付けた端末へ当てない）。台帳の id はそのまま引ける
			listFails: await failure(book.resolve(PANE, 'emulator-5556', async () => { throw new Error('adb is gone'); }, 10)).then(message => message.startsWith('Para Code could not read the device list')),
			storedIdWhenListFails: (await book.resolve(PANE, 'ios:impostor-1', async () => { throw new Error('adb is gone'); }, 10)).attachment.deviceName,
		}, {
			listFails: true,
			storedIdWhenListFails: 'emulator-5556',
			byLiveId: 'android:avd:Para_Code_CLI_Test',
			bySerial: 'android:avd:Para_Code_CLI_Test',
			byUdid: 'ios:real',
			byName: 'ios:real',
		});
	});

	// 24 時間の掃除は端末ごと: 使っている端末を残し、使っていない端末だけを落とす
	test('drops only the devices no tool used since the cutoff', async () => {
		const book = new ParadisMobileAttachmentBook();
		book.attach(PANE, IPHONE, DEVICES, undefined, 0);
		book.attach(PANE, PIXEL, DEVICES, undefined, 0);
		book.attach(OTHER, IPAD, DEVICES, undefined, 0);
		await book.resolve(PANE, 'iPhone 17', async () => DEVICES, 100);
		const dropped = book.sweep(50).map(entry => entry.attachment.deviceId).sort();
		book.touchPane(PANE, 200);
		assert.deepStrictEqual({ dropped, left: book.list().map(attachment => attachment.deviceId), later: book.sweep(150).length }, {
			dropped: ['android:serial:emulator-5556', 'ios:ipad'],
			left: ['ios:iphone'],
			later: 0,
		});
	});

	// 返事には、操作した端末の名前と id を必ず入れる（端末の取り違えに、その場で気付けるように）
	test('every answer names the device it acted on, in JSON answers, sentences, errors and images', () => {
		const attachment = { paneToken: PANE, deviceId: 'ios:iphone', deviceName: 'iPhone 17', stateKey: undefined, attachedAt: 0 };
		const named: IParadisMobileTarget = { attachment, byDefault: false, attachedCount: 2 };
		const defaulted: IParadisMobileTarget = { attachment, byDefault: true, attachedCount: 2 };
		const only: IParadisMobileTarget = { attachment, byDefault: true, attachedCount: 1 };
		const value = { tapped: 'Save' };
		const json = paradisStampMobileDevice({ content: [{ type: 'text', text: JSON.stringify(value, undefined, 2) }], structuredContent: value }, named);
		const display = { pointWidth: 402 };
		const image = paradisStampMobileDevice({ content: [{ type: 'text', text: 'Screenshot is 1206x2622 pixels.' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], structuredContent: display }, named);
		const note = '"device" was omitted, so this used the pane\'s current device (the one attached last). 2 devices are attached to this pane: pass "device" to choose.';
		assert.deepStrictEqual({
			json: [JSON.parse((json.content[0] as { text: string }).text), json.structuredContent],
			sentence: paradisStampMobileDevice({ content: [{ type: 'text', text: 'Tapped iPhone 17 at (1, 2).' }] }, named),
			error: paradisStampMobileDevice({ content: [{ type: 'text', text: 'touch rejected' }], isError: true }, defaulted),
			image: [image.content.map(block => block.type === 'text' ? block.text : block.type), image.structuredContent],
			defaultedJson: (paradisStampMobileDevice<IParadisMobileToolResult>({ content: [{ type: 'text', text: JSON.stringify(value, undefined, 2) }], structuredContent: value }, defaulted).structuredContent as { device: object }).device,
			onlyDevice: paradisStampMobileDevice({ content: [{ type: 'text', text: 'Done.' }] }, only).content,
		}, {
			json: [{ tapped: 'Save', device: { id: 'ios:iphone', name: 'iPhone 17' } }, { tapped: 'Save', device: { id: 'ios:iphone', name: 'iPhone 17' } }],
			sentence: { content: [{ type: 'text', text: 'Tapped iPhone 17 at (1, 2).\nDevice: iPhone 17 (ios:iphone).' }] },
			error: { content: [{ type: 'text', text: `touch rejected\nDevice: iPhone 17 (ios:iphone). ${note}` }], isError: true },
			image: [['Screenshot is 1206x2622 pixels.\nDevice: iPhone 17 (ios:iphone).', 'image'], { pointWidth: 402, device: { id: 'ios:iphone', name: 'iPhone 17' } }],
			defaultedJson: { id: 'ios:iphone', name: 'iPhone 17', note },
			// 1 台だけのときは、省いたことを知らせない
			onlyDevice: [{ type: 'text', text: 'Done.\nDevice: iPhone 17 (ios:iphone).' }],
		});
	});

	test('the optional "device" argument is added to a tool without touching its other arguments', () => {
		const tool = { name: 'mobile_tap', inputSchema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false } };
		assert.deepStrictEqual([paradisWithMobileDeviceArgument(tool), tool.inputSchema.properties], [
			{ name: 'mobile_tap', inputSchema: { type: 'object', properties: { x: { type: 'number' }, device: PARADIS_MOBILE_DEVICE_ARGUMENT }, required: ['x'], additionalProperties: false } },
			{ x: { type: 'number' } },
		]);
	});
});
