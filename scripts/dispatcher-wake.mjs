#!/usr/bin/env node
/**
 * @file dispatcher-wake.mjs
 * Headless event listener that streams SSE events from AgentMail (http://127.0.0.1:8766/api/mail/events).
 * When an agent completes work (type: 'ready-for-review', 'task-complete', or 'gate-failure'),
 * this script triggers dispatcher wakeup or spawns the assigned Review Diamond reviewer.
 */

import http from 'node:http';

const PORT = process.env.PORT || 8766;
const HOST = process.env.HOST || '127.0.0.1';

console.log(`[dispatcher-wake] Connecting to AgentMail event stream at http://${HOST}:${PORT}/api/mail/events...`);

function connect() {
  const req = http.request(
    {
      hostname: HOST,
      port: PORT,
      path: '/api/mail/events',
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache'
      }
    },
    (res) => {
      if (res.statusCode !== 200) {
        console.error(`[dispatcher-wake] Failed to connect: HTTP ${res.statusCode}. Retrying in 5s...`);
        setTimeout(connect, 5000);
        return;
      }

      console.log(`[dispatcher-wake] Connected. Listening for agent handoffs...`);

      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep partial line

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const rawData = line.slice(6).trim();
            try {
              const event = JSON.parse(rawData);
              handleEvent(event);
            } catch (err) {
              // ignore ping or non-json keepalive
            }
          }
        }
      });

      res.on('end', () => {
        console.warn(`[dispatcher-wake] Connection closed by server. Reconnecting in 3s...`);
        setTimeout(connect, 3000);
      });
    }
  );

  req.on('error', (err) => {
    console.error(`[dispatcher-wake] Connection error: ${err.message}. Retrying in 5s...`);
    setTimeout(connect, 5000);
  });

  req.end();
}

function handleEvent(event) {
  if (event.type === 'connected') {
    console.log(`[dispatcher-wake] Stream handshake verified (unread: ${event.unreadCount})`);
    return;
  }

  if (event.type === 'new_mail') {
    const mail = event.mail;
    console.log(`\n======================================================`);
    console.log(`📬 INCOMING AGENTMAIL: [${mail.type || 'message'}]`);
    console.log(`From:    ${mail.from} -> To: ${mail.to}`);
    console.log(`Subject: ${mail.subject}`);
    if (mail.branch) console.log(`Branch:  ${mail.branch}`);
    if (mail.worktree) console.log(`Worktree: ${mail.worktree}`);
    console.log(`======================================================\n`);

    if (mail.type === 'ready-for-review') {
      console.log(`⚡ WAKING DISPATCHER: Work ready for Review Diamond on branch [${mail.branch}]`);
      console.log(`Recommended next action: dispatch reviewer node to verify claims and negative controls.`);
    } else if (mail.type === 'gate-failure') {
      console.log(`🚨 GATE FAILURE ALERT: Iterative loopback to author triggered.`);
    }
  }
}

connect();
