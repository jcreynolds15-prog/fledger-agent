/**
 * SQL Server connections for the handlers. Credentials come from agent.env and
 * never leave the customer's network.
 */
import * as sql from 'mssql';
import { SqlConfig } from './config';
import { AGENT_NAME } from './paths';

export function poolConfig(cfg: SqlConfig, poolMax = 5): sql.config {
  const options: sql.IOptions & Record<string, unknown> = {
    encrypt: cfg.encrypt,
    trustServerCertificate: true, // self-signed certificates are usual on-site
    appName: AGENT_NAME,          // so a DBA can see the agent's sessions
  };
  // A port given outright wins; otherwise a named instance is found through
  // SQL Browser (UDP 1434). tedious refuses both at once.
  if (cfg.instance && !cfg.port) options.instanceName = cfg.instance;
  if (cfg.legacyTls) {
    // SQL Server 2012/2014 before their TLS 1.2 updates only speak TLS 1.0.
    options.cryptoCredentialsDetails = { minVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0' };
  }

  const base: sql.config = {
    server: cfg.server,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    options,
    pool: { max: poolMax, min: 0, idleTimeoutMillis: 30_000 },
    connectionTimeout: 15_000,
    requestTimeout: 60_000,
  };
  if (!options.instanceName) base.port = cfg.port ?? 1433;
  // With a domain, tedious signs in with NTLM as DOMAIN\user.
  if (cfg.domain) base.domain = cfg.domain;
  return base;
}

export async function withPool<T>(cfg: SqlConfig, fn: (pool: sql.ConnectionPool) => Promise<T>, poolMax = 5): Promise<T> {
  const pool = await new sql.ConnectionPool(poolConfig(cfg, poolMax)).connect();
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

/** Wraps a table name with the configured database */
export function tbl(cfg: SqlConfig, table: string): string {
  return `[${cfg.database}].[dbo].[${table}]`;
}

/** A plain-English hint for the SQL errors people meet when first setting up. */
export function sqlHint(message: string, cfg: SqlConfig): string | null {
  if (/ssl|tls|EPROTO|wrong version|unsupported protocol/i.test(message)) {
    return cfg.legacyTls
      ? 'The SQL Server refused every TLS version offered. Check it has its TLS 1.2 updates.'
      : 'This SQL Server may only speak TLS 1.0/1.1. Set MSSQL_LEGACY_TLS=true in agent.env, or install its TLS 1.2 update.';
  }
  if (/Login failed/i.test(message)) {
    return cfg.domain
      ? 'Check the Windows account, its password and that it has a login on this SQL Server.'
      : 'Check the SQL login and password, and that SQL Server allows SQL Server authentication (mixed mode).';
  }
  if (/Failed to connect|ECONNREFUSED|ETIMEOUT|ESOCKET|getaddrinfo/i.test(message)) {
    return cfg.instance && !cfg.port
      ? 'Could not reach the named instance. Check the SQL Server Browser service is running (UDP 1434), or set MSSQL_PORT to the instance\'s TCP port.'
      : 'Could not reach SQL Server. Check the server name, that TCP/IP is enabled in SQL Server Configuration Manager, and the port (MSSQL_PORT, default 1433).';
  }
  if (/Cannot open database/i.test(message)) {
    return 'The login works but cannot open this database. Check MSSQL_DATABASE is the SyteLine application database and the login is a user in it.';
  }
  return null;
}
