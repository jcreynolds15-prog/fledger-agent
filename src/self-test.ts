/**
 * `ap-automation-agent.exe --test`: checks SQL Server and AP Automation can
 * both be reached with the settings in agent.env, and says what to fix.
 */
import { io } from 'socket.io-client';
import { AgentConfig, sqlLogin, sqlTarget } from './config';
import { serverHint, socketOptions } from './connection';
import { checkReadiness, CheckStatus } from './readiness';
import { AGENT_NAME, AGENT_VERSION } from './paths';

const TAG: Record<CheckStatus, string> = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]', info: '[ -- ]' };

const print = (status: CheckStatus, text: string) => console.log(`  ${TAG[status]} ${text}`);

/** Checks the key with AP Automation without taking over from a running agent. */
function probeServer(cfg: AgentConfig): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const socket = io(cfg.serverUrl, { ...socketOptions(cfg, { probe: true }), reconnection: false, timeout: 15_000 });
    let serverError = '';
    const finish = (ok: boolean, text: string) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.disconnect();
      resolve({ ok, text });
    };
    const timer = setTimeout(() => finish(false, `No answer from ${cfg.serverUrl} within 20s.`), 20_000);

    const accepted = (data: { connector_name: string }) =>
      finish(true, `Reached ${cfg.serverUrl}; the key belongs to connector "${data.connector_name}"`);
    socket.on('verified', accepted);
    socket.on('registered', accepted);
    socket.on('error', (msg: { message: string }) => {
      serverError = msg?.message ?? 'refused';
    });
    socket.on('disconnect', () => {
      finish(
        false,
        /invalid agent_key/i.test(serverError)
          ? 'AP Automation does not recognise AGENT_KEY. Copy it again from Connectors → Infor SyteLine → Configure.'
          : `AP Automation closed the connection${serverError ? `: ${serverError}` : ''}.`,
      );
    });
    socket.on('connect_error', (err: Error) => {
      const hint = serverHint(err.message, cfg);
      finish(false, `Cannot reach ${cfg.serverUrl}: ${err.message}${hint ? ` — ${hint}` : ''}`);
    });
  });
}

export async function selfTest(cfg: AgentConfig): Promise<boolean> {
  console.log(`${AGENT_NAME} ${AGENT_VERSION} — checking the settings`);
  console.log(`Settings: ${cfg.file ?? '(environment variables)'}`);
  console.log('');

  console.log(`SyteLine database — ${sqlTarget(cfg.sql)} / ${cfg.sql.database} as ${sqlLogin(cfg.sql)}`);
  const readiness = await checkReadiness(cfg.sql);
  for (const c of readiness.checks) print(c.status, c.text);
  console.log('');

  console.log(`AP Automation — ${cfg.serverUrl}${cfg.proxyUrl ? ' (through the proxy)' : ''}`);
  const server = await probeServer(cfg);
  print(server.ok ? 'ok' : 'fail', server.text);
  console.log('');

  const ok = readiness.ok && server.ok;
  console.log(ok ? 'All checks passed.' : 'Some checks failed — see [FAIL] above.');
  return ok;
}
