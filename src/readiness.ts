/**
 * Checks the agent can do its job: through SyteLine's IDO web service (the
 * service answers, the user signs in, an IDO can be read) and/or its SQL
 * database (signs in, finds the tables and columns it reads, has permission,
 * knows the site). Run by `--test` and by Test Connection in AP Automation.
 */
import * as sql from 'mssql';
import { AgentConfig, IdoConfig, SqlConfig, sqlLogin, sqlTarget } from './config';
import { configurations, envelope, faultOf, post, signIn } from './ido';
import { sqlHint, withPool } from './sql';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  status: CheckStatus;
  text: string;
}

export interface Readiness {
  ok: boolean;
  checks: Check[];
  /** One line for AP Automation's Test Connection message */
  summary: string;
}

type Add = (status: CheckStatus, text: string) => void;

/** Tables and columns the SQL sync reads */
const READ: Record<string, string[]> = {
  vendor_mst: ['site_ref', 'vend_num', 'phone', 'contact', 'stat', 'curr_code', 'terms_code', 'tax_reg_num1', 'VATnumber'],
  vendaddr_mst: ['site_ref', 'vend_num', 'name', 'external_email_addr', 'addr##1', 'addr##2', 'city', 'state', 'zip', 'country', 'pay_hold'],
  po_mst: ['site_ref', 'po_num', 'vend_num', 'order_date', 'stat', 'curr_code', 'po_cost', 'sales_tax', 'freight', 'misc_charges', 'received'],
  poitem_mst: ['site_ref', 'po_num', 'po_line', 'po_release', 'item', 'description', 'qty_ordered', 'item_cost', 'qty_received', 'qty_voucher', 'u_m', 'stat'],
  po_rcpt_mst: ['site_ref', 'grn_num', 'po_num', 'po_line', 'po_release', 'grn_line', 'vend_num', 'rcvd_date', 'qty_received', 'qty_returned', 'qty_vouchered', 'item_cost'],
};

const n = (v: number) => v.toLocaleString('en-GB');

// ─── IDO service ─────────────────────────────────────────────────────────────

async function idoChecks(cfg: IdoConfig, add: Add): Promise<string> {
  let configs: string[];
  try {
    configs = await configurations(cfg);
  } catch (err) {
    add('fail', `The IDO service did not answer at ${cfg.url}: ${(err as Error).message}`);
    return '';
  }
  add('ok', `The IDO service answered at ${cfg.url}${configs.length ? `; configurations: ${configs.join(', ')}` : ''}`);
  if (configs.length && !configs.some((c) => c.toLowerCase() === cfg.config.toLowerCase())) {
    add('fail', `IDO_CONFIG "${cfg.config}" is not one of the configurations offered (${configs.join(', ')})`);
    return '';
  }

  let token: string;
  try {
    token = await signIn(cfg);
  } catch (err) {
    add('fail', `${(err as Error).message}. Check IDO_USER and IDO_PASSWORD; the user must be licensed for the SyteLineAutomation module (Users form).`);
    return '';
  }
  add('ok', `Signed in to SyteLine as ${cfg.user} (configuration ${cfg.config})`);

  const reply = await post(
    cfg,
    'LoadDataSet',
    envelope('LoadDataSet', [
      ['strSessionToken', token],
      ['strIDOName', 'SLVendors'],
      ['strPropertyList', 'VendNum'],
      ['strFilter', ''],
      ['strOrderBy', ''],
      ['strPostQueryMethod', ''],
      ['iRecordCap', '1'],
    ]),
  ).catch((err: Error) => ({ status: 0, body: '', error: err.message }));
  const fault = 'error' in reply ? reply.error : faultOf(reply.body);
  if (fault) add('fail', `Could not read vendors (SLVendors): ${fault}`);
  else add('ok', 'Read vendors through the SLVendors IDO');
  return fault ? '' : `the IDO service as ${cfg.user} (${cfg.config})`;
}

// ─── SQL database ────────────────────────────────────────────────────────────

function missingIn(have: Map<string, Set<string>>, table: string, columns: string[]): string[] {
  const cols = have.get(table.toLowerCase());
  if (!cols) return [`${table} (table)`];
  return columns.filter((c) => !cols.has(c.toLowerCase())).map((c) => `${table}.${c}`);
}

async function hasPerm(pool: sql.ConnectionPool, table: string, perm: string): Promise<boolean> {
  const r = await pool
    .request()
    .input('obj', sql.NVarChar(300), `dbo.${table}`)
    .input('perm', sql.NVarChar(30), perm)
    .query<{ allowed: number | null }>(`SELECT HAS_PERMS_BY_NAME(@obj, 'OBJECT', @perm) AS allowed`);
  return r.recordset[0]?.allowed === 1;
}

/** The sites (site_ref) the database holds vendors for */
export async function sitesIn(pool: sql.ConnectionPool): Promise<string[]> {
  const r = await pool.request().query<{ site_ref: string }>(
    `SELECT DISTINCT site_ref FROM dbo.vendor_mst WHERE site_ref IS NOT NULL ORDER BY site_ref`,
  );
  return r.recordset.map((x) => x.site_ref.trim());
}

