import { ConfigError, loadConfig } from './config.js';
import { GhostClient } from './ghost.js';
import { createHttpServer } from './server.js';

const log = (line: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...line }));

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) console.error(e.message);
  else console.error('Failed to load configuration');
  process.exit(1);
}

const ghost = new GhostClient(cfg);
const server = createHttpServer(cfg, ghost, log);

server.listen(cfg.port, cfg.host, () => {
  log({
    msg: 'listening',
    port: cfg.port,
    ghost: cfg.apiBase,
    api_version: cfg.apiVersion,
    read_only: cfg.readOnly,
    delete_enabled: cfg.enableDelete && !cfg.readOnly,
    members_enabled: cfg.enableMembers,
  });
  // Non-fatal preflight so misconfiguration (redirects, bad key) shows up in the logs at boot.
  void (async () => {
    try {
      const site = await ghost.get('/site/', undefined, false);
      log({ msg: 'ghost reachable', title: site?.site?.title, version: site?.site?.version });
      await ghost.get('/tags/', { limit: 1 });
      log({ msg: 'ghost admin key accepted' });
    } catch (e) {
      log({ msg: 'ghost preflight failed', error: e instanceof Error ? e.message : String(e) });
    }
  })();
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
