/**
 * NanoClaw WeChat Bridge Channel
 *
 * Receives inbound messages from agentserver (which long-polls iLink)
 * and sends outbound replies back to agentserver (which forwards to iLink).
 *
 * Environment variables:
 *   NANOCLAW_WEIXIN_BRIDGE_URL - agentserver endpoint for sending replies
 *   NANOCLAW_BRIDGE_SECRET - shared secret for HTTP auth
 */

import http from 'http';
import https from 'https';

// These imports work when the file is copied into src/channels/weixin/
// and the barrel import in src/channels/index.ts includes it.
import { registerChannel } from '../registry.js';
import type { ChannelOpts } from '../registry.js';
import type { Channel, NewMessage } from '../../types.js';
import { readEnvFile } from '../../env.js';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function httpPost(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      parsed,
      { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

class WeixinChannel implements Channel {
  name = 'weixin';
  private server: http.Server;
  private opts: ChannelOpts;
  private bridgeURL: string;
  private bridgeSecret: string;
  private connected = false;

  constructor(opts: ChannelOpts, bridgeURL: string, bridgeSecret: string) {
    this.opts = opts;
    this.bridgeURL = bridgeURL;
    this.bridgeSecret = bridgeSecret;

    this.server = http.createServer(async (req, res) => {
      try {
        // Health check (no auth required for K8s probes)
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200);
          res.end('ok');
          return;
        }

        // Auth check for all other endpoints
        const authHeader = req.headers['authorization'];
        if (authHeader !== `Bearer ${this.bridgeSecret}`) {
          res.writeHead(401);
          res.end('Unauthorized');
          return;
        }

        if (req.method === 'POST' && req.url === '/message') {
          const body = await readBody(req);
          const msg: NewMessage = JSON.parse(body);
          // Auto-register this chat as a solo group if not already registered.
          // WeChat is a direct-messaging platform — no manual group setup flow.
          this.opts.autoRegisterChat?.(msg.chat_jid, msg.sender_name || msg.chat_jid);
          this.opts.onMessage(msg.chat_jid, msg);
          res.writeHead(200);
          res.end('ok');
          return;
        }

        if (req.method === 'POST' && req.url === '/metadata') {
          const body = await readBody(req);
          const data = JSON.parse(body) as {
            chat_jid: string;
            timestamp: string;
            name?: string;
            is_group?: boolean;
          };
          this.opts.onChatMetadata(
            data.chat_jid,
            data.timestamp,
            data.name,
            'weixin',
            data.is_group,
          );
          res.writeHead(200);
          res.end('ok');
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
      } catch (err) {
        console.error('weixin channel error:', err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      }
    });
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.listen(3002, '0.0.0.0', resolve),
    );
    this.connected = true;
    console.log('weixin channel listening on port 3002');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const body = JSON.stringify({
      to_user_id: jid,
      text,
    });
    const result = await httpPost(this.bridgeURL, body, {
      Authorization: `Bearer ${this.bridgeSecret}`,
    });
    if (result.status !== 200) {
      throw new Error(
        `weixin bridge send failed: status=${result.status} body=${result.body}`,
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@im.wechat');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.server.close();
  }
}

registerChannel('weixin', (opts) => {
  // Read from .env file (written by entrypoint from NANOCLAW_CONFIG_CONTENT).
  // NanoClaw's readEnvFile deliberately does NOT populate process.env to prevent
  // secrets from leaking to agent child processes.
  const envConfig = readEnvFile([
    'NANOCLAW_WEIXIN_BRIDGE_URL',
    'NANOCLAW_BRIDGE_SECRET',
  ]);
  const bridgeURL = envConfig.NANOCLAW_WEIXIN_BRIDGE_URL;
  const bridgeSecret = envConfig.NANOCLAW_BRIDGE_SECRET;
  if (!bridgeURL || !bridgeSecret) return null;
  return new WeixinChannel(opts, bridgeURL, bridgeSecret);
});
