/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import { deepStrictEqual, ok, strictEqual } from 'assert';
import { importAMDNodeModule } from '../../../../../amdX.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/index.js';
import { FileChangesEvent, FileChangeType, IFileService, IFileSystemWatcher } from '../../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { IOverlayWebview, IWebviewService } from '../../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../../workbench/contrib/webview/common/webview.js';
import { ITextFileService } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { TestEditorGroupView, TestLayoutService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { getParadisDocxRenderDecision, isParadisDocxHeader, ParadisDocxFileEditor, readParadisDocxHeader } from '../../electron-browser/paradisDocxFileEditor.js';
import { buildParadisDocxDiffHtml, sanitizeParadisDocxBytesForRenderer } from '../../electron-browser/paradisDocxDiffWebview.js';
import { ParadisDocxInput } from '../../electron-browser/paradisDocxInput.js';

interface IDocxEditorSnapshot {
	readonly watcherResources: readonly string[];
	readonly readResources: readonly string[];
	readonly readOptions: readonly { readonly length: number }[];
	readonly claims: number;
	readonly releases: number;
	readonly htmlDocuments: readonly string[];
	readonly overlayCallsAfterDispose: number;
}

interface IDocxHtmlSnapshot {
	readonly classification: 'viewer' | 'rejected' | 'unknown';
	readonly docxUrl?: string;
	readonly csp?: string;
	readonly scriptUrls?: readonly string[];
	readonly nonceConsistency?: {
		readonly csp: boolean;
		readonly externalScripts: boolean;
		readonly inlineScript: boolean;
	};
	readonly renderOptions?: {
		readonly ignoreWidth: boolean | undefined;
		readonly ignoreHeight: boolean | undefined;
		readonly breakPages: boolean | undefined;
		readonly ignoreLastRenderedPageBreak: boolean | undefined;
		readonly experimental: boolean | undefined;
		readonly renderHeaders: boolean | undefined;
		readonly renderFooters: boolean | undefined;
		readonly renderFootnotes: boolean | undefined;
		readonly renderEndnotes: boolean | undefined;
		readonly useBase64URL: boolean | undefined;
		readonly ignoreFonts: boolean | undefined;
		readonly renderAltChunks: boolean | undefined;
	};
}

type HeaderResult = VSBuffer | DeferredPromise<VSBuffer> | Error;

suite('ParadisDocxFileEditor', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const defaultDocxPackage = storeZip({ '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>' });

	test('integrates exact mounted and fallback CSP sources into the Word diff webview', () => {
		const labels = { original: 'Before', modified: 'After', loading: 'Loading' };
		const cspOf = (html: string): string => /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? '';
		const mounted = cspOf(buildParadisDocxDiffHtml(labels, 'http://127.0.0.1:43123/docx-preview'));
		const fallback = cspOf(buildParadisDocxDiffHtml(labels, 'https://file+.vscode-resource.vscode-cdn.net/docx-preview'));

		ok(mounted.includes('script-src \'nonce-'));
		ok(mounted.includes(' http://127.0.0.1:43123;'));
		ok(!mounted.includes('https:'));
		ok(fallback.includes(' https://file+.vscode-resource.vscode-cdn.net;'));
		ok(!/(?:^|\s)https:(?:\s|;|$)/.test(fallback));
		for (const csp of [mounted, fallback]) {
			ok(csp.includes('object-src \'none\'; frame-src \'none\'; worker-src \'none\';'));
			ok(csp.includes('navigate-to \'none\';'));
		}
	});

	test('preprocesses unsafe package assets before the real browser archive result reaches either renderer', async () => {
		const input = storeZip({
			'[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/media/unsafe.svg" ContentType="image/svg+xml"/><Override PartName="/word/fonts/font.odttf" ContentType="application/x-font-ttf"/><Override PartName="/word/afchunk/chunk.html" ContentType="text/html"/></Types>',
			'_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:drawing><a:blip r:embed="svg"/></w:drawing></w:r></w:p></w:body></w:document>',
			'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="svg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/unsafe.svg"/><Relationship Id="font" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font.odttf"/><Relationship Id="chunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="afchunk/chunk.html"/></Relationships>',
			'word/media/unsafe.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>danger</script></svg>',
			'word/fonts/font.odttf': 'RAW-FONT',
			'word/afchunk/chunk.html': '<script>ALTCHUNK</script>',
		});

		const result = await sanitizeParadisDocxBytesForRenderer(input, 'integration_package');
		const serialized = new TextDecoder().decode(result.bytes);
		const reopened = await sanitizeParadisDocxBytesForRenderer(result.bytes, 'integration_reopen');

		strictEqual(serialized.includes('<script>'), false);
		strictEqual(serialized.includes('RAW-FONT'), false);
		strictEqual(serialized.includes('ALTCHUNK'), false);
		ok(serialized.includes('Office asset unavailable'));
		strictEqual(result.placeholders.length, 3);
		ok(reopened.bytes.byteLength > 0);
	});

	test('renders one visible body altChunk anchor through the actual docx-preview parser and renderer', async () => {
		const input = storeZip({
			'[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/afchunk/chunk.html" ContentType="text/html"/></Types>',
			'_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Before</w:t></w:r></w:p><w:altChunk r:id="chunk"/><w:sectPr/></w:body></w:document>',
			'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="chunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="afchunk/chunk.html"/></Relationships>',
			'word/afchunk/chunk.html': '<p>UNSAFE-HTML</p>',
		});
		const sanitized = await sanitizeParadisDocxBytesForRenderer(input, 'actual-docx-preview');
		const docx = await loadActualDocxPreview();
		const body = document.createElement('div');
		const styles = document.createElement('div');
		const arrayBuffer = sanitized.bytes.buffer.slice(sanitized.bytes.byteOffset, sanitized.bytes.byteOffset + sanitized.bytes.byteLength) as ArrayBuffer;

		await docx.renderAsync(arrayBuffer, body, styles, {
			ignoreFonts: true,
			renderAltChunks: false,
			renderHeaders: true,
			renderFooters: true,
			renderFootnotes: true,
			renderEndnotes: true,
		});

		strictEqual((body.textContent?.match(/Office asset unavailable:/g) ?? []).length, 1);
		strictEqual(body.textContent?.includes('UNSAFE-HTML'), false);
	});

	test('reopens and renders an exact numbering picture bullet through the actual docx-preview parser', async () => {
		const input = storeZip({
			'[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/media/bullet.svg" ContentType="image/svg+xml"/></Types>',
			'_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Picture bullet visible</w:t></w:r></w:p></w:body></w:document>',
			'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="numbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
			'word/numbering.xml': '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:numPicBullet w:numPicBulletId="1"><w:pict><v:shape style="width:8pt;height:8pt"><v:imagedata r:id="bullet"/></v:shape></w:pict></w:numPicBullet><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:lvlPicBulletId w:val="1"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
			'word/_rels/numbering.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="bullet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/bullet.svg"/></Relationships>',
			'word/media/bullet.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>',
		});
		const sanitized = await sanitizeParadisDocxBytesForRenderer(input, 'actual-picture-bullet');
		const reopened = await sanitizeParadisDocxBytesForRenderer(sanitized.bytes, 'actual-picture-bullet-reopen');
		const docx = await loadActualDocxPreview();
		const body = document.createElement('div');
		const styles = document.createElement('div');
		const arrayBuffer = reopened.bytes.buffer.slice(reopened.bytes.byteOffset, reopened.bytes.byteOffset + reopened.bytes.byteLength) as ArrayBuffer;

		await docx.renderAsync(arrayBuffer, body, styles, { ignoreFonts: true, renderAltChunks: false });

		ok(body.textContent?.includes('Picture bullet visible'));
		ok([...body.querySelectorAll('p')].some(paragraph => paragraph.className.includes('-num-1-0')));
		ok(styles.textContent?.includes(':before'));
		ok(styles.textContent?.includes('background: var('));
	});

	test('reopens an MC QName document and renders its locally patched DrawingML anchor', async () => {
		const geometry = '<wp:anchor><wp:positionH relativeFrom="column"><wp:posOffset>101</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>202</wp:posOffset></wp:positionV><wp:extent cx="303" cy="404"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="blocked"/></pic:blipFill><pic:spPr><a:xfrm rot="5400000"><a:off x="11" y="22"/><a:ext cx="33" cy="44"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor>';
		const input = storeZip({
			'[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/custom/ole.bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/></Types>',
			'_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
			'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" mc:Ignorable="wps"><w:body><mc:AlternateContent><mc:Choice Requires="wps"><w:p><w:r><w:t>MC choice</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>MC fallback</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent><w:p><w:r><w:t>MC anchor</w:t></w:r><w:r><w:drawing>${geometry}</w:drawing></w:r></w:p></w:body></w:document>`,
			'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="blocked" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../custom/ole.bin"/></Relationships>',
			'custom/ole.bin': 'RAW-OLE',
		});
		const sanitized = await sanitizeParadisDocxBytesForRenderer(input, 'actual-mc-anchor');
		const serialized = new TextDecoder().decode(sanitized.bytes);
		ok(serialized.includes('mc:Ignorable="wps"'));
		ok(serialized.includes('<mc:Choice Requires="wps">'));
		ok(serialized.includes(geometry.replace(' r:embed="blocked"', '')));
		const reopened = await sanitizeParadisDocxBytesForRenderer(sanitized.bytes, 'actual-mc-anchor-reopen');
		const docx = await loadActualDocxPreview();
		const body = document.createElement('div');
		const styles = document.createElement('div');
		const arrayBuffer = reopened.bytes.buffer.slice(reopened.bytes.byteOffset, reopened.bytes.byteOffset + reopened.bytes.byteLength) as ArrayBuffer;

		await docx.renderAsync(arrayBuffer, body, styles, { ignoreFonts: true, renderAltChunks: false });

		ok(body.textContent?.includes('Office asset unavailable:'));
		strictEqual(body.textContent?.includes('RAW-OLE'), false);
	});

	function createDocxEditorFixture() {
		const watcherResources: string[] = [];
		const readResources: string[] = [];
		const readOptions: { length: number }[] = [];
		const htmlDocuments: string[] = [];
		const rawHtmlDocuments: string[] = [];
		const localResourceRootsAtSetHtml: string[][] = [];
		const watcherEmitters = new Map<string, Emitter<FileChangesEvent>[]>();
		const queuedHeaders = new Map<string, HeaderResult[]>();
		const watcherFailures = new Set<string>();
		let claims = 0;
		let releases = 0;
		let overlayCallsAfterDispose = 0;
		let overlayDisposed = false;

		const recordOverlayCall = () => {
			if (overlayDisposed) {
				overlayCallsAfterDispose++;
			}
		};
		const classifyHtml = (html: string): string => {
			if (html.includes('Word 文書を表示できませんでした: ファイルが空または破損しています')) {
				return 'rejected';
			}
			return html.includes('id="content"') ? 'viewer' : 'unknown';
		};
		const extractHtmlSnapshot = (html: string): IDocxHtmlSnapshot => {
			const classification = classifyHtml(html) as IDocxHtmlSnapshot['classification'];
			if (classification !== 'viewer') {
				return { classification };
			}
			const docxUrlMatch = /const DOCX_URL = ("(?:[^"\\]|\\.)*");/.exec(html);
			const parsedDocxUrl = docxUrlMatch ? JSON.parse(docxUrlMatch[1]) as string : undefined;
			const cspMatch = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
			const styleNonce = /<style nonce="([^"]+)">/.exec(html)?.[1];
			const cspNonce = /script-src 'nonce-([^']+)'/.exec(cspMatch?.[1] ?? '')?.[1];
			const scriptMatches = [...html.matchAll(/<script nonce="([^"]+)"(?: src="([^"]+)")?>/g)];
			const externalScripts = scriptMatches.filter(match => match[2] !== undefined);
			const inlineScripts = scriptMatches.filter(match => match[2] === undefined);
			const readBooleanOption = (name: string): boolean | undefined => {
				const match = new RegExp(`\\b${name}: (true|false)`).exec(html);
				return match ? match[1] === 'true' : undefined;
			};
			return {
				classification,
				docxUrl: parsedDocxUrl?.startsWith('data:') ? '<sanitized-docx-data>' : parsedDocxUrl,
				csp: styleNonce ? cspMatch?.[1].replace(`nonce-${styleNonce}`, 'nonce-<nonce>') : cspMatch?.[1],
				scriptUrls: externalScripts.map(match => match[2]),
				nonceConsistency: {
					csp: styleNonce !== undefined && cspNonce === styleNonce,
					externalScripts: styleNonce !== undefined && externalScripts.length === 2 && externalScripts.every(match => match[1] === styleNonce),
					inlineScript: styleNonce !== undefined && inlineScripts.length === 1 && inlineScripts[0][1] === styleNonce,
				},
				renderOptions: {
					ignoreWidth: readBooleanOption('ignoreWidth'),
					ignoreHeight: readBooleanOption('ignoreHeight'),
					breakPages: readBooleanOption('breakPages'),
					ignoreLastRenderedPageBreak: readBooleanOption('ignoreLastRenderedPageBreak'),
					experimental: readBooleanOption('experimental'),
					renderHeaders: readBooleanOption('renderHeaders'),
					renderFooters: readBooleanOption('renderFooters'),
					renderFootnotes: readBooleanOption('renderFootnotes'),
					renderEndnotes: readBooleanOption('renderEndnotes'),
					useBase64URL: readBooleanOption('useBase64URL'),
					ignoreFonts: readBooleanOption('ignoreFonts'),
					renderAltChunks: readBooleanOption('renderAltChunks'),
				},
			};
		};

		const webview = {
			container: document.createElement('div'),
			contentOptions: {},
			claim: () => {
				recordOverlayCall();
				claims++;
			},
			release: () => {
				recordOverlayCall();
				releases++;
			},
			setAnchorElement: () => recordOverlayCall(),
			setHtml: (html: string) => {
				recordOverlayCall();
				htmlDocuments.push(classifyHtml(html));
				rawHtmlDocuments.push(html);
				const contentOptions = webview.contentOptions as { readonly localResourceRoots?: readonly URI[] };
				localResourceRootsAtSetHtml.push(contentOptions.localResourceRoots?.map(root => root.toString()) ?? []);
			},
			focus: () => recordOverlayCall(),
			dispose: () => {
				overlayDisposed = true;
			},
		} as unknown as IOverlayWebview;
		const webviewService = {
			createWebviewOverlay: () => webview,
		} as unknown as IWebviewService;
		const fileService = {
			createWatcher: (resource: URI): IFileSystemWatcher => {
				watcherResources.push(resource.toString());
				if (watcherFailures.has(resource.toString())) {
					throw new Error('watcher unavailable');
				}
				const onDidChange = disposables.add(new Emitter<FileChangesEvent>());
				const emitters = watcherEmitters.get(resource.toString()) ?? [];
				emitters.push(onDidChange);
				watcherEmitters.set(resource.toString(), emitters);
				return {
					onDidChange: onDidChange.event,
					dispose: () => onDidChange.dispose(),
				};
			},
			readFile: async (resource: URI, options: { length?: number; limits?: { readonly size: number } }) => {
				if (options.length !== 4) {
					return { value: VSBuffer.wrap(defaultDocxPackage.slice()) };
				}
				readResources.push(resource.toString());
				readOptions.push({ length: options.length });
				const queue = queuedHeaders.get(resource.toString());
				const result = queue?.shift() ?? VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04));
				if (result instanceof Error) {
					throw result;
				}
				return { value: result instanceof DeferredPromise ? await result.p : result };
			},
		} as unknown as IFileService;
		const editor = disposables.add(new ParadisDocxFileEditor(
			new TestEditorGroupView(1),
			// ローカルサーバは使えないことにする（従来どおり webview リソースで解決する経路を見る）。
			{ getChannel: () => ({ call: () => Promise.reject(new Error('no preview server')), listen: () => { throw new Error('not used'); } }) } as unknown as ISharedProcessService,
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			webviewService,
			fileService,
			new TestLayoutService(),
		));
		const parent = document.createElement('div');
		editor.create(parent);
		editor.layout(new Dimension(800, 600));

		return {
			editor,
			fire(resource: URI, eventResource = resource, watcherGeneration?: number): void {
				const emitters = watcherEmitters.get(resource.toString());
				const emitter = watcherGeneration === undefined ? emitters?.[emitters.length - 1] : emitters?.[watcherGeneration];
				emitter?.fire(new FileChangesEvent([{ resource: eventResource, type: FileChangeType.UPDATED }], false));
			},
			queueHeader(resource: URI, result: Uint8Array | DeferredPromise<VSBuffer> | Error): void {
				const queue = queuedHeaders.get(resource.toString()) ?? [];
				queue.push(result instanceof Uint8Array ? VSBuffer.wrap(result) : result);
				queuedHeaders.set(resource.toString(), queue);
			},
			failWatcher(resource: URI): void {
				watcherFailures.add(resource.toString());
			},
			createInput(resource: URI): ParadisDocxInput {
				const textFileService = Object.create(null) as ITextFileService;
				const workingCopyService = { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService;
				return disposables.add(new ParadisDocxInput(resource, textFileService, workingCopyService));
			},
			createCancellationTokenSource(): CancellationTokenSource {
				return disposables.add(new CancellationTokenSource());
			},
			async settleCurrentRender(): Promise<void> {
				await timeout(200);
				for (let index = 0; index < 16; index++) { await Promise.resolve(); }
			},
			resetObservations(): void {
				readResources.length = 0;
				readOptions.length = 0;
				htmlDocuments.length = 0;
				rawHtmlDocuments.length = 0;
				localResourceRootsAtSetHtml.length = 0;
			},
			setVisible(visible: boolean): void {
				editor.layout(visible ? new Dimension(800, 600) : new Dimension(0, 0));
			},
			renderSnapshot(): { readonly reads: readonly string[]; readonly html: readonly IDocxHtmlSnapshot[] } {
				return {
					reads: [...readResources],
					html: rawHtmlDocuments.map(extractHtmlSnapshot),
				};
			},
			localResourceRootsAtSetHtml(): readonly (readonly string[])[] {
				return localResourceRootsAtSetHtml.map(roots => [...roots]);
			},
			snapshot(): IDocxEditorSnapshot {
				return {
					watcherResources: [...watcherResources],
					readResources: [...readResources],
					readOptions: [...readOptions],
					claims,
					releases,
					htmlDocuments: [...htmlDocuments],
					overlayCallsAfterDispose,
				};
			},
		};
	}

	test('reads only the DOCX header and rejects empty and corrupt input', async () => {
		const options: { length: number }[] = [];
		const fileService = {
			readFile: async (_resource: URI, readOptions: { length: number }) => {
				options.push(readOptions);
				return { value: VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)) };
			}
		} as unknown as IFileService;

		strictEqual(await readParadisDocxHeader(fileService, URI.file('/workspace/document.docx')), true);
		deepStrictEqual(options, [{ length: 4 }]);
		deepStrictEqual([new Uint8Array(), Uint8Array.of(0x50, 0x4b, 0x03)].map(isParadisDocxHeader), [false, false]);
	});

	test('maps DOCX preflight results to the observable render outcome', () => {
		const resource = URI.file('/workspace/document.docx');
		const otherResource = URI.file('/workspace/other.docx');

		deepStrictEqual([
			getParadisDocxRenderDecision(false, resource, resource, 1, 1),
			getParadisDocxRenderDecision(true, resource, resource, 1, 1),
			getParadisDocxRenderDecision(undefined, resource, resource, 1, 1),
			getParadisDocxRenderDecision(false, resource, otherResource, 1, 1),
			getParadisDocxRenderDecision(false, resource, resource, 1, 2),
		], ['rejected', 'viewer', 'viewer', 'stale', 'stale']);
	});

	suite('input adoption epoch', () => {

		test('does not adopt an input cleared before its setInput continuation', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			const pending = fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);

			fixture.editor.clearInput();
			await pending;

			deepStrictEqual(fixture.snapshot(), {
				watcherResources: [],
				readResources: [],
				readOptions: [],
				claims: 0,
				releases: 0,
				htmlDocuments: [],
				overlayCallsAfterDispose: 0,
			});
		});

		test('does not adopt an input disposed before its setInput continuation', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			const pending = fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);

			fixture.editor.dispose();
			await pending;

			deepStrictEqual(fixture.snapshot(), {
				watcherResources: [],
				readResources: [],
				readOptions: [],
				claims: 0,
				releases: 0,
				htmlDocuments: [],
				overlayCallsAfterDispose: 0,
			});
		});

		test('lets only the newest different-resource invocation adopt ownership', async () => {
			const fixture = createDocxEditorFixture();
			const resourceA = URI.file('/workspace/a.docx');
			const resourceB = URI.file('/workspace/b.docx');
			const pendingA = fixture.editor.setInput(fixture.createInput(resourceA), undefined, Object.create(null), CancellationToken.None);
			const pendingB = fixture.editor.setInput(fixture.createInput(resourceB), undefined, Object.create(null), CancellationToken.None);

			await Promise.all([pendingA, pendingB]);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.snapshot(), {
				watcherResources: [resourceB.toString()],
				readResources: [resourceB.toString()],
				readOptions: [{ length: 4 }],
				claims: 1,
				releases: 0,
				htmlDocuments: ['viewer'],
				overlayCallsAfterDispose: 0,
			});
		});

		test('does not adopt an input cancelled before its setInput continuation', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			const cancellation = fixture.createCancellationTokenSource();
			const pending = fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), cancellation.token);

			cancellation.cancel();
			await pending;

			strictEqual(fixture.editor.input, undefined);
			deepStrictEqual(fixture.snapshot(), {
				watcherResources: [],
				readResources: [],
				readOptions: [],
				claims: 0,
				releases: 0,
				htmlDocuments: [],
				overlayCallsAfterDispose: 0,
			});
		});

		test('restores the previous tab input when a replacement is cancelled', async () => {
			const fixture = createDocxEditorFixture();
			const resourceA = URI.file('/workspace/a.docx');
			const resourceB = URI.file('/workspace/b.docx');
			const inputA = fixture.createInput(resourceA);
			await fixture.editor.setInput(inputA, undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();
			const cancellation = fixture.createCancellationTokenSource();

			const pending = fixture.editor.setInput(fixture.createInput(resourceB), undefined, Object.create(null), cancellation.token);
			cancellation.cancel();
			await pending;

			strictEqual(fixture.editor.input, inputA);
			deepStrictEqual(fixture.snapshot(), {
				watcherResources: [resourceA.toString()],
				readResources: [resourceA.toString()],
				readOptions: [{ length: 4 }],
				claims: 1,
				releases: 0,
				htmlDocuments: ['viewer'],
				overlayCallsAfterDispose: 0,
			});
		});

		test('lets only the second invocation adopt the same input object', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			const input = fixture.createInput(resource);
			const pendingA = fixture.editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
			const pendingB = fixture.editor.setInput(input, undefined, Object.create(null), CancellationToken.None);

			await Promise.all([pendingA, pendingB]);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.snapshot(), {
				watcherResources: [resource.toString()],
				readResources: [resource.toString()],
				readOptions: [{ length: 4 }],
				claims: 1,
				releases: 0,
				htmlDocuments: ['viewer'],
				overlayCallsAfterDispose: 0,
			});
		});

		test('does not revive an editor when setInput is called after disposal', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');

			fixture.editor.dispose();
			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);

			deepStrictEqual(fixture.snapshot(), {
				watcherResources: [],
				readResources: [],
				readOptions: [],
				claims: 0,
				releases: 0,
				htmlDocuments: [],
				overlayCallsAfterDispose: 0,
			});
		});
	});

	function expectedViewerSnapshot(_docxUrl: string): IDocxHtmlSnapshot {
		const libraryBase = asWebviewUri(FileAccess.asFileUri('vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview')).toString(true);
		const exactOrigins = new URL(libraryBase).origin;
		return {
			classification: 'viewer',
			docxUrl: '<sanitized-docx-data>',
			csp: `default-src 'none'; script-src 'nonce-<nonce>' ${exactOrigins}; style-src 'unsafe-inline'; img-src data: blob: ${exactOrigins}; font-src data: blob: ${exactOrigins}; connect-src ${exactOrigins} data: blob:; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none';`,
			scriptUrls: [`${libraryBase}/jszip.min.js`, `${libraryBase}/docx-preview.min.js`],
			nonceConsistency: {
				csp: true,
				externalScripts: true,
				inlineScript: true,
			},
			renderOptions: {
				ignoreWidth: false,
				ignoreHeight: false,
				breakPages: true,
				ignoreLastRenderedPageBreak: false,
				experimental: true,
				renderHeaders: true,
				renderFooters: true,
				renderFootnotes: true,
				renderEndnotes: true,
				useBase64URL: true,
				ignoreFonts: true,
				renderAltChunks: false,
			},
		};
	}

	suite('watch fixed window', () => {

		test('waits 50ms before rerendering one matching event', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();
			fixture.resetObservations();

			fixture.fire(resource);
			await timeout(49);
			deepStrictEqual(fixture.renderSnapshot(), { reads: [], html: [] });
			await timeout(1);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.renderSnapshot(), {
				reads: [resource.toString()],
				html: [expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx')],
			});
		}));

		test('keeps the first deadline when another event arrives at 40ms', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();
			fixture.resetObservations();

			fixture.fire(resource);
			await timeout(40);
			fixture.fire(resource);
			await timeout(10);
			await fixture.settleCurrentRender();
			deepStrictEqual(fixture.renderSnapshot(), {
				reads: [resource.toString()],
				html: [expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx')],
			});
			await timeout(40);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.renderSnapshot(), {
				reads: [resource.toString()],
				html: [expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx')],
			});
		}));

		test('coalesces 100 matching events and ignores nonmatching events', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			const otherResource = URI.file('/workspace/other.docx');
			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();
			fixture.resetObservations();

			for (let index = 0; index < 100; index++) {
				fixture.fire(resource, otherResource);
			}
			await timeout(50);
			deepStrictEqual(fixture.renderSnapshot(), { reads: [], html: [] });
			for (let index = 0; index < 100; index++) {
				fixture.fire(resource);
			}
			await timeout(50);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.renderSnapshot(), {
				reads: [resource.toString()],
				html: [expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx')],
			});
		}));

		test('opens a new fixed window after the previous deadline', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();
			fixture.resetObservations();

			fixture.fire(resource);
			await timeout(50);
			await fixture.settleCurrentRender();
			fixture.fire(resource);
			await timeout(49);
			deepStrictEqual(fixture.renderSnapshot().reads, [resource.toString()]);
			await timeout(1);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.renderSnapshot(), {
				reads: [resource.toString(), resource.toString()],
				html: [
					expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx'),
					expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx'),
				],
			});
		}));
	});

	suite('watch visibility and immediate paths', () => {

		test('renders a visible initial input without waiting for the watch timer', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');

			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.renderSnapshot(), {
				reads: [resource.toString()],
				html: [expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx')],
			});
		}));

		test('renders a new input on an already claimed pane without waiting', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fixture = createDocxEditorFixture();
			const resourceA = URI.file('/workspace/a.docx');
			const resourceB = URI.file('/workspace/b.docx');
			await fixture.editor.setInput(fixture.createInput(resourceA), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();
			fixture.resetObservations();

			await fixture.editor.setInput(fixture.createInput(resourceB), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.renderSnapshot(), {
				reads: [resourceB.toString()],
				html: [expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/b.docx')],
			});
		}));

		test('ignores hidden events and renders once immediately when shown', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();
			fixture.setVisible(false);
			fixture.resetObservations();

			for (let index = 0; index < 100; index++) {
				fixture.fire(resource);
			}
			await timeout(50);
			deepStrictEqual(fixture.renderSnapshot(), { reads: [], html: [] });
			fixture.setVisible(true);
			await fixture.settleCurrentRender();

			deepStrictEqual({ render: fixture.renderSnapshot(), snapshot: fixture.snapshot() }, {
				render: {
					reads: [resource.toString()],
					html: [expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx')],
				},
				snapshot: {
					watcherResources: [resource.toString()],
					readResources: [resource.toString()],
					readOptions: [{ length: 4 }],
					claims: 2,
					releases: 1,
					htmlDocuments: ['viewer'],
					overlayCallsAfterDispose: 0,
				},
			});
		}));

		test('does not rerender an old pending watch after hide and show', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();
			fixture.resetObservations();

			fixture.fire(resource);
			await timeout(10);
			fixture.setVisible(false);
			fixture.setVisible(true);
			await fixture.settleCurrentRender();
			deepStrictEqual(fixture.renderSnapshot().reads, [resource.toString()]);
			await timeout(40);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.renderSnapshot(), {
				reads: [resource.toString()],
				html: [expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx')],
			});
		}));

		test('keeps a new event after hide and show on the original fixed deadline', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();
			fixture.resetObservations();

			fixture.fire(resource);
			await timeout(10);
			fixture.setVisible(false);
			fixture.setVisible(true);
			await fixture.settleCurrentRender();
			fixture.fire(resource);
			await timeout(39);
			deepStrictEqual(fixture.renderSnapshot().reads, [resource.toString()]);
			await timeout(1);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.renderSnapshot(), {
				reads: [resource.toString(), resource.toString()],
				html: [
					expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx'),
					expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx'),
				],
			});
		}));

		test('does not read while a pending timer remains hidden and renders once on show', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();
			fixture.resetObservations();

			fixture.fire(resource);
			await timeout(10);
			fixture.setVisible(false);
			await timeout(40);
			deepStrictEqual(fixture.renderSnapshot(), { reads: [], html: [] });
			fixture.setVisible(true);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.renderSnapshot(), {
				reads: [resource.toString()],
				html: [expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx')],
			});
		}));
	});

	suite('preflight publication fence', () => {

		test('does not publish the old input after a newer setInput invocation starts before adoption', async () => {
			const fixture = createDocxEditorFixture();
			const resourceA = URI.file('/workspace/a.docx');
			const resourceB = URI.file('/workspace/b.docx');
			const oldHeader = new DeferredPromise<VSBuffer>();
			fixture.queueHeader(resourceA, oldHeader);
			try {
				await fixture.editor.setInput(fixture.createInput(resourceA), undefined, Object.create(null), CancellationToken.None);
				fixture.resetObservations();

				void oldHeader.complete(VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)));
				await Promise.resolve();
				await Promise.resolve();
				const pendingB = fixture.editor.setInput(fixture.createInput(resourceB), undefined, Object.create(null), CancellationToken.None);
				await pendingB;
				await fixture.settleCurrentRender();

				deepStrictEqual(fixture.renderSnapshot(), {
					reads: [resourceB.toString()],
					html: [expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/b.docx')],
				});
			} finally {
				await oldHeader.complete(VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)));
			}
		});

		test('publishes only a newer valid result when same-URI preflights resolve in reverse order', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			const oldHeader = new DeferredPromise<VSBuffer>();
			const newHeader = new DeferredPromise<VSBuffer>();
			fixture.queueHeader(resource, oldHeader);
			fixture.queueHeader(resource, newHeader);
			try {
				await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
				fixture.fire(resource);
				await timeout(50);
				await newHeader.complete(VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)));
				await fixture.settleCurrentRender();
				await oldHeader.complete(VSBuffer.wrap(Uint8Array.of(0x00, 0x00, 0x00, 0x00)));
				await fixture.settleCurrentRender();

				deepStrictEqual(fixture.renderSnapshot(), {
					reads: [resource.toString(), resource.toString()],
					html: [expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx')],
				});
			} finally {
				await oldHeader.complete(VSBuffer.wrap(Uint8Array.of(0x00, 0x00, 0x00, 0x00)));
				await newHeader.complete(VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)));
			}
		}));

		test('publishes only a newer invalid result when same-URI preflights resolve in reverse order', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			const oldHeader = new DeferredPromise<VSBuffer>();
			const newHeader = new DeferredPromise<VSBuffer>();
			fixture.queueHeader(resource, oldHeader);
			fixture.queueHeader(resource, newHeader);
			try {
				await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
				fixture.fire(resource);
				await timeout(50);
				await newHeader.complete(VSBuffer.wrap(Uint8Array.of(0x00, 0x00, 0x00, 0x00)));
				await fixture.settleCurrentRender();
				await oldHeader.complete(VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)));
				await fixture.settleCurrentRender();

				deepStrictEqual(fixture.renderSnapshot(), {
					reads: [resource.toString(), resource.toString()],
					html: [{ classification: 'rejected' }],
				});
			} finally {
				await oldHeader.complete(VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)));
				await newHeader.complete(VSBuffer.wrap(Uint8Array.of(0x00, 0x00, 0x00, 0x00)));
			}
		}));

		test('keeps only the new preflight after hide and show even though the old completion sees a claimed pane', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			const oldHeader = new DeferredPromise<VSBuffer>();
			const newHeader = new DeferredPromise<VSBuffer>();
			fixture.queueHeader(resource, oldHeader);
			fixture.queueHeader(resource, newHeader);
			try {
				await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
				fixture.setVisible(false);
				fixture.setVisible(true);
				await newHeader.complete(VSBuffer.wrap(Uint8Array.of(0x00, 0x00, 0x00, 0x00)));
				await fixture.settleCurrentRender();
				await oldHeader.complete(VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)));
				await fixture.settleCurrentRender();

				deepStrictEqual({ render: fixture.renderSnapshot(), snapshot: fixture.snapshot() }, {
					render: {
						reads: [resource.toString(), resource.toString()],
						html: [{ classification: 'rejected' }],
					},
					snapshot: {
						watcherResources: [resource.toString()],
						readResources: [resource.toString(), resource.toString()],
						readOptions: [{ length: 4 }, { length: 4 }],
						claims: 2,
						releases: 1,
						htmlDocuments: ['rejected'],
						overlayCallsAfterDispose: 0,
					},
				});
			} finally {
				await oldHeader.complete(VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)));
				await newHeader.complete(VSBuffer.wrap(Uint8Array.of(0x00, 0x00, 0x00, 0x00)));
			}
		});

		test('cancels pending timers when input ownership is cleared, reset, switched, or disposed', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const resourceA = URI.file('/workspace/a.docx');
			const resourceB = URI.file('/workspace/b.docx');

			const cleared = createDocxEditorFixture();
			await cleared.editor.setInput(cleared.createInput(resourceA), undefined, Object.create(null), CancellationToken.None);
			await cleared.settleCurrentRender();
			cleared.resetObservations();
			cleared.fire(resourceA);
			cleared.editor.clearInput();
			await timeout(50);
			cleared.fire(resourceA);

			const reset = createDocxEditorFixture();
			await reset.editor.setInput(reset.createInput(resourceA), undefined, Object.create(null), CancellationToken.None);
			await reset.settleCurrentRender();
			reset.resetObservations();
			reset.fire(resourceA);
			await reset.editor.setInput(reset.createInput(resourceA), undefined, Object.create(null), CancellationToken.None);
			await reset.settleCurrentRender();
			await timeout(50);

			const switched = createDocxEditorFixture();
			await switched.editor.setInput(switched.createInput(resourceA), undefined, Object.create(null), CancellationToken.None);
			await switched.settleCurrentRender();
			switched.resetObservations();
			switched.fire(resourceA);
			await switched.editor.setInput(switched.createInput(resourceB), undefined, Object.create(null), CancellationToken.None);
			await switched.settleCurrentRender();
			await timeout(50);
			switched.fire(resourceA);

			const disposed = createDocxEditorFixture();
			await disposed.editor.setInput(disposed.createInput(resourceA), undefined, Object.create(null), CancellationToken.None);
			await disposed.settleCurrentRender();
			disposed.resetObservations();
			disposed.fire(resourceA);
			disposed.editor.dispose();
			await timeout(50);
			disposed.fire(resourceA);

			deepStrictEqual({
				cleared: cleared.renderSnapshot().reads,
				reset: reset.renderSnapshot().reads,
				switched: switched.renderSnapshot().reads,
				disposed: disposed.renderSnapshot().reads,
			}, {
				cleared: [],
				reset: [resourceA.toString()],
				switched: [resourceB.toString()],
				disposed: [],
			});
		}));

		test('ignores an old same-URI watcher generation after reset and accepts the latest generation', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();
			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();
			fixture.resetObservations();

			fixture.fire(resource, resource, 0);
			await timeout(50);
			await fixture.settleCurrentRender();
			deepStrictEqual(fixture.renderSnapshot(), { reads: [], html: [] });

			fixture.fire(resource, resource, 1);
			await timeout(50);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.renderSnapshot(), {
				reads: [resource.toString()],
				html: [expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx')],
			});
		}));

		test('does not publish a preflight completed while hidden and publishes the fresh show result', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			const oldHeader = new DeferredPromise<VSBuffer>();
			fixture.queueHeader(resource, oldHeader);
			try {
				await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
				fixture.setVisible(false);
				await oldHeader.complete(VSBuffer.wrap(Uint8Array.of(0x00, 0x00, 0x00, 0x00)));
				await fixture.settleCurrentRender();
				const hiddenHtml = fixture.renderSnapshot().html;
				fixture.setVisible(true);
				await fixture.settleCurrentRender();

				deepStrictEqual({ hiddenHtml, final: fixture.renderSnapshot() }, {
					hiddenHtml: [],
					final: {
						reads: [resource.toString(), resource.toString()],
						html: [expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/document.docx')],
					},
				});
			} finally {
				await oldHeader.complete(VSBuffer.wrap(Uint8Array.of(0x00, 0x00, 0x00, 0x00)));
			}
		});

		test('does not publish an old preflight after clear and hidden same-URI reset', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			const oldHeader = new DeferredPromise<VSBuffer>();
			fixture.queueHeader(resource, oldHeader);
			try {
				await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
				fixture.setVisible(false);
				fixture.editor.clearInput();
				await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
				await oldHeader.complete(VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)));
				await fixture.settleCurrentRender();

				deepStrictEqual({ render: fixture.renderSnapshot(), snapshot: fixture.snapshot() }, {
					render: { reads: [resource.toString()], html: [] },
					snapshot: {
						watcherResources: [resource.toString(), resource.toString()],
						readResources: [resource.toString()],
						readOptions: [{ length: 4 }],
						claims: 1,
						releases: 1,
						htmlDocuments: [],
						overlayCallsAfterDispose: 0,
					},
				});
			} finally {
				await oldHeader.complete(VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)));
			}
		});

		test('keeps resource B when resource A completes later', async () => {
			const fixture = createDocxEditorFixture();
			const resourceA = URI.file('/workspace/a.docx');
			const resourceB = URI.file('/workspace/b.docx');
			const oldHeader = new DeferredPromise<VSBuffer>();
			const newHeader = new DeferredPromise<VSBuffer>();
			fixture.queueHeader(resourceA, oldHeader);
			fixture.queueHeader(resourceB, newHeader);
			try {
				await fixture.editor.setInput(fixture.createInput(resourceA), undefined, Object.create(null), CancellationToken.None);
				await fixture.editor.setInput(fixture.createInput(resourceB), undefined, Object.create(null), CancellationToken.None);
				await newHeader.complete(VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)));
				await fixture.settleCurrentRender();
				await oldHeader.complete(VSBuffer.wrap(Uint8Array.of(0x00, 0x00, 0x00, 0x00)));
				await fixture.settleCurrentRender();

				deepStrictEqual(fixture.renderSnapshot(), {
					reads: [resourceA.toString(), resourceB.toString()],
					html: [expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/b.docx')],
				});
			} finally {
				await oldHeader.complete(VSBuffer.wrap(Uint8Array.of(0x00, 0x00, 0x00, 0x00)));
				await newHeader.complete(VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)));
			}
		});

		test('does not publish resolved or rejected preflights after disposal', async () => {
			const resource = URI.file('/workspace/document.docx');
			const resolvedFixture = createDocxEditorFixture();
			const resolvedHeader = new DeferredPromise<VSBuffer>();
			resolvedFixture.queueHeader(resource, resolvedHeader);
			const rejectedFixture = createDocxEditorFixture();
			const rejectedHeader = new DeferredPromise<VSBuffer>();
			rejectedFixture.queueHeader(resource, rejectedHeader);
			try {
				await resolvedFixture.editor.setInput(resolvedFixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
				resolvedFixture.editor.dispose();
				await resolvedHeader.complete(VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)));
				await resolvedFixture.settleCurrentRender();

				await rejectedFixture.editor.setInput(rejectedFixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
				rejectedFixture.editor.dispose();
				await rejectedHeader.error(new Error('read failed'));
				await rejectedFixture.settleCurrentRender();

				deepStrictEqual({ resolved: resolvedFixture.snapshot(), rejected: rejectedFixture.snapshot() }, {
					resolved: {
						watcherResources: [resource.toString()],
						readResources: [resource.toString()],
						readOptions: [{ length: 4 }],
						claims: 1,
						releases: 0,
						htmlDocuments: [],
						overlayCallsAfterDispose: 0,
					},
					rejected: {
						watcherResources: [resource.toString()],
						readResources: [resource.toString()],
						readOptions: [{ length: 4 }],
						claims: 1,
						releases: 0,
						htmlDocuments: [],
						overlayCallsAfterDispose: 0,
					},
				});
			} finally {
				await resolvedHeader.complete(VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)));
				await rejectedHeader.error(new Error('read failed'));
			}
		});
	});

	suite('remote and watcher failure contract', () => {

		test('preserves the exact remote URI, root, and viewer URL', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.from({ scheme: Schemas.vscodeRemote, authority: 'remote', path: '/workspace/document.docx' });

			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();

			deepStrictEqual({ snapshot: fixture.snapshot(), firstRoot: fixture.localResourceRootsAtSetHtml()[0]?.[0], render: fixture.renderSnapshot() }, {
				snapshot: {
					watcherResources: ['vscode-remote://remote/workspace/document.docx'],
					readResources: ['vscode-remote://remote/workspace/document.docx'],
					readOptions: [{ length: 4 }],
					claims: 1,
					releases: 0,
					htmlDocuments: ['viewer'],
					overlayCallsAfterDispose: 0,
				},
				firstRoot: 'vscode-remote://remote/workspace',
				render: {
					reads: ['vscode-remote://remote/workspace/document.docx'],
					html: [expectedViewerSnapshot('https://vscode-remote+remote.vscode-resource.vscode-cdn.net/workspace/document.docx')],
				},
			});
		});

		test('coalesces matching remote events without accepting a different URI component', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.from({ scheme: Schemas.vscodeRemote, authority: 'remote', path: '/workspace/document.docx' });
			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();
			fixture.resetObservations();

			const nonmatchingResources = [
				URI.from({ scheme: Schemas.vscodeRemote, authority: 'other', path: '/workspace/document.docx' }),
				URI.from({ scheme: Schemas.vscodeRemote, authority: 'remote', path: '/workspace/other.docx' }),
				URI.file('/workspace/document.docx'),
			];
			for (const eventResource of nonmatchingResources) {
				fixture.fire(resource, eventResource);
			}
			for (let index = 0; index < 100; index++) {
				fixture.fire(resource);
			}
			await timeout(50);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.renderSnapshot(), {
				reads: [resource.toString()],
				html: [expectedViewerSnapshot('https://vscode-remote+remote.vscode-resource.vscode-cdn.net/workspace/document.docx')],
			});
		}));

		test('continues initial publication when watcher creation throws', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			fixture.failWatcher(resource);

			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.snapshot(), {
				watcherResources: [resource.toString()],
				readResources: [resource.toString()],
				readOptions: [{ length: 4 }],
				claims: 1,
				releases: 0,
				htmlDocuments: ['viewer'],
				overlayCallsAfterDispose: 0,
			});
		});

		test('preserves valid, invalid, and read-error publication classifications', async () => {
			const cases = [
				{ path: '/workspace/valid.docx', result: Uint8Array.of(0x50, 0x4b, 0x03, 0x04), expected: expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/valid.docx') },
				{ path: '/workspace/invalid.docx', result: Uint8Array.of(0x00, 0x00, 0x00, 0x00), expected: { classification: 'rejected' } as const },
				{ path: '/workspace/read-error.docx', result: new Error('read failed'), expected: expectedViewerSnapshot('https://file+.vscode-resource.vscode-cdn.net/workspace/read-error.docx') },
			];
			const actual: IDocxHtmlSnapshot[] = [];
			for (const testCase of cases) {
				const fixture = createDocxEditorFixture();
				const resource = URI.file(testCase.path);
				fixture.queueHeader(resource, testCase.result);
				await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);
				await fixture.settleCurrentRender();
				actual.push(...fixture.renderSnapshot().html);
			}

			deepStrictEqual(actual, cases.map(testCase => testCase.expected));
		});
	});
});

