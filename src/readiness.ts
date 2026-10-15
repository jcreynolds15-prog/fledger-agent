/**
 * Checks the agent can do its job against this SyteLine database: signs in,
 * finds the tables and columns it reads and writes, has permission on them,
 * and knows which site to use. Run by `--test` and by Test Connection in
 * AP Automation.
 */
import * as sql from 'mssql';
import { SqlConfig, sqlLogin, sqlTarget } from './config';
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

/** Tables and columns the sync reads */
const READ: Record<string, string[]> = {
  vendor_mst: ['site_ref', 'vend_num', 'phone', 'contact', 'stat', 'curr_code', 'terms_code', 'tax_reg_num1', 'VATnumber'],
  vendaddr_mst: ['site_ref', 'vend_num', 'name', 'external_email_addr', 'addr##1', 'addr##2', 'city', 'state', 'zip', 'country', 'pay_hold'],
  po_mst: ['site_ref', 'po_num', 'vend_num', 'order_date', 'stat', 'curr_code', 'po_cost', 'sales_tax', 'freight', 'misc_charges', 'received'],
  poitem_mst: ['site_ref', 'po_num', 'po_line', 'po_release', 'item', 'description', 'qty_ordered', 'item_cost', 'qty_received', 'qty_voucher', 'u_m', 'stat'],
  po_rcpt_mst: ['site_ref', 'grn_num', 'po_num', 'po_line', 'po_release', 'grn_line', 'vend_num', 'rcvd_date', 'qty_received', 'qty_returned', 'qty_vouchered', 'item_cost'],
};

const AUDIT = ['RowPointer', 'NoteExistsFlag', 'RecordDate', 'CreatedBy', 'UpdatedBy', 'CreateDate', 'InWorkflow'];

/** Tables and columns a voucher is written to, with the permission each needs */
const WRITE: Record<string, { perm: 'INSERT' | 'UPDATE'; columns: string[] }> = {
  vch_hdr_mst: {
    perm: 'INSERT',
    columns: ['site_ref', 'voucher', 'vend_num', 'type', 'po_num', 'inv_num', 'inv_date', 'dist_date', 'inv_amt', 'po_cost', 'curr_code', 'grn_num', ...AUDIT],
  },
  vch_item_mst: {
    perm: 'INSERT',
    columns: ['site_ref', 'voucher', 'po_num', 'po_line', 'po_release', 'item', 'cost', 'qty_voucher', 'qty_received', 'seq', 'grn_num', 'grn_line', ...AUDIT],
  },
  po_vch_mst: {
    perm: 'UPDATE',
    columns: ['site_ref', 'po_num', 'po_line', 'po_release', 'qty_vouchered', 'voucher', 'UpdatedBy', 'RecordDate'],
  },
};

const n = (v: number) => v.toLocaleString('en-GB');

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

/** The site vouchers are written to: the configured one, else the only one in the database. */
export async function sitesIn(pool: sql.ConnectionPool): Promise<string[]> {
  const r = await pool.request().query<{ site_ref: string }>(
    `SELECT DISTINCT site_ref FROM dbo.vendor_mst WHERE site_ref IS NOT NULL ORDER BY site_ref`,
  );
  return r.recordset.map((x) => x.site_ref.trim());
}

export async function checkReadiness(cfg: SqlConfig): Promise<Readiness> {
  const checks: Check[] = [];
  const add = (status: CheckStatus, text: string) => checks.push({ status, text });
  let counts = '';
  let signedIn = '';

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
      signedIn = `${sqlTarget(cfg)} / ${row.db} as ${row.login}`;
      add('ok', `Signed in to ${sqlTarget(cfg)} as ${row.login} — ${edition} (${row.product}), database ${row.db}`);

      // Tables and columns
      const tables = [...Object.keys(READ), ...Object.keys(WRITE)];
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
        add('ok', `Found the ${Object.keys(READ).length} tables purchase orders and receipts are read from`);
      }

      const noRead: string[] = [];
      for (const t of Object.keys(READ)) {
        if (have.has(t) && !(await hasPerm(pool, t, 'SELECT'))) noRead.push(t);
      }
      if (noRead.length) add('fail', `The login cannot read ${noRead.join(', ')}. Grant it SELECT on them.`);
      else if (!readMissing.length) add('ok', 'The login can read them');

      // Site
      let sites: string[] = [];
      if (have.has('vendor_mst') && !noRead.includes('vendor_mst')) {
        sites = await sitesIn(pool);
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

      // What a sync would bring across
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

      // Vouchers
      const writeMissing = Object.entries(WRITE).flatMap(([t, w]) => missingIn(have, t, w.columns));
      const noWrite: string[] = [];
      for (const [t, w] of Object.entries(WRITE)) {
        if (have.has(t) && !(await hasPerm(pool, t, w.perm))) noWrite.push(`${w.perm} on ${t}`);
      }
      const writeStatus: CheckStatus = cfg.allowVouchers ? 'fail' : 'warn';
      if (writeMissing.length) add(writeStatus, `Voucher tables differ from what the agent writes: ${writeMissing.join(', ')} not found`);
      if (noWrite.length) add(writeStatus, `To post vouchers the login needs ${noWrite.join(', ')}`);
      if (cfg.allowVouchers) {
        if (!cfg.site && sites.length > 1) add('fail', 'Set MSSQL_SITE so vouchers go to the right site');
        if (!writeMissing.length && !noWrite.length) add('ok', 'Voucher posting is on, and the login can write vouchers');
      } else {
        add('info', 'Voucher posting is off (ALLOW_VOUCHERS in agent.env): AP Automation reads POs and receipts only');
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = sqlHint(message, cfg);
    add('fail', `Could not use SQL Server ${sqlTarget(cfg)} as ${sqlLogin(cfg)}: ${message}${hint ? ` — ${hint}` : ''}`);
  }

  const failed = checks.filter((c) => c.status === 'fail');
  const ok = failed.length === 0;
  const summary = ok
    ? [
        `Connected to ${signedIn}.`,
        counts ? `${counts[0].toUpperCase()}${counts.slice(1)}.` : '',
        cfg.allowVouchers ? 'Voucher posting on.' : 'Voucher posting off.',
        ...checks.filter((c) => c.status === 'warn').map((c) => c.text),
      ]
        .filter(Boolean)
        .join(' ')
    : failed.map((c) => c.text).join(' ');
  return { ok, checks, summary };
}
