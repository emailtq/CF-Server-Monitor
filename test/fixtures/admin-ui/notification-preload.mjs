import { register } from 'node:module';
globalThis.fetch = async () => { throw new Error('Task5 unexpected external fetch denied before imports'); };
register('./notification-loader.mjs', import.meta.url);
