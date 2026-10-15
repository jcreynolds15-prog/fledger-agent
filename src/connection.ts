/**
 * How the agent reaches AP Automation: one outbound WebSocket over HTTPS
 * (port 443), through a proxy when the network needs one.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as tls from 'tls';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { ManagerOptions, SocketOptions } from 'socket.io-client';
import { AgentConfig } from './config';
import { AGENT_VERSION } from './paths';

/**
 * Node's own certificate list plus the Windows certificate store, so a proxy
 * that inspects TLS with the company's own root certificate is trusted the
 * same way the browsers on that server trust it. TLS_CA_FILE adds one more.
 */
function trustedCertificates(cfg: AgentConfig): string[] {
  const certs = [...tls.rootCertificates];
  const fromStore = (tls as unknown as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  if (fromStore) {
    try {
      certs.push(...fromStore('system'));
    } catch {
      /* no readable system store */
    }
  }
  if (cfg.caFile) certs.push(fs.readFileSync(cfg.caFile, 'utf8'));
  return certs;
}

export function socketOptions(cfg: AgentConfig, { probe = false } = {}): Partial<ManagerOptions & SocketOptions> {
  const ca = trustedCertificates(cfg);
  const options: Record<string, unknown> = {
    path: '/agent',
    auth: {
      agent_key: cfg.agentKey,
      version: AGENT_VERSION,
      host: os.hostname(),
      // A probe (--test) checks the key without taking over from the running agent.
      ...(probe ? { probe: true } : {}),
    },
    transports: ['websocket'],
    extraHeaders: { 'x-agent-version': AGENT_VERSION },
    ca,
  };
  if (cfg.proxyUrl) options.agent = new HttpsProxyAgent(cfg.proxyUrl, { ca });
  return options as Partial<ManagerOptions & SocketOptions>;
}

/** A plain-English hint for the errors met when first reaching AP Automation. */
export function serverHint(message: string, cfg: AgentConfig): string | null {
  if (/certificate|self.signed|unable to verify|UNABLE_TO_GET_ISSUER/i.test(message)) {
    return 'A proxy is replacing the site certificate. Put its root certificate (PEM) in a file and set TLS_CA_FILE in agent.env.';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return cfg.proxyUrl
      ? 'The proxy could not be found. Check PROXY_URL.'
      : 'This server cannot look up internet names. If it reaches the internet through a proxy, set PROXY_URL in agent.env.';
  }
  if (/ECONNREFUSED|ETIMEDOUT|timeout|ECONNRESET|websocket error/i.test(message)) {
    return cfg.proxyUrl
      ? 'Check the proxy allows HTTPS and WebSocket traffic to ' + cfg.serverUrl + '.'
      : `Check this server may make outbound HTTPS (port 443) connections to ${cfg.serverUrl}, or set PROXY_URL if it must use a proxy.`;
  }
  if (/407/.test(message)) return 'The proxy wants a sign-in: put it in PROXY_URL as http://user:password@proxy:port.';
  return null;
}