async function sqlChecks(cfg: SqlConfig, add: Add): Promise<string> {
  let reached = '';
  let counts = '';
  try {
    await withPool(cfg, async (pool) => {
      const who = await pool.request().query<{ version: string; product: string; db: string; login: string }>(`
        SELECT @@VERSION AS version,
               CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(50)) AS product,
               DB_NAME() AS db,
               SUSER_SNAME() AS login
      `);
      const row = who.recordset[0];
      const edition = (row.version.split('\n')[0].match(/Microsoft SQL Server \d{4}[^(-]*/)?.[0] ?? 'SQL Server').trim();
      add('ok', `Signed in to ${sqlTarget(cfg)} as ${row.login} — ${edition} (${row.product}), database ${row.db}`);

      const tables = Object.keys(READ);
      const cols = await pool
        .request()
        .query<{ t: string; c: string }>(
          `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME IN (${tables.map((t) => `'${t}'`).join(',')})`,
        );
      const have = new Map<string, Set<string>>();
      for (const { t, c } of cols.recordset) {
        const key = t.toLowerCase();
        if (!have.has(key)) have.set(key, new Set());
        have.get(key)!.add(c.toLowerCase());
      }

      const readMissing = Object.entries(READ).flatMap(([t, c]) => missingIn(have, t, c));
      if (readMissing.length) {
        add('fail', `Not found in this database: ${readMissing.join(', ')}. Is MSSQL_DATABASE the SyteLine application database?`);
      } else {
        add('ok', `Found the ${tables.length} tables purchase orders and receipts are read from`);
      }

      const noRead: string[] = [];
      for (const t of tables) {
        if (have.has(t) && !(await hasPerm(pool, t, 'SELECT'))) noRead.push(t);
      }
      if (noRead.length) add('fail', `The login cannot read ${noRead.join(', ')}. Grant it SELECT on them.`);
      else if (!readMissing.length) add('ok', 'The login can read them');

      if (have.has('vendor_mst') && !noRead.includes('vendor_mst')) {
        const sites = await sitesIn(pool);
        if (cfg.site && !sites.some((s) => s.toUpperCase() === cfg.site.toUpperCase())) {
          add('fail', `Site ${cfg.site} has no vendors in this database (sites here: ${sites.join(', ') || 'none'}). Check MSSQL_SITE.`);
        } else if (cfg.site) {
          add('ok', `Site ${cfg.site}`);
        } else if (sites.length > 1) {
          add('warn', `This database holds sites ${sites.join(', ')}. Set MSSQL_SITE to the one AP Automation should use.`);
        } else if (sites.length === 1) {
          add('ok', `Site ${sites[0]} (the only one in this database)`);
        }
      }

      if (!readMissing.length && !noRead.length) {
        const site = cfg.site ? `AND site_ref = @site` : '';
        const r = await pool
          .request()
          .input('site', sql.NVarChar(10), cfg.site)
          .query<{ vendors: number; orders: number }>(`
            SELECT (SELECT COUNT(*) FROM dbo.vendor_mst WHERE stat <> 'I' ${site}) AS vendors,
                   (SELECT COUNT(*) FROM dbo.po_mst WHERE stat NOT IN ('X','C') ${site}) AS orders
          `);
        counts = `${n(r.recordset[0].vendors)} vendors and ${n(r.recordset[0].orders)} open POs`;
        add('info', `${counts} to sync`);
      }
      reached = `${sqlTarget(cfg)} / ${row.db} as ${row.login}`;
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = sqlHint(message, cfg);
    add('fail', `Could not use SQL Server ${sqlTarget(cfg)} as ${sqlLogin(cfg)}: ${message}${hint ? ` — ${hint}` : ''}`);
  }
  return reached ? `${reached}${counts ? ` (${counts})` : ''}` : '';
}

// ─── Both ────────────────────────────────────────────────────────────────────

export async function checkReadiness(cfg: AgentConfig, sections?: { ido?: Check[]; sql?: Check[] }): Promise<Readiness> {
  const checks: Check[] = [];
  const reached: string[] = [];
  const run = async (part: 'ido' | 'sql', fn: (add: Add) => Promise<string>) => {
    const own: Check[] = [];
    const add: Add = (status, text) => {
      own.push({ status, text });
      checks.push({ status, text });
    };
    const where = await fn(add);
    if (where) reached.push(where);
    if (sections) sections[part] = own;
  };
  if (cfg.ido) await run('ido', (add) => idoChecks(cfg.ido!, add));
  if (cfg.sql) await run('sql', (add) => sqlChecks(cfg.sql!, add));
  checks.push({
    status: 'info',
    text: cfg.allowVouchers
      ? 'Voucher posting is allowed (ALLOW_VOUCHERS): AP Automation may create vouchers through the IDO service'
      : 'Voucher posting is off (ALLOW_VOUCHERS in agent.env): AP Automation reads only',
  });

  const failed = checks.filter((c) => c.status === 'fail');
  const ok = failed.length === 0;
  const summary = ok
    ? [`Connected to ${reached.join(' and ')}.`, ...checks.filter((c) => c.status === 'warn').map((c) => c.text)].join(' ')
    : failed.map((c) => c.text).join(' ');
  return { ok, checks, summary };
}
