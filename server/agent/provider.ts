import { lookup } from 'node:dns/promises';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { isIP } from 'node:net';
import { AgentError } from './errors';
import ipaddr from 'ipaddr.js';
import type { AgentTurn } from '../../shared/chat';

const MAX_PROVIDER_CALLS = 32;

export function publicAddress(address: string) {
  const ip = ipaddr.process(address);
  return ip.range() === 'unicast';
}

/** Resolve once and connect to that exact address. The URL hostname still controls TLS/SNI. */
async function destination(base: string, provider: AgentTurn['settings']['provider']) {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new AgentError('provider_endpoint');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new AgentError('provider_endpoint');
  const allowed = (process.env.FOLIO_AI_ALLOWED_ORIGINS ?? '').split(',').map((v) => v.trim());
  const trusted = allowed.includes(url.origin);
  if (url.protocol !== 'https:' && !(trusted && url.protocol === 'http:'))
    throw new AgentError('provider_endpoint');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const addresses = family
    ? [{ address: host, family }]
    : await lookup(host, { all: true }).catch(() => {
        throw new AgentError('provider_endpoint');
      });
  if (!addresses.length || (!trusted && addresses.some((a) => !publicAddress(a.address))))
    throw new AgentError('provider_endpoint');
  const address = addresses.find((a) => a.family === 4) ?? addresses[0];
  const suffix = provider === 'anthropic' ? '/v1/messages' : '/chat/completions';
  url.pathname = url.pathname.replace(/\/+$/, '') + suffix;
  // Bun's Node HTTP shim can ignore a custom lookup function. Connect to the literal
  // approved IP with no proxy, preserving the original Host, certificate identity and SNI.
  const pinnedUrl = new URL(url);
  pinnedUrl.hostname = address.family === 6 ? '[' + address.address + ']' : address.address;
  return { pinnedUrl, host, hostHeader: url.host };
}

/** A private per-turn relay keeps the user's API key out of the WASM settings and session store. */
export async function openProviderRelay(
  turn: AgentTurn,
  signal: AbortSignal,
  fail: (error: Error) => void,
) {
  const target = await destination(turn.settings.baseUrl, turn.settings.provider);
  signal.throwIfAborted();
  const ticket = crypto.randomUUID();
  const anthropic = turn.settings.provider === 'anthropic';
  const prefix = '/' + ticket;
  const endpoint = prefix + (anthropic ? '/v1/messages' : '/chat/completions');
  let calls = 0;
  const upstreamAbort = new AbortController();
  const upstreamSignal = AbortSignal.any([signal, upstreamAbort.signal]);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    maxRequestBodySize: 4 * 1024 * 1024,
    async fetch(req) {
      if (req.method !== 'POST' || new URL(req.url).pathname !== endpoint)
        return new Response(null, { status: 404 });
      try {
        if (++calls > MAX_PROVIDER_CALLS) throw new Error('本轮操作达到模型调用上限。');
        const body = await req.json();
        if (!Array.isArray(body.messages) || body.model !== turn.settings.model)
          throw new Error('Peri 模型请求格式异常。');
        // Each SDK turn has an ephemeral runtime. Restore the board's private conversation
        // using the provider's real message roles, keeping the SDK-authored tool calls intact.
        const systemCount = body.messages.findIndex(
          (message: { role: string }) => message.role !== 'system' && message.role !== 'developer',
        );
        body.messages.splice(Math.max(0, systemCount), 0, ...turn.history.slice(0, -1));
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'accept-encoding': 'identity',
        };
        if (anthropic) {
          headers['x-api-key'] = turn.settings.apiKey;
          headers['anthropic-version'] = req.headers.get('anthropic-version') ?? '2023-06-01';
          const beta = req.headers.get('anthropic-beta');
          if (beta) headers['anthropic-beta'] = beta;
        } else {
          headers.authorization = 'Bearer ' + turn.settings.apiKey;
        }
        headers.host = target.hostHeader;
        const response = await fetch(target.pinnedUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: upstreamSignal,
          redirect: 'manual',
          proxy: false,
          keepalive: false,
          timeout: false,
          tls: {
            serverName: target.host,
            checkServerIdentity: (_hostname: string, certificate: PeerCertificate) =>
              checkServerIdentity(target.host, certificate),
          },
        });
        if (!response.ok) {
          await response.body?.cancel();
          switch (response.status) {
            case 401:
            case 403:
              throw new AgentError('provider_auth');
            case 404:
              throw new AgentError('provider_endpoint');
            case 429:
              throw new AgentError('provider_rate_limit');
            default:
              throw new AgentError('provider_error');
          }
        }
        return new Response(response.body, {
          headers: { 'content-type': response.headers.get('content-type') ?? 'text/event-stream' },
        });
      } catch (cause) {
        if (!upstreamSignal.aborted)
          fail(cause instanceof AgentError ? cause : new AgentError('provider_error'));
        return Response.json({ error: { message: 'Provider request failed.' } }, { status: 400 });
      }
    },
  });
  return {
    url: server.url.origin + prefix,
    close() {
      upstreamAbort.abort();
      void server.stop(true);
    },
  };
}
