const http = require('node:http');

function getPort() {
  const index = process.argv.indexOf('--port');
  const value = index >= 0 ? process.argv[index + 1] : process.env.PORT;
  const port = Number(value || 3003);
  return Number.isFinite(port) && port > 0 ? port : 3003;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        request.destroy();
        reject(new Error('request body too large'));
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function chooseReply(messages) {
  const content = messages
    .map((message) => String(message?.content || ''))
    .join('\n')
    .toLowerCase();

  if (content.includes('single word pong')) return 'pong';
  if (content.includes('apipool smoke ok')) return 'APIPool smoke OK';
  return 'APIPool mock upstream OK';
}

const port = getPort();

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/models') {
    sendJson(response, 200, {
      object: 'list',
      data: [
        {
          id: 'gpt-4o-mini',
          object: 'model',
          created: 1626777600,
          owned_by: 'apipool-mock',
        },
      ],
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body;
    try {
      body = JSON.parse(await readBody(request));
    } catch {
      sendJson(response, 400, {
        error: {
          message: 'invalid JSON request body',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    const model = String(body.model || 'gpt-4o-mini');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const content = chooseReply(messages);

    sendJson(response, 200, {
      id: `chatcmpl-mock-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 8,
        completion_tokens: Math.max(1, content.split(/\s+/).length),
        total_tokens: 8 + Math.max(1, content.split(/\s+/).length),
      },
    });
    return;
  }

  sendJson(response, 404, {
    error: {
      message: 'not found',
      type: 'not_found_error',
    },
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`mock-openai-upstream listening on http://127.0.0.1:${port}`);
});
