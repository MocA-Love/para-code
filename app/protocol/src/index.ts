// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export { generateIdentity, createInitiator, respondHandshake, randomToken, SecureChannel } from './crypto.js';
export type { Identity, InitiatorHandshake, ResponderHandshake } from './crypto.js';
export { encodePairingUri, decodePairingUri, deriveSasCode, PAIRING_URI_SCHEME } from './pairing.js';
export type { PairingPayload } from './pairing.js';
export { Channels, encodeFrame, decodeFrame } from './frames.js';
export type { ChannelId, Frame } from './frames.js';
export { toBase64Url, fromBase64Url, concatBytes, bytesEqual } from './util.js';
