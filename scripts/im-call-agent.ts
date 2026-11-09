/** Runs a user-supplied real-time media handler beside an existing encrypted IM Agent. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadCallAccount, runAgentCallListener } from '../src/client/agent-call-listener.js';

const { values } = parseArgs({ options: { state: { type: 'string' }, handler: { type: 'string' } } });
if (!values.state || !values.handler)
  throw Error('Usage: npm run im:call -- --state private-agent.json --handler ./media-handler.mjs');
const calls = await loadCallAccount(resolve(values.state));
const handler = await import(pathToFileURL(resolve(values.handler)).href);
const stop = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => stop.abort());
await runAgentCallListener(calls, handler, stop.signal, (state) => console.error('Agent calls:', state));
