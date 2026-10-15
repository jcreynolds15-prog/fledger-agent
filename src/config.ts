import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { homeDir } from './paths';

export const CONFIG_FILE = 'agent.env';
export const DEFAULT_SERVER_URL = 'https://ap-automation.co.uk';

export interface SqlConfig {
  /** Host name or IP address of the SQL Server */
  server: string;
  /** Named instance (SERVER\INSTANCE); blank for the default instance */
  instance: string;
  /** TCP port; null for 1433, or for SQL Browser to find a named instance's port */
  port: number | null;
  database: string;
  user: string;
  password: string;
  /** Set for a Windows (NTLM) sign-in as DOMAIN\user; blank for a SQL Server login */
  domain: string;
  /** SyteLine site (site_ref); blank when the database holds one site */
  site: string;
  encrypt: boolean;
  /** Allow TLS 1.0/1.1 for older SQL Servers that have not been patched for TLS 1.2 */
  legacyTls: boolean;
}

/** SyteLine's IDO web service on the customer's network */
export interface IdoConfig {
  /** …/IDORequestService/IDOWebService.asmx */
  url: string;
  /** The SyteLine configuration (site) to sign in to */
  config: string;
  user: string;
  password: string;
  /** Accept a self-signed certificate on an https:// IDO address */
  insecureTls: boolean;
}

export interface AgentConfig {
  agentKey: string;
  serverUrl: string;
  logLevel: string;
  /** Outbound HTTP proxy, when the network has no direct route to the internet */
  proxyUrl: string;
  /** Extra trusted certificate (PEM) for a proxy that inspects TLS */
  caFile: string;
  /** The IDO service, when set up (the recommended way in) */
  ido: IdoConfig | null;
  /** The SQL database, when set up (read-only) */
  sql: SqlConfig | null;
  /** Whether AP Automation may create vouchers in SyteLine (through the IDO service) */
  allowVouchers: boolean;
  /** The settings file the values came from, or null when only the environment was used */
  file: string | null;
}

/** The settings file: --config <file>, else agent.env beside the agent, else .env in the working directory. */
export function configPath(argv: string[] = process.argv): string | null {
  const i = argv.indexOf('--config');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  for (const p of [path.join(homeDir(), CONFIG_FILE), path.join(process.cwd(), '.env')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export class ConfigError extends Error {}

const flag = (v: string | undefined) => /^(1|true|yes|on)$/i.test((v ?? '').trim());
const text = (key: string) => (process.env[key] ?? '').trim();

function missingError(keys: string[], file: string | null): ConfigError {
  return new ConfigError(
    `${keys.join(', ')} ${keys.length === 1 ? 'is' : 'are'} not set` +
      (file ? ` in ${file}` : ` (no ${CONFIG_FILE} found in ${homeDir()})`),
  );
}

function loadIdo(file: string | null): IdoConfig | null {
  if (!text('IDO_URL')) return null;
  const missing = ['IDO_CONFIG', 'IDO_USER'].filter((k) => !text(k));
  if (!process.env.IDO_PASSWORD) missing.push('IDO_PASSWORD');
  if (missing.length) throw missingError(missing, file);
  let url: URL;
  try {
    url = new URL(text('IDO_URL'));
  } catch {
    throw new ConfigError(`IDO_URL is not a web address: ${text('IDO_URL')}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new ConfigError(`IDO_URL must start with http:// or https://`);
  return {
    url: url.toString(),
    config: text('IDO_CONFIG'),
    user: text('IDO_USER'),
    password: process.env.IDO_PASSWORD ?? '',
    insecureTls: flag(process.env.IDO_TLS_INSECURE),
  };
}

function loadSql(file: string | null): SqlConfig | null {
  if (!text('MSSQL_SERVER')) return null;
  if (!text('MSSQL_DATABASE')) throw missingError(['MSSQL_DATABASE'], file);

  // SERVER\INSTANCE is how SQL Server names are usually written; accept it as is.
  let [server, instance = ''] = text('MSSQL_SERVER').split('\\');
  if (text('MSSQL_INSTANCE')) instance = text('MSSQL_INSTANCE');

  // DOMAIN\user likewise, for a Windows sign-in.
  let user = text('MSSQL_USER');
  let domain = text('MSSQL_DOMAIN');
  if (!domain && user.includes('\\')) [domain, user] = user.split('\\');

  if (flag(process.env.MSSQL_WINDOWS_AUTH) && !domain) {
    throw new ConfigError(
      'MSSQL_WINDOWS_AUTH is on but no domain is set. The agent signs in to SQL Server as a named Windows account: ' +
        'set MSSQL_DOMAIN, MSSQL_USER and MSSQL_PASSWORD, or use a SQL Server login instead.',
    );
  }
  if (!user || !process.env.MSSQL_PASSWORD) {
    throw new ConfigError('MSSQL_USER and MSSQL_PASSWORD must be set: a SQL Server login, or a Windows account with MSSQL_DOMAIN.');
  }

  const port = text('MSSQL_PORT') ? parseInt(text('MSSQL_PORT'), 10) : null;
  if (port !== null && !(port > 0 && port < 65536)) throw new ConfigError(`MSSQL_PORT is not a port number: ${text('MSSQL_PORT')}`);

  return {
    server: server.trim(),
    instance: instance.trim(),
    port,
    database: text('MSSQL_DATABASE'),
    user,
    password: process.env.MSSQL_PASSWORD ?? '',
    domain,
    site: text('MSSQL_SITE'),
    encrypt: flag(process.env.MSSQL_ENCRYPT),
    legacyTls: flag(process.env.MSSQL_LEGACY_TLS),
  };
}

export function loadConfig(argv: string[] = process.argv): AgentConfig {
  const file = configPath(argv);
  if (file) {
    if (!fs.existsSync(file)) throw new ConfigError(`Settings file not found: ${file}`);
    dotenv.config({ path: file });
  }

  if (!text('AGENT_KEY')) throw missingError(['AGENT_KEY'], file);
  const ido = loadIdo(file);
  const sql = loadSql(file);
  if (!ido && !sql) {
    throw new ConfigError(
      `Neither IDO_URL (SyteLine's IDO web service) nor MSSQL_SERVER (its SQL database) is set` +
        (file ? ` in ${file}` : '') + '. Set up at least one.',
    );
  }

  return {
    agentKey: text('AGENT_KEY'),
    serverUrl: (text('SERVER_URL') || DEFAULT_SERVER_URL).replace(/\/+$/, ''),
    logLevel: text('LOG_LEVEL') || 'info',
    proxyUrl: text('PROXY_URL') || text('HTTPS_PROXY') || text('https_proxy'),
    caFile: text('TLS_CA_FILE'),
    ido,
    sql,
    allowVouchers: flag(process.env.ALLOW_VOUCHERS),
    file,
  };
}

/** How the SQL Server is addressed, for logs and messages: HOST\INSTANCE,PORT */
export function sqlTarget(cfg: SqlConfig): string {
  return `${cfg.server}${cfg.instance ? `\\${cfg.instance}` : ''}${cfg.port ? `,${cfg.port}` : ''}`;
}

export function sqlLogin(cfg: SqlConfig): string {
  return cfg.domain ? `${cfg.domain}\\${cfg.user} (Windows)` : `${cfg.user} (SQL login)`;
}
