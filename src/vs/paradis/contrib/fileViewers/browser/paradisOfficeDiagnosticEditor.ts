/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService, type IConfigurationValue } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../workbench/services/editor/common/editorResolverService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import {
	PARADIS_OFFICE_BROWSER_EDITOR_ID,
	PARADIS_OFFICE_DIAGNOSTIC_EXTENSIONS,
	getParadisOfficeFormat,
	isParadisOfficeDiagnosticResource,
	paradisGlobForExtension,
	type ParadisOfficeDiagnosticFormat,
	type ParadisOfficeSemanticFormat,
} from './paradisFileViewers.js';
import { PARADIS_OFFICE_BROWSER_SERIALIZER_REGISTRATIONS, ParadisOfficeDiagnosticInput } from './paradisOfficeDiagnosticInput.js';
import { registerParadisOfficeViewerSerializers } from './paradisOfficeConfiguration.js';
import {
	ParadisOfficeWebWorkerClient,
	createParadisOfficeWebWorkerEndpoint,
	getParadisOfficeWebWorkerCapabilities,
	type IParadisOfficeWebWorkerEndpoint,
	type ParadisOfficeBrowserSemanticSummary,
	type ParadisOfficeBrowserSpreadsheetDiagonal,
} from './paradisOfficeWebWorker.js';
import {
	snapshotParadisOfficeRuntimeConfiguration,
	type ParadisOfficeConfigurationReader,
	type ParadisOfficeRuntimeConfiguration,
} from '../common/paradisOfficeCapabilities.js';

const maximumBrowserOfficeBytes = 16 * 1024 * 1024;
const officeWorkerModule = 'vs/paradis/contrib/fileViewers/browser/paradisOfficeWebWorker.js';

export type ParadisOfficeDiagnosticReason =
	| 'legacyBinaryUnsupported'
	| 'binaryWorkbookUnsupported'
	| 'openDocumentUnsupported'
	| 'richTextUnsupported'
	| 'unknownUnsupported';

export interface ParadisOfficeDiagnostic {
	readonly resource: URI;
	readonly format: ParadisOfficeDiagnosticFormat | 'unknown';
	readonly reason: ParadisOfficeDiagnosticReason;
	readonly canOpenExternal: boolean;
}

export function createParadisOfficeDiagnostic(resource: URI): ParadisOfficeDiagnostic {
	const format = getParadisOfficeFormat(resource);
	const diagnosticFormat = format === 'xlsb' || format === 'ods' || format === 'xls' || format === 'doc' || format === 'rtf' ? format : 'unknown';
	const reason: ParadisOfficeDiagnosticReason = diagnosticFormat === 'xls' || diagnosticFormat === 'doc'
		? 'legacyBinaryUnsupported'
		: diagnosticFormat === 'xlsb'
			? 'binaryWorkbookUnsupported'
			: diagnosticFormat === 'ods'
				? 'openDocumentUnsupported'
				: diagnosticFormat === 'rtf'
					? 'richTextUnsupported'
					: 'unknownUnsupported';
	return { resource, format: diagnosticFormat, reason, canOpenExternal: resource.scheme === Schemas.file };
}

/** Renders metadata only. This function deliberately has no byte input or binary decoding path. */
export function renderParadisOfficeDiagnostic(
	container: HTMLElement,
	diagnostic: ParadisOfficeDiagnostic,
	onOpenExternal: (resource: URI) => void,
): void {
	container.replaceChildren();
	const title = dom.append(container, dom.$('h2'));
	title.textContent = localize('paradis.office.unsupported.title', "This Office format cannot be previewed here");
	const format = dom.append(container, dom.$('p'));
	format.textContent = localize('paradis.office.unsupported.format', "Detected format: {0}", diagnostic.format);
	const explanation = dom.append(container, dom.$('p'));
	explanation.textContent = diagnosticText(diagnostic.reason);
	const button = dom.append(container, dom.$('button')) as HTMLButtonElement;
	button.type = 'button';
	button.textContent = localize('paradis.office.unsupported.openExternal', "Open in an external application");
	button.disabled = !diagnostic.canOpenExternal;
	button.addEventListener(dom.EventType.CLICK, () => {
		if (diagnostic.canOpenExternal) {
			onOpenExternal(diagnostic.resource);
		}
	});
}

function diagnosticText(reason: ParadisOfficeDiagnosticReason): string {
	switch (reason) {
		case 'legacyBinaryUnsupported': return localize('paradis.office.unsupported.legacy', "Legacy binary Office files are not supported by the semantic preview.");
		case 'binaryWorkbookUnsupported': return localize('paradis.office.unsupported.xlsb', "Binary Excel workbooks are not supported by the semantic preview.");
		case 'openDocumentUnsupported': return localize('paradis.office.unsupported.ods', "OpenDocument spreadsheets are not supported by the semantic preview.");
		case 'richTextUnsupported': return localize('paradis.office.unsupported.rtf', "Rich Text Format files are not supported by the semantic preview.");
		case 'unknownUnsupported': return localize('paradis.office.unsupported.unknown', "This file is not a supported semantic Office package.");
	}
}

