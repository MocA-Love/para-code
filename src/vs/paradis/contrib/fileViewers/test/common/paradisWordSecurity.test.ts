/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, doesNotMatch, ok, strictEqual, throws } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisOfficePackageError } from '../../common/office/paradisOfficeArchive.js';
import { fingerprintParadisWordObjectBytes } from '../../common/word/paradisWordObjects.js';
import {
	parseParadisWordSecurity,
	type ParadisWordExternalUnsafeNode,
	type ParadisWordSecurityPartInput,
} from '../../common/word/paradisWordSecurity.js';

const contentTypeNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const office = 'urn:schemas-microsoft-com:office:office';
const vml = 'urn:schemas-microsoft-com:vml';

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function part(partUri: string, value: string | Uint8Array): ParadisWordSecurityPartInput {
	const bytes = typeof value === 'string' ? utf8(value) : value;
	return { bytes, source: { partUri, partFingerprint: fingerprintParadisWordObjectBytes(bytes) } };
}

function relationships(entries: string): string {
	return `<Relationships xmlns="${packageRelationships}">${entries}</Relationships>`;
}

function contentTypes(oleContentType = 'application/vnd.openxmlformats-officedocument.oleObject'): string {
	return `<Types xmlns="${contentTypeNamespace}">
		<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
		<Default Extension="png" ContentType="image/png"/>
		<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/>
		<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>
		<Override PartName="/_xmlsignatures/sig1.xml" ContentType="application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml"/>
		<Override PartName="/word/embeddings/oleObject1.bin" ContentType="${oleContentType}"/>
		<Override PartName="/word/activeX/activeX1.bin" ContentType="application/vnd.ms-office.activeX"/>
		<Override PartName="/word/embeddings/package1.docx" ContentType="application/vnd.openxmlformats-officedocument.package"/>
	</Types>`;
}

function documentXml(): string {
	return `<w:document xmlns:w="${word}" xmlns:r="${officeRelationships}" xmlns:o="${office}" xmlns:v="${vml}"><w:body>
		<w:p><w:r><w:object><v:shape><v:imagedata r:id="rPreview"/></v:shape><o:OLEObject Type="Embed" ProgID="Private.Customer.Object" r:id="rOle"/></w:object></w:r></w:p>
		<w:p><w:r><w:object><v:shape><v:imagedata r:id="rPreview"/></v:shape><o:OLEObject Type="Embed" ProgID="Package.Private" r:id="rPackage"/></w:object></w:r></w:p>
		<w:p><w:fldSimple w:instr=" DDEAUTO &quot;C:\\private\\calc.exe&quot; secret "><w:r><w:t>saved only</w:t></w:r></w:fldSimple></w:p>
		<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> DDE private-server </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>cached</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
	</w:body></w:document>`;
}

