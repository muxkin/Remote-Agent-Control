import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Credentials belong in a self-excluded local folder or an explicitly supplied file.
const configured = process.env.POCKET_ENV_FILE;
const file = resolve(configured || 'local/gateway.env');
if (configured || existsSync(file)) process.loadEnvFile(file);