export class ParadisOfficeDiagnosticEditor extends EditorPane {
	static readonly ID = PARADIS_OFFICE_BROWSER_EDITOR_ID;

	private rootElement: HTMLElement | undefined;
	private readonly inputCancellation = this._register(new MutableDisposable<CancellationTokenSource>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super(PARADIS_OFFICE_BROWSER_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.rootElement = dom.append(parent, dom.$('.paradis-office-browser-viewer'));
		this.rootElement.style.overflow = 'auto';
		this.rootElement.style.padding = '16px';
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		const officeInput = input as ParadisOfficeDiagnosticInput;
		const cancellation = new CancellationTokenSource(token);
		this.inputCancellation.value = cancellation;
		if (officeInput.mode === 'diagnostic') {
			this.renderDiagnostic(createParadisOfficeDiagnostic(officeInput.resource));
			return;
		}
		const runtimeConfiguration = snapshotBrowserRuntimeConfiguration(this.configurationService);
		const workerAvailable = runtimeConfiguration.platformBackend && typeof Worker === 'function';
		if (!isBrowserSemanticEnabled(officeInput.format as ParadisOfficeSemanticFormat, !!officeInput.originalResource, runtimeConfiguration, workerAvailable)) {
			this.renderWorkerFallback(officeInput.resource, workerAvailable ? 'configurationDisabled' : 'workerUnavailable');
			return;
		}
		this.renderStatus(localize('paradis.office.loading', "Reading Office semantics…"));
		try {
			const [original, modified] = officeInput.originalResource
				? await Promise.all([
					this.fileService.readFile(officeInput.originalResource, { limits: { size: maximumBrowserOfficeBytes } }, cancellation.token),
					this.fileService.readFile(officeInput.resource, { limits: { size: maximumBrowserOfficeBytes } }, cancellation.token),
				])
				: [await this.fileService.readFile(officeInput.resource, { limits: { size: maximumBrowserOfficeBytes } }, cancellation.token), undefined];
			if (cancellation.token.isCancellationRequested || this.input !== input) {
				return;
			}
			const workerUrl = FileAccess.asBrowserUri(officeWorkerModule).toString(true);
			const client = new ParadisOfficeWebWorkerClient({
				createWorker: () => createParadisOfficeWebWorkerEndpoint(
					workerUrl,
					mainWindow.location.origin,
					(url, workerOptions) => new Worker(url, workerOptions) as unknown as IParadisOfficeWebWorkerEndpoint,
				),
			});
			const result = await client.run(
				officeInput.originalResource ? 'diff' : 'view',
				officeInput.format as ParadisOfficeSemanticFormat,
				original.value.buffer,
				modified?.value.buffer,
				cancellation.token,
			);
			if (cancellation.token.isCancellationRequested || this.input !== input) {
				return;
			}
			if (result.kind === 'result') {
				this.renderSummary(result.value);
			} else if (result.kind !== 'cancelled') {
				this.renderWorkerFallback(officeInput.resource, result.reason);
			}
		} catch {
			if (!cancellation.token.isCancellationRequested && this.input === input) {
				this.renderWorkerFallback(officeInput.resource, 'workerFailed');
			}
		}
	}

	private renderStatus(message: string): void {
		this.rootElement?.replaceChildren(message);
	}

	private renderDiagnostic(diagnostic: ParadisOfficeDiagnostic): void {
		if (!this.rootElement) {
			return;
		}
		renderParadisOfficeDiagnostic(this.rootElement, diagnostic, resource => {
			void this.openerService.open(resource, { openExternal: true, allowContributedOpeners: false, fromUserGesture: true });
		});
	}

	private renderWorkerFallback(resource: URI, reason: string): void {
		if (!this.rootElement) {
			return;
		}
		this.rootElement.replaceChildren();
		const title = dom.append(this.rootElement, dom.$('h2'));
		title.textContent = localize('paradis.office.workerUnavailable.title', "Office semantic preview is unavailable");
		const detail = dom.append(this.rootElement, dom.$('p'));
		detail.textContent = localize('paradis.office.workerUnavailable.detail', "The browser worker could not safely complete this preview ({0}).", reason);
		const diagnostic = createParadisOfficeDiagnostic(resource);
		const button = dom.append(this.rootElement, dom.$('button')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = localize('paradis.office.unsupported.openExternal', "Open in an external application");
		button.disabled = !diagnostic.canOpenExternal;
		button.addEventListener(dom.EventType.CLICK, () => {
			if (diagnostic.canOpenExternal) {
				void this.openerService.open(resource, { openExternal: true, allowContributedOpeners: false, fromUserGesture: true });
			}
		});
	}

	private renderSummary(summary: ParadisOfficeBrowserSemanticSummary): void {
		if (!this.rootElement) {
			return;
		}
		renderParadisOfficeSummary(this.rootElement, summary);
	}

	override clearInput(): void {
		this.inputCancellation.clear();
		this.rootElement?.replaceChildren();
		super.clearInput();
	}

	override layout(dimension: dom.Dimension): void {
		if (this.rootElement) {
			this.rootElement.style.width = `${dimension.width}px`;
			this.rootElement.style.height = `${dimension.height}px`;
		}
	}
}

export function renderParadisOfficeSummary(container: HTMLElement, summary: ParadisOfficeBrowserSemanticSummary): void {
	container.replaceChildren();
	const title = dom.append(container, dom.$('h2'));
	title.textContent = summary.kind === 'diff'
		? localize('paradis.office.diff.title', "Office semantic changes")
		: localize('paradis.office.summary.title', "Office semantic preview");
	if (summary.kind === 'spreadsheet') {
		if (summary.sheets.some(sheet => sheet.truncated)) {
			appendSummaryWarning(container, localize('paradis.office.summary.truncated', "This preview is incomplete because content was truncated."));
		}
		appendExternalRelationshipWarning(container, summary.externalRelationshipCount);
		for (const sheet of summary.sheets) {
			const heading = dom.append(container, dom.$('h3'));
			heading.textContent = sheet.name;
			const table = dom.append(container, dom.$('table'));
			for (const cell of sheet.cells) {
				const row = dom.append(table, dom.$('tr'));
				const address = dom.append(row, dom.$('th'));
				address.textContent = cell.address;
				const value = dom.append(row, dom.$('td'));
				value.style.position = 'relative';
				value.style.minWidth = '120px';
				value.textContent = cell.text;
				if (cell.diagonal) {
					appendSpreadsheetDiagonal(value, cell.diagonal);
				}
			}
		}
		return;
	}
	if (summary.kind === 'word') {
		if (summary.truncated || summary.stories.some(story => story.truncated)) {
			appendSummaryWarning(container, localize('paradis.office.summary.truncated', "This preview is incomplete because content was truncated."));
		}
		appendExternalRelationshipWarning(container, summary.externalRelationshipCount);
		if (summary.drawings.length > 0) {
			appendSummaryWarning(container, localize('paradis.office.summary.drawingPlaceholders', "{0} drawing placeholder(s) are not rendered in this diagnostic preview.", summary.drawings.length));
		}
		for (const story of summary.stories) {
			const heading = dom.append(container, dom.$('h3'));
			heading.textContent = story.kind;
			const text = dom.append(container, dom.$('pre'));
			text.style.whiteSpace = 'pre-wrap';
			text.textContent = story.text;
		}
		if (summary.tableDiagonals.length > 0) {
			const heading = dom.append(container, dom.$('h3'));
			heading.textContent = localize('paradis.office.word.diagonals', "Table diagonals");
			for (const diagonal of summary.tableDiagonals) {
				const sample = dom.append(container, dom.$('span'));
				sample.style.display = 'inline-block';
				sample.style.position = 'relative';
				sample.style.width = '80px';
				sample.style.height = '40px';
				sample.style.border = '1px solid currentColor';
				sample.style.margin = '4px';
				appendDiagonalLine(sample, diagonal.direction === 'topLeftToBottomRight', diagonal.direction === 'topRightToBottomLeft', diagonal.color);
			}
		}
		return;
	}
	if (!summary.terminal) {
		appendSummaryWarning(container, localize('paradis.office.diff.incomplete', "This comparison is not complete."));
	}
	const list = dom.append(container, dom.$('ul'));
	for (const change of summary.changes) {
		const item = dom.append(list, dom.$('li'));
		item.textContent = `${change.category}: ${change.locator}`;
	}
}

function appendSummaryWarning(container: HTMLElement, text: string): void {
	const warning = dom.append(container, dom.$('p'));
	warning.setAttribute('role', 'status');
	warning.textContent = text;
}

function appendExternalRelationshipWarning(container: HTMLElement, count: number): void {
	if (count > 0) {
		appendSummaryWarning(container, localize('paradis.office.summary.externalRelationships', "{0} external relationships are not loaded.", count));
	}
}

function snapshotBrowserRuntimeConfiguration(configurationService: IConfigurationService): ParadisOfficeRuntimeConfiguration {
	const reader: ParadisOfficeConfigurationReader = {
		getValue: <T>(key: string) => configurationService.getValue<T>(key),
		inspect: <T>(key: string) => configurationService.inspect<T>(key) as IConfigurationValue<T> | undefined,
	};
	return snapshotParadisOfficeRuntimeConfiguration(reader);
}

function isBrowserSemanticEnabled(
	format: ParadisOfficeSemanticFormat,
	diff: boolean,
	runtimeConfiguration: ParadisOfficeRuntimeConfiguration,
	workerAvailable: boolean,
): boolean {
	const capabilities = getParadisOfficeWebWorkerCapabilities(workerAvailable, runtimeConfiguration);
	const support = format === 'xlsx' || format === 'xlsm' || format === 'xltx' || format === 'xltm'
		? diff ? capabilities.features.excelDiff : capabilities.features.excelView
		: diff ? capabilities.features.wordDiff : capabilities.features.wordView;
	return capabilities.route === 'webWorkerV1' && support === 'semantic';
}

function appendSpreadsheetDiagonal(container: HTMLElement, diagonal: ParadisOfficeBrowserSpreadsheetDiagonal): void {
	const rgb = diagonal.color?.kind === 'rgb' ? diagonal.color.rgb : undefined;
	appendDiagonalLine(container, diagonal.down, diagonal.up, rgb);
}

function appendDiagonalLine(container: HTMLElement, topLeftToBottomRight: boolean, topRightToBottomLeft: boolean, rawColor?: string): void {
	const namespace = 'http://www.w3.org/2000/svg';
	const svg = container.ownerDocument.createElementNS(namespace, 'svg');
	svg.setAttribute('viewBox', '0 0 100 100');
	svg.setAttribute('preserveAspectRatio', 'none');
	svg.style.position = 'absolute';
	svg.style.inset = '0';
	svg.style.width = '100%';
	svg.style.height = '100%';
	svg.style.pointerEvents = 'none';
	const color = rawColor && /^(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(rawColor) ? `#${rawColor.slice(-6)}` : 'currentColor';
	if (topLeftToBottomRight) {
		appendSvgLine(svg, '0', '0', '100', '100', color);
	}
	if (topRightToBottomLeft) {
		appendSvgLine(svg, '0', '100', '100', '0', color);
	}
	container.appendChild(svg);
}

function appendSvgLine(svg: SVGSVGElement, x1: string, y1: string, x2: string, y2: string, color: string): void {
	const line = svg.ownerDocument.createElementNS(svg.namespaceURI, 'line');
	line.setAttribute('x1', x1);
	line.setAttribute('y1', y1);
	line.setAttribute('x2', x2);
	line.setAttribute('y2', y2);
	line.setAttribute('stroke', color);
	line.setAttribute('vector-effect', 'non-scaling-stroke');
	svg.appendChild(line);
}

const OFFICE_BROWSER_LABEL = localize('paradis.office.browser.label', "Office Viewer");

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ParadisOfficeDiagnosticEditor, PARADIS_OFFICE_BROWSER_EDITOR_ID, OFFICE_BROWSER_LABEL),
	[new SyncDescriptor(ParadisOfficeDiagnosticInput)],
);

registerParadisOfficeViewerSerializers(Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory), PARADIS_OFFICE_BROWSER_SERIALIZER_REGISTRATIONS);

