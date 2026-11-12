// Set to an absolute service URL (for example, https://ride.example.com) to enable sync.
import { inJourney } from './journey.js';

export const SERVER_URL = inJourney ? null : globalThis.ZRIDE_SERVER_URL || ((globalThis.location?.port === '8787' || /.trycloudflare.com$/.test(globalThis.location?.hostname || '')) ? globalThis.location.origin : null);
export const CLIENT_VERSION = '1.0.0';
