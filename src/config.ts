import * as dotenv from 'dotenv';
dotenv.config();

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

export interface SqlConfig {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
  site: string;
  windowsAuth: boolean;
}

export interface AgentConfig {
  agentKey: string;
  serverUrl: string;
  logLevel: string;
  sql: SqlConfig;
}

export function loadConfig(): AgentConfig {
  return {
    agentKey: require_env('AGENT_KEY'),
    serverUrl: process.env.SERVER_URL ?? 'https://api.fledger.co.uk',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    sql: {
      server: require_env('MSSQL_SERVER'),
      port: parseInt(process.env.MSSQL_PORT ?? '1433', 10),
      database: require_env('MSSQL_DATABASE'),
      user: process.env.MSSQL_USER ?? '',
      password: process.env.MSSQL_PASSWORD ?? '',
      site: process.env.MSSQL_SITE ?? '',
      windowsAuth: process.env.MSSQL_WINDOWS_AUTH === 'true',
    },
  };
}
