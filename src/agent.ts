/**
 * Socket.io agent — connects outbound to Fledger SaaS, receives job messages,
 * dispatches to local SQL handlers, and streams results back.
 *
 * The agent NEVER accepts inbound connections.
 * SQL credentials stay on-premise and are never sent to the cloud.
 */
import { io, Socket } from 'socket.io-client';
import { AgentConfig } from './config';
import { logger } from './logger';
import {
  syncVendors,
  syncPurchaseOrders,
  syncReceipts,
  testConnection,
} from './handlers/syteline-sync';
import { pushInvoice, PushInvoicePayload } from './handlers/syteline-push';

// ─── Job payload types ─────────────────────────────────────────────────────────

interface JobMessage {
  job_id: string;
  action: string;
  payload?: unknown;
}

// ─── Agent class ───────────────────────────────────────────────────────────────

export class FledgerAgent {
  private socket: Socket | null = null;
  private stopped = false;

  constructor(private readonly cfg: AgentConfig) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.disconnect();
    this.socket = null;
    logger.info('Agent stopped');
  }

  // ── Connection ───────────────────────────────────────────────────────────────

  private connect(): void {
    logger.info(`Connecting to ${this.cfg.serverUrl} …`);

    this.socket = io(this.cfg.serverUrl, {
      path: '/agent',
      auth: { agent_key: this.cfg.agentKey },
      reconnection: true,
      reconnectionDelay: 2_000,
      reconnectionDelayMax: 60_000,
      reconnectionAttempts: Infinity,
      timeout: 10_000,
      transports: ['websocket'],   // skip polling, go straight to WS
      extraHeaders: { 'x-agent-version': '1.0.0' },
    });

    this.socket.on('connect', () => {
      logger.info(`Connected (id=${this.socket?.id}) — registering agent key`);
    });

    this.socket.on('registered', (data: { connector_id: string; connector_name: string }) => {
      logger.info(`Registered ✓  connector="${data.connector_name}" (${data.connector_id})`);
    });

    this.socket.on('job', (msg: JobMessage) => {
      this.handleJob(msg.job_id, msg.action, msg.payload).catch((err) => {
        logger.error(`Job ${msg.job_id} handler threw unexpectedly:`, err);
      });
    });

    this.socket.on('error', (msg: { message: string }) => {
      logger.error('Server error:', msg.message);
    });

    this.socket.on('disconnect', (reason: string) => {
      if (this.stopped) return;
      logger.warn(`Disconnected (${reason}) — socket.io will reconnect automatically`);
    });

    this.socket.on('connect_error', (err: Error) => {
      logger.warn(`Connection failed: ${err.message} — retrying …`);
    });
  }

  // ── Job dispatcher ────────────────────────────────────────────────────────────

  private async handleJob(jobId: string, action: string, payload: unknown): Promise<void> {
    logger.info(`Job ${jobId}: ${action}`);
    const sqlCfg = this.cfg.sql;

    try {
      let result: unknown;

      switch (action) {
        case 'test_connection':
          result = await testConnection(sqlCfg);
          break;

        case 'sync_vendors':
          result = await syncVendors(sqlCfg);
          break;

        case 'sync_purchase_orders':
          result = await syncPurchaseOrders(sqlCfg);
          break;

        case 'sync_receipts':
          result = await syncReceipts(sqlCfg);
          break;

        case 'push_invoice':
          result = await pushInvoice(sqlCfg, payload as PushInvoicePayload);
          break;

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      this.socket?.emit('result', { job_id: jobId, data: result });
      logger.info(`Job ${jobId}: completed`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Job ${jobId} failed:`, message);
      this.socket?.emit('error', { job_id: jobId, message });
    }
  }
}
