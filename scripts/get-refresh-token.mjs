import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';

const DEFAULT_CLIENT_FILE = '/Users/pavel/Downloads/client_secret_168158214150-tja7577r618htaj3hh2qm7r2mjsqpc14.apps.googleusercontent.com.json';
const DEFAULT_ENV_FILE = '.env';
const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CALLBACK_PATH = '/oauth2callback';

function parseArgs(argv) {
  const args = {
    clientFile: process.env.GOOGLE_OAUTH_CLIENT_FILE || DEFAULT_CLIENT_FILE,
    envFile: process.env.GOOGLE_OAUTH_ENV_FILE || DEFAULT_ENV_FILE,
    scope: process.env.GOOGLE_DRIVE_SCOPE || DEFAULT_SCOPE,
    port: Number(process.env.GOOGLE_OAUTH_PORT) || 0
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--client-file' && next) args.clientFile = next, i++;
    else if (arg === '--env-file' && next) args.envFile = next, i++;
    else if (arg === '--scope' && next) args.scope = next, i++;
    else if (arg === '--port' && next) args.port = Number(next) || 0, i++;
  }
  return args;
}

async function readClient(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const client = parsed.installed || parsed.web;
  if (!client?.client_id || !client?.client_secret) {
    throw new Error('OAuth client JSON must contain installed.client_id and installed.client_secret.');
  }
  return {
    clientId: client.client_id,
    clientSecret: client.client_secret
  };
}

function buildAuthUrl({ clientId, redirectUri, scope }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

async function exchangeCode({ clientId, clientSecret, redirectUri, code }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const token = await res.json();
  if (!token.refresh_token) {
    throw new Error('Google did not return a refresh_token. Re-run with prompt=consent or remove the existing app grant, then try again.');
  }
  return token;
}

async function updateEnvFile(filePath, values) {
  let current = '';
  try {
    current = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const lines = current.split(/\r?\n/);
  const next = [];
  const seen = new Set();
  for (const line of lines) {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (match && Object.prototype.hasOwnProperty.call(values, match[1])) {
      if (!seen.has(match[1])) {
        next.push(`${match[1]}=${JSON.stringify(values[match[1]])}`);
        seen.add(match[1]);
      }
      continue;
    }
    if (line.trim() || next.length > 0) next.push(line);
  }
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) next.push(`${key}=${JSON.stringify(value)}`);
  }
  await fs.writeFile(filePath, `${next.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
}

function createCallbackServer({ clientId, clientSecret, scope, envFile, port }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = null;
    const finish = (callback) => {
      if (timeoutId) clearTimeout(timeoutId);
      server.close(callback);
    };
    const server = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url || '/', `http://${req.headers.host}`);
        if (requestUrl.pathname !== CALLBACK_PATH) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        const code = requestUrl.searchParams.get('code');
        const error = requestUrl.searchParams.get('error');
        if (error) throw new Error(`OAuth error: ${error}`);
        if (!code) throw new Error('OAuth callback did not include a code.');

        const address = server.address();
        const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
        const token = await exchangeCode({ clientId, clientSecret, redirectUri, code });
        await updateEnvFile(envFile, {
          GOOGLE_DRIVE_CLIENT_ID: clientId,
          GOOGLE_DRIVE_CLIENT_SECRET: clientSecret,
          GOOGLE_DRIVE_REFRESH_TOKEN: token.refresh_token,
          GOOGLE_DRIVE_ROOT_FOLDER_NAME: 'Alea_Data',
          GOOGLE_DRIVE_MIRROR_ENABLED: '1'
        });

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><meta charset="utf-8"><title>Alea Drive OAuth</title><h1>Done</h1><p>Refresh token saved locally. You can close this tab.</p>');
        settled = true;
        finish(() => resolve({ envFile }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(error?.message || 'OAuth failed');
        settled = true;
        finish(() => reject(error));
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      const authUrl = buildAuthUrl({ clientId, redirectUri, scope });
      console.log('Open this URL in your browser and approve Drive access:');
      console.log(authUrl);
      console.log('');
      console.log(`Listening on ${redirectUri}`);
      console.log(`Will write local env values to ${path.resolve(envFile)}`);
    });
    timeoutId = setTimeout(() => {
      if (settled) return;
      finish(() => reject(new Error('Timed out waiting for OAuth callback.')));
    }, 10 * 60 * 1000);
  });
}

const args = parseArgs(process.argv.slice(2));
const client = await readClient(args.clientFile);
await createCallbackServer({
  ...client,
  scope: args.scope,
  envFile: args.envFile,
  port: args.port
});
console.log('OAuth refresh token saved. Values were not printed.');
