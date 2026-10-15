/**
 * SyteLine's IDO web service, reached from the customer's network.
 *
 * AP Automation builds the IDO requests; the agent signs in with the SyteLine
 * user in agent.env (so that password never leaves the site) and passes the
 * requests on. It passes only the IDO service's own operations, to IDO_URL
 * only, and writes only when ALLOW_VOUCHERS is on.
 */
import * as http from 'http';
import * as https from 'https';
import { IdoConfig } from './config';
import { trustedCertificates } from './connection';

const IDO_NS = 'http://frontstep.com/IDOWebService';
const CALL_TIMEOUT_MS = 2 * 60_000;

/** Operations AP Automation may ask for, and which of them change SyteLine */
const READS = new Set(['GetConfigurationNames', 'LoadDataSet', 'LoadJson']);
const WRITES = new Set(['SaveDataSet', 'SaveJson', 'CallMethod']);

export interface IdoReply {
  status: number;
  body: string;
}

const xmlEscape = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const unescape = (v: string) =>
  v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function envelope(op: string, fields: [string, string][]): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soap:Body><${op} xmlns="${IDO_NS}">` +
    fields.map(([k, v]) => (v ? `<${k}>${xmlEscape(v)}</${k}>` : `<${k} />`)).join('') +
    `</${op}></soap:Body></soap:Envelope>`
  );
}

/** The message of a SOAP fault in a reply, if it is one */
export function faultOf(body: string): string | null {
  const m = body.match(/<(?:\w+:)?faultstring[^>]*>([\s\S]*?)<\/(?:\w+:)?faultstring>/);
  if (!m) return null;
  return unescape(m[1]).split('--->').pop()!.trim();
}

export function post(cfg: IdoConfig, op: string, soap: string): Promise<IdoReply> {
  const url = new URL(cfg.url);
  const secure = url.protocol === 'https:';
  const body = Buffer.from(soap, 'utf8');
  const options: https.RequestOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `"${IDO_NS}/${op}"`,
      'Content-Length': body.length,
    },
    timeout: CALL_TIMEOUT_MS,
    ...(secure ? { ca: trustedCertificates(), rejectUnauthorized: !cfg.insecureTls } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from ${cfg.url} within ${CALL_TIMEOUT_MS / 1000}s`)));
    req.on('error', (err: NodeJS.ErrnoException) => {
      const hint = /self.signed|UNABLE_TO|CERT_/i.test(`${err.code} ${err.message}`)
        ? ' (its certificate is not trusted: put the issuing certificate in the Windows store, or set IDO_TLS_INSECURE=true)'
        : '';
      reject(new Error(`Could not reach the IDO service at ${cfg.url}: ${err.code ?? err.message}${hint}`));
    });
    req.end(body);
  });
}

/** Signs in with the SyteLine user in agent.env and returns a session token. */
export async function signIn(cfg: IdoConfig): Promise<string> {
  const reply = await post(
    cfg,
    'CreateSessionToken',
    envelope('CreateSessionToken', [
      ['strUserId', cfg.user],
      ['strPswd', cfg.password],
      ['strConfig', cfg.config],
    ]),
  );
  const fault = faultOf(reply.body);
  if (fault) throw new Error(`SyteLine refused the sign-in for ${cfg.user}: ${fault}`);
  const token = reply.body.match(/<CreateSessionTokenResult>([^<]*)<\/CreateSessionTokenResult>/)?.[1]?.trim();
  if (!token) throw new Error(`SyteLine did not return a session token (HTTP ${reply.status})`);
  return unescape(token);
}

/** The configurations (sites) the IDO service offers; needs no sign-in. */
export async function configurations(cfg: IdoConfig): Promise<string[]> {
  const reply = await post(cfg, 'GetConfigurationNames', envelope('GetConfigurationNames', []));
  const fault = faultOf(reply.body);
  if (fault) throw new Error(fault);
  if (!/GetConfigurationNamesResponse/.test(reply.body)) {
    throw new Error(`HTTP ${reply.status} from ${cfg.url}, which is not the IDO web service (…/IDORequestService/IDOWebService.asmx)`);
  }
  return [...reply.body.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unescape(m[1]));
}

/** Passes a request from AP Automation to the IDO service, if it is one the agent allows. */
export async function relay(cfg: IdoConfig, allowWrites: boolean, req: { operation?: string; envelope?: string }): Promise<IdoReply> {
  const op = String(req.operation ?? '');
  if (!READS.has(op) && !WRITES.has(op)) throw new Error(`The agent does not pass on "${op}" to the IDO service`);
  if (WRITES.has(op) && !allowWrites) {
    throw new Error('Writing to SyteLine is switched off on this agent (ALLOW_VOUCHERS in agent.env).');
  }
  const soap = String(req.envelope ?? '');
  const first = soap.match(/<(?:\w+:)?Body[^>]*>\s*<(\w+)\s+xmlns="([^"]+)"/);
  if (!first || first[1] !== op || first[2] !== IDO_NS) {
    throw new Error(`The request is not a ${op} for the IDO service`);
  }
  return post(cfg, op, soap);
}