function fixtureParts(overrides: { readonly oleContentType?: string; readonly embeddedBytes?: Uint8Array } = {}): ParadisWordSecurityPartInput[] {
	return [
		part('/[Content_Types].xml', contentTypes(overrides.oleContentType)),
		part('/_rels/.rels', relationships(`<Relationship Id="rDocument" Type="${officeRelationships}/officeDocument" Target="word/document.xml"/>`)),
		part('/word/document.xml', documentXml()),
		part('/word/_rels/document.xml.rels', relationships([
			`<Relationship Id="rVba" Type="${officeRelationships}/vbaProject" Target="vbaProject.bin"/>`,
			`<Relationship Id="rOle" Type="${officeRelationships}/oleObject" Target="embeddings/oleObject1.bin"/>`,
			`<Relationship Id="rPreview" Type="${officeRelationships}/image" Target="media/preview.png"/>`,
			`<Relationship Id="rActiveX" Type="${officeRelationships}/control" Target="activeX/activeX1.bin"/>`,
			`<Relationship Id="rPackage" Type="${officeRelationships}/package" Target="embeddings/package1.docx"/>`,
			`<Relationship Id="rRemoteImage" Type="${officeRelationships}/image" TargetMode="External" Target="https://private.example/image.png?token=secret"/>`,
			`<Relationship Id="rRemoteData" Type="${officeRelationships}/hyperlink" TargetMode="External" Target="file:///private/customer.txt"/>`,
		].join(''))),
		part('/word/vbaProject.bin', 'RAW-VBA-PRIVATE'),
		part('/_xmlsignatures/sig1.xml', '<Signature>PRIVATE-SIGNATURE</Signature>'),
		part('/word/embeddings/oleObject1.bin', 'RAW-OLE-PRIVATE'),
		part('/word/activeX/activeX1.bin', 'RAW-ACTIVEX-PRIVATE'),
		part('/word/embeddings/package1.docx', overrides.embeddedBytes ?? utf8('PK\u0003\u0004NESTED-PACKAGE-PRIVATE')),
		part('/word/media/preview.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])),
	];
}

function invalid(run: () => unknown, code: ParadisOfficePackageError['code']): void {
	throws(run, error => error instanceof ParadisOfficePackageError && error.code === code && error.message === code);
}

suite('ParadisWordSecurity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('models VBA, signatures, OLE previews, ActiveX, and embedded packages as non-executable placeholders', () => {
		const parts = fixtureParts();
		const model = parseParadisWordSecurity({ parts });
		const kinds = model.unsafeNodes.map(node => node.kind);

		deepStrictEqual(kinds, ['vba', 'signature', 'ole', 'activeX', 'embeddedPackage', 'dde', 'dde', 'externalImage', 'externalRelationship']);
		strictEqual(model.assetPolicy.rawAccess, 'denied');
		ok(model.unsafeNodes.every(node => node.rawAssetAccess === 'denied'));
		strictEqual(model.unsafeNodes.find(node => node.kind === 'vba')?.behavior, 'notExecuted');
		strictEqual(model.unsafeNodes.find(node => node.kind === 'signature')?.behavior, 'notVerified');
		strictEqual(model.unsafeNodes.find(node => node.kind === 'activeX')?.behavior, 'notExecuted');
		strictEqual(model.unsafeNodes.find(node => node.kind === 'embeddedPackage')?.behavior, 'notExpanded');

		const ole = model.unsafeNodes.find(node => node.kind === 'ole');
		strictEqual(ole?.behavior, 'notExecuted');
		strictEqual(ole?.objectType, 'embedded');
		strictEqual(ole?.fingerprint.value, parts.find(candidate => candidate.source.partUri.endsWith('oleObject1.bin'))?.source.partFingerprint.value);
		strictEqual(ole?.previewReferenceId, model.assetPolicy.previewReferences[0].id);
		deepStrictEqual(model.assetPolicy.previewReferences.map(reference => ({ contentType: reference.contentType, fingerprint: reference.fingerprint })), [{
			contentType: 'image/png', fingerprint: parts.find(candidate => candidate.source.partUri.endsWith('preview.png'))?.source.partFingerprint,
		}]);

		const serialized = JSON.stringify(model);
		doesNotMatch(serialized, /Private\.Customer|Package\.Private|private\.example|customer\.txt|calc\.exe|private-server|RAW-|PRIVATE-SIGNATURE|NESTED-PACKAGE/);
		doesNotMatch(serialized, /"bytes"|"partUri"|https?:\/\/|file:\/\//);
	});

	test('redacts DDE instructions and external targets while preserving their hashes and zero-action disposition', () => {
		const model = parseParadisWordSecurity({ parts: fixtureParts() });
		const dde = model.unsafeNodes.filter(node => node.kind === 'dde');
		const external = model.unsafeNodes.filter((node): node is ParadisWordExternalUnsafeNode => node.kind === 'externalImage' || node.kind === 'externalRelationship');

		strictEqual(dde.length, 2);
		ok(dde.every(node => node.behavior === 'notExecuted' && node.instructionFingerprint.algorithm === 'sha256'));
		deepStrictEqual(external.map(node => [node.kind, node.targetScheme, node.behavior]), [
			['externalImage', 'https', 'notFetched'],
			['externalRelationship', 'file', 'notFetched'],
		]);
		strictEqual(external[0].targetFingerprint.value, fingerprintParadisWordObjectBytes(utf8('https://private.example/image.png?token=secret')).value);
		strictEqual(external[1].targetFingerprint.value, fingerprintParadisWordObjectBytes(utf8('file:///private/customer.txt')).value);
	});

	test('does not recursively inspect or expose an embedded package', () => {
		const nested = utf8('PK\u0003\u0004[Content_Types].xml word/vbaProject.bin NESTED-VBA-SECRET');
		const model = parseParadisWordSecurity({ parts: fixtureParts({ embeddedBytes: nested }) });
		const embedded = model.unsafeNodes.filter(node => node.kind === 'embeddedPackage');

		strictEqual(embedded.length, 1);
		strictEqual(embedded[0].behavior, 'notExpanded');
		strictEqual(model.unsafeNodes.filter(node => node.kind === 'vba').length, 1);
		doesNotMatch(JSON.stringify(model), /NESTED-VBA-SECRET|Content_Types|vbaProject\.bin/);
	});

	test('requires content type and relationship authority before classifying unsafe parts', () => {
		const mismatched = fixtureParts({ oleContentType: 'application/octet-stream' });
		invalid(() => parseParadisWordSecurity({ parts: mismatched }), 'unsafe');

		const forged = fixtureParts();
		forged[2] = { ...forged[2], source: { ...forged[2].source, partFingerprint: { ...forged[2].source.partFingerprint, value: '0'.repeat(64) } } };
		invalid(() => parseParadisWordSecurity({ parts: forged }), 'unsafe');

		const traversal = fixtureParts();
		traversal[3] = part('/word/_rels/document.xml.rels', relationships(`<Relationship Id="rOle" Type="${officeRelationships}/oleObject" Target="../../../private.bin"/>`));
		invalid(() => parseParadisWordSecurity({ parts: traversal }), 'unsafe');
	});

	test('rejects ContentType parameters before classification or preview metadata projection', () => {
		const parameterized = fixtureParts();
		parameterized[0] = part('/[Content_Types].xml', contentTypes().replace('image/png', 'image/png; token=private'));
		invalid(() => parseParadisWordSecurity({ parts: parameterized }), 'malformed');
	});

	test('owns fixed bytes and rejects proxies, cancellation, deadlines, and configured bounds', () => {
		const parts = fixtureParts();
		const model = parseParadisWordSecurity({ parts });
		const serialized = JSON.stringify(model);
		parts[4].bytes.fill(0);
		strictEqual(JSON.stringify(model), serialized);

		const proxiedBytes = fixtureParts();
		proxiedBytes[0] = { ...proxiedBytes[0], bytes: new Proxy(proxiedBytes[0].bytes, {}) };
		invalid(() => parseParadisWordSecurity({ parts: proxiedBytes }), 'unsafe');
		invalid(() => parseParadisWordSecurity(new Proxy({ parts: fixtureParts() }, { getOwnPropertyDescriptor: () => { throw new Error('private'); } }) as never), 'unsafe');
		invalid(() => parseParadisWordSecurity({ parts: fixtureParts(), token: CancellationToken.Cancelled }), 'cancelled');

		let now = 0;
		invalid(() => parseParadisWordSecurity({ parts: fixtureParts() }, { now: () => now++, deadlineMilliseconds: 0 }), 'limitExceeded');
		invalid(() => parseParadisWordSecurity({ parts: fixtureParts() }, { maximumParts: 1 }), 'limitExceeded');
		invalid(() => parseParadisWordSecurity({ parts: fixtureParts() }, { maximumPartBytes: 16 }), 'limitExceeded');
		invalid(() => parseParadisWordSecurity({ parts: fixtureParts() }, new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('private'); } }) as never), 'unsafe');
	});
});