class ParadisOfficeDiagnosticResolverContribution implements IWorkbenchContribution {
	static readonly ID = 'paradis.contrib.officeDiagnosticResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		for (const extension of PARADIS_OFFICE_DIAGNOSTIC_EXTENSIONS) {
			editorResolverService.registerEditor(
				paradisGlobForExtension(extension),
				{ id: PARADIS_OFFICE_BROWSER_EDITOR_ID, label: OFFICE_BROWSER_LABEL, priority: RegisteredEditorPriority.exclusive },
				{
					canSupportResource: resource => (resource.scheme === Schemas.file || resource.scheme === Schemas.vscodeRemote || resource.scheme === 'git') && isParadisOfficeDiagnosticResource(resource),
					singlePerResource: true,
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: instantiationService.createInstance(ParadisOfficeDiagnosticInput, resource, getParadisOfficeFormat(resource)!, 'diagnostic'),
						options,
					}),
					createDiffEditorInput: diffInput => {
						const modified = diffInput.modified.resource;
						if (!modified) {
							throw new Error('Para Code Office diagnostic requires a modified resource');
						}
						return { editor: instantiationService.createInstance(ParadisOfficeDiagnosticInput, modified, getParadisOfficeFormat(modified)!, 'diagnostic', undefined, diffInput.label) };
					},
				},
			);
		}
	}
}

registerWorkbenchContribution2(ParadisOfficeDiagnosticResolverContribution.ID, ParadisOfficeDiagnosticResolverContribution, WorkbenchPhase.BlockStartup);
