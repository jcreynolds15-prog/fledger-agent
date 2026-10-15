/**
 * Socket.io agent — connects outbound to AP Automation, receives job messages,
 * dispatches to local SQL handlers, and streams results back.
 *
 * The agent NEVER accepts inbound connections.
 * SQL credentials stay on-premise and are never sent to the cloud.
 */
import { io, Socket } from 'socket.io-client';
import { AgentConfig, IdoConfig, SqlConfig } from './config';
import { logger } from './logger';
import { socketOptions, serverHint } from './connection';
import { syncVendors, syncPurchaseOrders, syncReceipts } from './handlers/syteline-sync';
import { checkReadiness } from './readiness';
import { relay, signIn } from './ido';

// ─── Job payload types ─────────────────────────────────────────────────────────

interface JobMessage {
  job_id: string;
  action: string;
  payload?: unknown;
}

/** After AP Automation closes the connection, wait this long before trying again */
const RETRY_AFTER_CLOSE_MS = 30_000;
/** …or this long when it refused the key, which only changes when someone edits agent.env */
const RETRY_AFTER_BAD_KEY_MS = 5 * 60_000;

// ─── Agent class ───────────────────────────────────────────────────────────────

export class ApAutomationAgent {
  private socket: Socket | null = null;
  private stopped = false;
  private lastServerError = '';
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly cfg: AgentConfig) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.socket?.disconnect();
    this.socket = null;
    logger.info('Agent stopped');
  }

  // ── Connection ───────────────────────────────────────────────────────────────

  private connect(): void {
    logger.info(`Connecting to ${this.cfg.serverUrl}${this.cfg.proxyUrl ? ' through the proxy' : ''} …`);

    this.socket = io(this.cfg.serverUrl, {
      ...socketOptions(this.cfg),
      reconnection: true,
      reconnectionDelay: 2_000,
      reconnectionDelayMax: 60_000,
      reconnectionAttempts: Infinity,
      timeout: 15_000,
    });

    this.socket.on('connect', () => {
      this.lastServerError = '';
      logger.info('Connected — checking the agent key');
    });

    this.socket.on('registered', (data: { connector_id: string; connector_name: string }) => {
      logger.info(`Ready ✓  connector "${data.connector_name}" (${data.connector_id})`);
    });

    this.socket.on('job', (msg: JobMessage) => {
      this.handleJob(msg.job_id, msg.action, msg.payload).catch((err) => {
        logger.error(`Job ${msg.job_id} handler threw unexpectedly:`, err);
      });
    });

    this.socket.on('error', (msg: { message: string }) => {
      this.lastServerError = msg?.message ?? '';
      if (/invalid agent_key/i.test(this.lastServerError)) {
        logger.error(
          'AP Automation does not recognise this agent key. Copy the key from Connectors → Infor SyteLine → ' +
            'Configure into AGENT_KEY in agent.env, then restart the agent.',
        );
      } else {
        logger.error('AP Automation:', this.lastServerError);
      }
    });

    this.socket.on('disconnect', (reason: string) => {
      if (this.stopped) return;
      if (reason === 'io server disconnect') {
        // socket.io does not reconnect by itself after the server closes the connection.
        const badKey = /invalid agent_key/i.test(this.lastServerError);
        const wait = badKey ? RETRY_AFTER_BAD_KEY_MS : RETRY_AFTER_CLOSE_MS;
        logger.warn(`AP Automation closed the connection — trying again in ${wait / 1000}s`);
        this.retryTimer = setTimeout(() => {
          if (!this.stopped) this.socket?.connect();
        }, wait);
        return;
      }
      logger.warn(`Disconnected (${reason}) — reconnecting automatically`);
    });

    this.socket.on('connect_error', (err: Error) => {
      const hint = serverHint(err.message, this.cfg);
      logger.warn(`Cannot reach ${this.cfg.serverUrl}: ${err.message}${hint ? ` — ${hint}` : ''} Retrying …`);
    });
  }

  // ── Job dispatcher ────────────────────────────────────────────────────────────

  private get idoCfg(): IdoConfig {
    if (!this.cfg.ido) throw new Error("This agent is not set up for SyteLine's IDO service: IDO_URL is not set in its agent.env.");
    return this.cfg.ido;
  }

  private get sqlCfg(): SqlConfig {
    if (!this.cfg.sql) throw new Error("This agent is not set up for SyteLine's SQL database: MSSQL_SERVER is not set in its agent.env.");
    return this.cfg.sql;
  }

  private async handleJob(jobId: string, action: string, payload: unknown): Promise<void> {
    // IDO requests are many and small: log them at debug level only.
    const log = action === 'ido_request' ? logger.debug : logger.info;
    log(`Job ${jobId}: ${action}${action === 'ido_request' ? ` ${(payload as { operation?: string })?.operation}` : ''}`);

    try {
      let result: unknown;

      switch (action) {
        case 'test_connection': {
          const readiness = await checkReadiness(this.cfg);
          result = { ok: readiness.ok, message: readiness.summary };
          break;
        }

        case 'ido_token':
          result = { token: await signIn(this.idoCfg) };
          break;

        case 'ido_request':
          result = await relay(this.idoCfg, this.cfg.allowVouchers, payload as { operation?: string; envelope?: string });
          break;

        case 'sync_vendors':
          result = await syncVendors(this.sqlCfg);
          break;

        case 'sync_purchase_orders':
          result = await syncPurchaseOrders(this.sqlCfg);
          break;

        case 'sync_receipts':
          result = await syncReceipts(this.sqlCfg);
          break;

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      this.socket?.emit('result', { job_id: jobId, data: result });
      log(`Job ${jobId}: completed`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Job ${jobId} failed:`, message);
      this.socket?.emit('error', { job_id: jobId, message });
    }
  }
}