async function loadActualDocxPreview(): Promise<{ renderAsync(data: ArrayBuffer, body: HTMLElement, styles: HTMLElement, options: Readonly<Record<string, unknown>>): Promise<void> }> {
	const JSZip = await importAMDNodeModule<typeof import('jszip')>('jszip', 'dist/jszip.min.js');
	const response = await fetch(FileAccess.asFileUri('vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/docx-preview.min.js').toString(true));
	if (!response.ok) { throw new Error(`Unable to load docx-preview: ${response.status}`); }
	const source = await response.text();
	const module = { exports: {} as Record<string, unknown> };
	const evaluate = new Function('exports', 'module', 'require', source) as (exports: Record<string, unknown>, module: { exports: Record<string, unknown> }, require: (id: string) => unknown) => void;
	evaluate(module.exports, module, id => {
		if (id !== 'jszip') {
			throw new Error(`Unexpected docx-preview dependency: ${id}`);
		}
		return JSZip;
	});
	return module.exports as unknown as { renderAsync(data: ArrayBuffer, body: HTMLElement, styles: HTMLElement, options: Readonly<Record<string, unknown>>): Promise<void> };
}

function storeZip(files: Readonly<Record<string, string>>): Uint8Array {
	const encoder = new TextEncoder();
	const records = Object.entries(files).map(([name, value]) => ({ name: encoder.encode(name), bytes: encoder.encode(value), crc: testCrc32(encoder.encode(value)) }));
	const localLength = records.reduce((sum, record) => sum + 30 + record.name.byteLength + record.bytes.byteLength, 0);
	const centralLength = records.reduce((sum, record) => sum + 46 + record.name.byteLength, 0);
	const output = new Uint8Array(localLength + centralLength + 22);
	const view = new DataView(output.buffer);
	const offsets: number[] = [];
	let offset = 0;
	for (const record of records) {
		offsets.push(offset); view.setUint32(offset, 0x04034b50, true); view.setUint16(offset + 4, 20, true); view.setUint32(offset + 14, record.crc, true); view.setUint32(offset + 18, record.bytes.byteLength, true); view.setUint32(offset + 22, record.bytes.byteLength, true); view.setUint16(offset + 26, record.name.byteLength, true);
		output.set(record.name, offset + 30); output.set(record.bytes, offset + 30 + record.name.byteLength); offset += 30 + record.name.byteLength + record.bytes.byteLength;
	}
	const centralOffset = offset;
	for (let index = 0; index < records.length; index++) {
		const record = records[index]; view.setUint32(offset, 0x02014b50, true); view.setUint16(offset + 4, 20, true); view.setUint16(offset + 6, 20, true); view.setUint32(offset + 16, record.crc, true); view.setUint32(offset + 20, record.bytes.byteLength, true); view.setUint32(offset + 24, record.bytes.byteLength, true); view.setUint16(offset + 28, record.name.byteLength, true); view.setUint32(offset + 42, offsets[index], true);
		output.set(record.name, offset + 46); offset += 46 + record.name.byteLength;
	}
	view.setUint32(offset, 0x06054b50, true); view.setUint16(offset + 8, records.length, true); view.setUint16(offset + 10, records.length, true); view.setUint32(offset + 12, centralLength, true); view.setUint32(offset + 16, centralOffset, true);
	return output;
}

function testCrc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) { crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } }
	return (crc ^ 0xffffffff) >>> 0;
}
