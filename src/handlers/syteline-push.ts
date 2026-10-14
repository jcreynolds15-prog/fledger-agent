/**
 * SyteLine invoice push handler — runs on-premise inside the agent.
 * Inserts a supplier invoice (AP voucher) into SyteLine using a transaction
 * with atomic voucher-number allocation.
 */
import * as sql from 'mssql';
import { v4 as uuidv4 } from 'uuid';
import { SqlConfig } from '../config';
import { logger } from '../logger';

// ─── Types mirrored from fledger-app ─────────────────────────────────────────

export interface InvoiceLine {
  /**
   * The PO this line is against. An invoice covering several POs is one
   * voucher whose lines name their own POs; when absent, the header's PO.
   */
  po_num?: string;
  /** Optional: matched PO line number */
  po_line?: number;
  /** Optional: matched PO release number */
  po_release?: number;
  /** Optional: GRN number this line is matched against */
  grn_num?: string;
  /** Optional: GRN line number */
  grn_line?: number;
  item?: string;
  description?: string;
  /** Unit cost */
  unit_price: number;
  quantity: number;
  /** Line total (unit_price × quantity) */
  line_amount: number;
  u_of_m?: string;
}

export interface PushInvoicePayload {
  /** SyteLine vendor number */
  vend_num: string;
  /** Supplier's invoice reference */
  inv_num: string;
  inv_date: string;       // ISO date string
  currency_code: string;
  /** Total invoice amount (excl. tax) */
  inv_amount: number;
  tax_amount?: number;
  /** Optional: PO number this invoice relates to */
  po_num?: string;
  /** Optional: primary GRN number for header */
  grn_num?: string;
  lines: InvoiceLine[];
}

export interface PushInvoiceResult {
  /** The SyteLine voucher number allocated */
  voucher: number;
  vend_num: string;
  inv_num: string;
}

// ─── Push function ────────────────────────────────────────────────────────────

