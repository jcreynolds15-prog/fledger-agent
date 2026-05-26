/**
 * SyteLine sync handlers — run on the agent (on-premise).
 * Each function opens its own mssql connection, queries, and returns plain data
 * that is serialised and sent back to the Fledger SaaS over WebSocket.
 */
import * as sql from 'mssql';
import { SqlConfig } from '../config';
import { logger } from '../logger';

// ─── connection pool factory ────────────────────────────────────────────────

function buildPoolConfig(cfg: SqlConfig): sql.config {
  const base: sql.config = {
    server: cfg.server,
    port: cfg.port,
    database: cfg.database,
    options: {
      encrypt: false,               // typical on-prem; set true for Azure SQL
      trustServerCertificate: true, // self-signed certs common on-prem
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
    connectionTimeout: 15_000,
    requestTimeout: 60_000,
  };

  if (cfg.windowsAuth) {
    base.options = { ...base.options, trustedConnection: true };
  } else {
    base.user = cfg.user;
    base.password = cfg.password;
  }

  return base;
}

async function withPool<T>(cfg: SqlConfig, fn: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
  const pool = await new sql.ConnectionPool(buildPoolConfig(cfg)).connect();
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

// ─── site qualifier helper ───────────────────────────────────────────────────

function siteWhere(cfg: SqlConfig, alias = ''): string {
  if (!cfg.site) return '';
  const col = alias ? `${alias}.site_ref` : 'site_ref';
  const safe = cfg.site.replace(/'/g, "''");
  return `AND ${col} = N'${safe}'`;
}

/** Wraps a table name with the configured database prefix if set */
function tbl(cfg: SqlConfig, table: string): string {
  return `[${cfg.database}].[dbo].[${table}]`;
}

// ─── Vendor sync ─────────────────────────────────────────────────────────────

export interface AgentVendor {
  vend_num: string;
  vend_name: string | null;
  phone: string | null;
  contact: string | null;
  stat: string | null;
  curr_code: string | null;
  terms_code: string | null;
  tax_reg_num1: string | null;
  vat_number: string | null;
  email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country_code: string | null;
  pay_hold: boolean | null;
}

export async function syncVendors(cfg: SqlConfig): Promise<AgentVendor[]> {
  logger.info('[sync] vendors start');
  return withPool(cfg, async (pool) => {
    const res = await pool.request().query<AgentVendor>(`
      SELECT
        v.vend_num,
        a.name           AS vend_name,
        v.phone,
        v.contact,
        v.stat,
        v.curr_code,
        v.terms_code,
        v.tax_reg_num1,
        v.VATnumber      AS vat_number,
        a.external_email_addr   AS email,
        a.[addr##1]      AS address_line1,
        a.[addr##2]      AS address_line2,
        a.city,
        a.state,
        a.zip            AS postal_code,
        a.country        AS country_code,
        a.pay_hold
      FROM   ${tbl(cfg, 'vendor_mst')} v
      LEFT JOIN ${tbl(cfg, 'vendaddr_mst')} a
        ON  a.vend_num = v.vend_num
        AND a.site_ref  = v.site_ref
      WHERE  v.stat <> 'I'
        ${siteWhere(cfg, 'v')}
      ORDER BY v.vend_num
    `);
    logger.info(`[sync] vendors done — ${res.recordset.length} rows`);
    return res.recordset;
  });
}

// ─── Purchase-Order sync ─────────────────────────────────────────────────────

export interface AgentPoLine {
  po_line: number;
  po_release: number | null;
  item: string | null;
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  qty_received: number | null;
  qty_invoiced: number | null;
  u_of_m: string | null;
  stat: string | null;
}

export interface AgentPurchaseOrder {
  po_num: string;
  vend_num: string | null;
  vend_name: string | null;
  order_date: string | null;
  stat: string | null;
  curr_code: string | null;
  amount_excluding_tax: number | null;
  tax_amount: number | null;
  freight: number | null;
  misc_charges: number | null;
  fully_received: boolean;
  lines: AgentPoLine[];
}

export async function syncPurchaseOrders(cfg: SqlConfig): Promise<AgentPurchaseOrder[]> {
  logger.info('[sync] purchase orders start');
  return withPool(cfg, async (pool) => {
    // 1 — headers
    const headers = await pool.request().query<{
      po_num: string; vend_num: string; vend_name: string | null;
      order_date: Date | null; stat: string | null; curr_code: string | null;
      amount_excluding_tax: number | null; tax_amount: number | null;
      freight: number | null; misc_charges: number | null; received: number | null;
    }>(`
      SELECT
        p.po_num,
        p.vend_num,
        a.name            AS vend_name,
        p.order_date,
        p.stat,
        p.curr_code,
        p.po_cost         AS amount_excluding_tax,
        p.sales_tax       AS tax_amount,
        p.freight,
        p.misc_charges,
        p.received
      FROM   ${tbl(cfg, 'po_mst')} p
      LEFT JOIN ${tbl(cfg, 'vendaddr_mst')} a
        ON  a.vend_num = p.vend_num
        AND a.site_ref  = p.site_ref
      WHERE  p.stat NOT IN ('X', 'C')
        ${siteWhere(cfg, 'p')}
      ORDER BY p.po_num
    `);

    if (headers.recordset.length === 0) {
      logger.info('[sync] purchase orders done — 0 rows');
      return [];
    }

    const poNums = headers.recordset.map((h) => `'${h.po_num.replace(/'/g, "''")}'`).join(',');

    // 2 — all lines for open POs in a single query
    const lines = await pool.request().query<AgentPoLine & { po_num: string }>(`
      SELECT
        i.po_num,
        i.po_line,
        i.po_release,
        i.item,
        i.description,
        i.qty_ordered     AS quantity,
        i.item_cost       AS unit_price,
        i.qty_received,
        i.qty_voucher     AS qty_invoiced,
        i.u_m             AS u_of_m,
        i.stat
      FROM   ${tbl(cfg, 'poitem_mst')} i
      WHERE  i.po_num IN (${poNums})
        ${siteWhere(cfg, 'i')}
      ORDER BY i.po_num, i.po_line, i.po_release
    `);

    // 3 — group lines by po_num
    const linesByPo = new Map<string, AgentPoLine[]>();
    for (const l of lines.recordset) {
      if (!linesByPo.has(l.po_num)) linesByPo.set(l.po_num, []);
      const { po_num: _ignored, ...rest } = l;
      linesByPo.get(l.po_num)!.push(rest);
    }

    const result: AgentPurchaseOrder[] = headers.recordset.map((h) => ({
      po_num: h.po_num,
      vend_num: h.vend_num,
      vend_name: h.vend_name,
      order_date: h.order_date ? h.order_date.toISOString() : null,
      stat: h.stat,
      curr_code: h.curr_code,
      amount_excluding_tax: h.amount_excluding_tax,
      tax_amount: h.tax_amount,
      freight: h.freight,
      misc_charges: h.misc_charges,
      fully_received: h.received === 1,
      lines: linesByPo.get(h.po_num) ?? [],
    }));

    logger.info(`[sync] purchase orders done — ${result.length} POs`);
    return result;
  });
}

// ─── Receipt / GRN sync ───────────────────────────────────────────────────────

export interface AgentReceiptLine {
  po_line: number;
  po_release: number | null;
  grn_line: number | null;
  item: string | null;
  description: string | null;
  qty_received: number | null;
  qty_returned: number | null;
  qty_vouchered: number | null;
  unit_price: number | null;
  u_of_m: string | null;
}

export interface AgentReceipt {
  grn_num: string;
  po_num: string | null;
  vend_num: string | null;
  vend_name: string | null;
  receipt_date: string | null;
  currency_code: string | null;
  lines: AgentReceiptLine[];
}

export async function syncReceipts(cfg: SqlConfig): Promise<AgentReceipt[]> {
  logger.info('[sync] receipts start');
  return withPool(cfg, async (pool) => {
    // 1 — distinct GRN headers (po_rcpt_mst is line-level; group by grn_num)
    const headers = await pool.request().query<{
      grn_num: string; po_num: string | null; vend_num: string | null;
      vend_name: string | null; receipt_date: Date | null; curr_code: string | null;
    }>(`
      SELECT
        r.grn_num,
        r.po_num,
        r.vend_num,
        a.name            AS vend_name,
        MIN(r.rcvd_date)  AS receipt_date,
        p.curr_code
      FROM   ${tbl(cfg, 'po_rcpt_mst')} r
      LEFT JOIN ${tbl(cfg, 'vendaddr_mst')} a
        ON  a.vend_num = r.vend_num
        AND a.site_ref  = r.site_ref
      LEFT JOIN ${tbl(cfg, 'po_mst')} p
        ON  p.po_num   = r.po_num
        AND p.site_ref  = r.site_ref
      WHERE  r.grn_num IS NOT NULL
        AND  r.grn_num <> ''
        ${siteWhere(cfg, 'r')}
      GROUP BY r.grn_num, r.po_num, r.vend_num, a.name, p.curr_code
      ORDER BY r.grn_num
    `);

    if (headers.recordset.length === 0) {
      logger.info('[sync] receipts done — 0 rows');
      return [];
    }

    const grnNums = headers.recordset.map((h) => `'${h.grn_num.replace(/'/g, "''")}'`).join(',');

    // 2 — all lines
    const lines = await pool.request().query<AgentReceiptLine & { grn_num: string }>(`
      SELECT
        r.grn_num,
        r.po_line,
        r.po_release,
        r.grn_line,
        p.item,
        p.description,
        r.qty_received,
        r.qty_returned,
        r.qty_vouchered,
        r.item_cost       AS unit_price,
        p.u_m             AS u_of_m
      FROM   ${tbl(cfg, 'po_rcpt_mst')} r
      LEFT JOIN ${tbl(cfg, 'poitem_mst')} p
        ON  p.po_num     = r.po_num
        AND p.po_line    = r.po_line
        AND p.po_release = r.po_release
        AND p.site_ref   = r.site_ref
      WHERE  r.grn_num IN (${grnNums})
        ${siteWhere(cfg, 'r')}
      ORDER BY r.grn_num, r.po_line, r.grn_line
    `);

    const linesByGrn = new Map<string, AgentReceiptLine[]>();
    for (const l of lines.recordset) {
      if (!linesByGrn.has(l.grn_num)) linesByGrn.set(l.grn_num, []);
      const { grn_num: _ignored, ...rest } = l;
      linesByGrn.get(l.grn_num)!.push(rest);
    }

    const result: AgentReceipt[] = headers.recordset.map((h) => ({
      grn_num: h.grn_num,
      po_num: h.po_num,
      vend_num: h.vend_num,
      vend_name: h.vend_name,
      receipt_date: h.receipt_date ? h.receipt_date.toISOString() : null,
      currency_code: h.curr_code,
      lines: linesByGrn.get(h.grn_num) ?? [],
    }));

    logger.info(`[sync] receipts done — ${result.length} GRNs`);
    return result;
  });
}

// ─── Connection test ──────────────────────────────────────────────────────────

export async function testConnection(cfg: SqlConfig): Promise<{ ok: boolean; message: string }> {
  try {
    await withPool(cfg, async (pool) => {
      await pool.request().query('SELECT 1 AS ping');
    });
    return { ok: true, message: 'Connected successfully' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: msg };
  }
}
