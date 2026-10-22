import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createConfigStore } from './config.js';
import { createState } from './state.js';
import { createWorker } from './worker.js';
import { createApp } from './app.js';
import { createImageStore } from './images.js';

const required = ['EVOLUTION_BASE_URL', 'EVOLUTION_API_KEY', 'WEBHOOK_SHARED_SECRET', 'CONFIG_PATH', 'SQLITE_PATH'];
for (const key of required) if (!process.env[key]) throw new Error(`variavel obrigatoria ausente: ${key}`);
if (/^replace[-_]/i.test(process.env.EVOLUTION_API_KEY)) throw new Error('EVOLUTION_API_KEY precisa ser configurada');
if (process.env.WEBHOOK_SHARED_SECRET.length < 16 || /^replace[-_]/i.test(process.env.WEBHOOK_SHARED_SECRET)) throw new Error('WEBHOOK_SHARED_SECRET deve ter pelo menos 16 caracteres e nao ser um marcador');
const logger = {
  info: item => console.log(JSON.stringify(item)),
  warn: item => console.warn(JSON.stringify(item)),
  error: item => console.error(JSON.stringify(item))
};
await mkdir(dirname(process.env.SQLITE_PATH), { recursive: true });
const config = createConfigStore(process.env.CONFIG_WRITABLE_PATH || process.env.CONFIG_PATH, logger,
  process.env.CONFIG_WRITABLE_PATH ? { seedPath: process.env.CONFIG_PATH } : {});
await config.reload();
const state = createState(process.env.SQLITE_PATH);
const imageStore = createImageStore(join(dirname(process.env.CONFIG_WRITABLE_PATH || process.env.CONFIG_PATH), 'images'));
const worker = createWorker({ state, config, imageStore, baseUrl: process.env.EVOLUTION_BASE_URL, apiKey: process.env.EVOLUTION_API_KEY, logger });
const adminEnabled = process.env.ADMIN_ENABLED === 'true';
if (adminEnabled && !process.env.CONFIG_WRITABLE_PATH) throw new Error('CONFIG_WRITABLE_PATH obrigatorio para o painel');
const admin = {
  imageStore,
  enabled: adminEnabled,
  username: process.env.ADMIN_USERNAME,
  passwordHash: process.env.ADMIN_PASSWORD_HASH_B64 ? Buffer.from(process.env.ADMIN_PASSWORD_HASH_B64, 'base64').toString('utf8') : process.env.ADMIN_PASSWORD_HASH,
  origin: process.env.ADMIN_ORIGIN,
  secure: process.env.NODE_ENV === 'production' || process.env.ADMIN_ALLOW_HTTP !== 'true'
};
const app = createApp({ state, config, worker, webhookSecret: process.env.WEBHOOK_SHARED_SECRET, admin });
const interval = (callback, ms) => { const timer = setInterval(callback, ms); timer.unref(); return timer; };
interval(() => void config.reload(), Number(process.env.CONFIG_POLL_MS) || 5000);
interval(() => void worker.tick(), Number(process.env.WORKER_POLL_MS) || 1000);
interval(() => state.cleanup(Date.now() - (Number(process.env.RETENTION_DAYS) || 30) * 86_400_000), 3_600_000);
const stop = async () => { await app.close(); state.close(); process.exit(0); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT) || 3000 });