function buildPoolConfig(cfg: SqlConfig): sql.config {
  const base: sql.config = {
    server: cfg.server,
    port: cfg.port,
    database: cfg.database,
    options: {
      encrypt: false,
      trustServerCertificate: true,
    },
    pool: { max: 3, min: 0, idleTimeoutMillis: 30_000 },
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

function db(cfg: SqlConfig, table: string): string {
  return `[${cfg.database}].[dbo].[${table}]`;
}

export async function pushInvoice(cfg: SqlConfig, payload: PushInvoicePayload): Promise<PushInvoiceResult> {
  logger.info(`[push] invoice start — vendor=${payload.vend_num} inv=${payload.inv_num}`);

  const pool = await new sql.ConnectionPool(buildPoolConfig(cfg)).connect();
  const tx = pool.transaction();

  try {
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

    const site = cfg.site || 'MAIN';
    const safeSite = site.replace(/'/g, "''");

    // ── 1. Allocate next voucher number atomically ────────────────────────
    const allocRes = await tx.request().query<{ next_voucher: number }>(`
      SELECT ISNULL(MAX(voucher), 0) + 1 AS next_voucher
      FROM   ${db(cfg, 'vch_hdr_mst')} WITH (UPDLOCK, HOLDLOCK)
      WHERE  site_ref = N'${safeSite}'
    `);
    const voucher = allocRes.recordset[0].next_voucher;
    logger.debug(`[push] allocated voucher #${voucher}`);

    // ── 2. Insert vch_hdr_mst ─────────────────────────────────────────────
    const invDate = new Date(payload.inv_date);
    const totalAmount = payload.inv_amount + (payload.tax_amount ?? 0);

    const hdrReq = tx.request();
    hdrReq.input('site_ref',   sql.NVarChar(10),  site);
    hdrReq.input('voucher',    sql.Int,            voucher);
    hdrReq.input('vend_num',   sql.NVarChar(10),   payload.vend_num);
    hdrReq.input('type',       sql.NVarChar(1),    'V');  // V = vendor voucher
    hdrReq.input('po_num',     sql.NVarChar(15),   payload.po_num ?? '');
    hdrReq.input('inv_num',    sql.NVarChar(25),   payload.inv_num);
    hdrReq.input('inv_date',   sql.Date,           invDate);
    hdrReq.input('inv_amt',    sql.Decimal(15, 2), totalAmount);
    hdrReq.input('po_cost',    sql.Decimal(15, 2), payload.inv_amount);
    hdrReq.input('curr_code',  sql.NVarChar(5),    payload.currency_code);
    hdrReq.input('grn_num',    sql.NVarChar(15),   payload.grn_num ?? '');
    hdrReq.input('row_ptr',    sql.UniqueIdentifier, uuidv4());

    await hdrReq.query(`
      INSERT INTO ${db(cfg, 'vch_hdr_mst')} (
        site_ref, voucher, vend_num, type,
        po_num, inv_num, inv_date, dist_date,
        inv_amt, po_cost, curr_code, grn_num,
        RowPointer, NoteExistsFlag, RecordDate,
        CreatedBy, UpdatedBy, CreateDate, InWorkflow
      ) VALUES (
        @site_ref, @voucher, @vend_num, @type,
        @po_num, @inv_num, @inv_date, GETDATE(),
        @inv_amt, @po_cost, @curr_code, @grn_num,
        @row_ptr, 0, GETDATE(),
        N'FLEDGER', N'FLEDGER', GETDATE(), 0
      )
    `);

    // ── 3. Insert vch_item_mst lines ──────────────────────────────────────
    for (let seq = 0; seq < payload.lines.length; seq++) {
      const line = payload.lines[seq];
      const linePo = line.po_num ?? payload.po_num ?? '';

      const lineReq = tx.request();
      lineReq.input('site_ref',    sql.NVarChar(10),  site);
      lineReq.input('voucher',     sql.Int,            voucher);
      lineReq.input('po_num',      sql.NVarChar(15),   linePo);
      lineReq.input('po_line',     sql.Int,            line.po_line ?? 0);
      lineReq.input('po_release',  sql.Int,            line.po_release ?? 0);
      lineReq.input('item',        sql.NVarChar(30),   line.item ?? '');
      lineReq.input('cost',        sql.Decimal(15, 2), line.unit_price);
      lineReq.input('qty_voucher', sql.Decimal(15, 4), line.quantity);
      lineReq.input('qty_received',sql.Decimal(15, 4), line.quantity);
      lineReq.input('seq',         sql.Int,            seq + 1);
      lineReq.input('grn_num',     sql.NVarChar(15),   line.grn_num ?? '');
      lineReq.input('grn_line',    sql.Int,            line.grn_line ?? 0);
      lineReq.input('row_ptr',     sql.UniqueIdentifier, uuidv4());

      await lineReq.query(`
        INSERT INTO ${db(cfg, 'vch_item_mst')} (
          site_ref, voucher, po_num, po_line, po_release,
          item, cost, qty_voucher, qty_received, seq,
          grn_num, grn_line,
          RowPointer, NoteExistsFlag, RecordDate,
          CreatedBy, UpdatedBy, CreateDate, InWorkflow
        ) VALUES (
          @site_ref, @voucher, @po_num, @po_line, @po_release,
          @item, @cost, @qty_voucher, @qty_received, @seq,
          @grn_num, @grn_line,
          @row_ptr, 0, GETDATE(),
          N'FLEDGER', N'FLEDGER', GETDATE(), 0
        )
      `);

      // ── 4. Update po_vch_mst qty_vouchered for matched receipt lines ───
      if (line.po_line && line.po_release !== undefined && linePo) {
        const updReq = tx.request();
        updReq.input('site_ref',    sql.NVarChar(10),  site);
        updReq.input('po_num',      sql.NVarChar(15),  linePo);
        updReq.input('po_line',     sql.Int,           line.po_line);
        updReq.input('po_release',  sql.Int,           line.po_release ?? 0);
        updReq.input('qty_vch',     sql.Decimal(15, 4),line.quantity);
        updReq.input('voucher',     sql.Int,           voucher);

        await updReq.query(`
          UPDATE ${db(cfg, 'po_vch_mst')}
          SET    qty_vouchered = ISNULL(qty_vouchered, 0) + @qty_vch,
                 voucher       = @voucher,
                 UpdatedBy     = N'FLEDGER',
                 RecordDate    = GETDATE()
          WHERE  site_ref    = @site_ref
            AND  po_num      = @po_num
            AND  po_line     = @po_line
            AND  po_release  = @po_release
        `);
      }
    }

    await tx.commit();
    logger.info(`[push] invoice committed — voucher #${voucher}`);

    return {
      voucher,
      vend_num: payload.vend_num,
      inv_num: payload.inv_num,
    };
  } catch (err) {
    logger.error('[push] invoice failed, rolling back', err);
    try { await tx.rollback(); } catch { /* already rolled back */ }
    throw err;
  } finally {
    await pool.close();
  }
}
