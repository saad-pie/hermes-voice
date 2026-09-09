import http from 'http';
import fs from 'fs';
import path from 'path';
import WebSocket, { WebSocketServer } from 'ws';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const HERMES_PAT = process.env.HERMES_PAT || process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || 'saad-pie/Hermes-agent';

const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
const GITHUB_DISPATCH_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/dispatches`;

const HERMES_TOOL_DECLARATION = {
  function_declarations: [
    {
      name: "trigger_hermes_agent",
      description: "Trigger this ONLY when the user asks to perform an action, run code, execute shell scripts, browse the web, or modify files.",
      parameters: {
        type: "OBJECT",
        properties: {
          task_description: {
            type: "STRING",
            description: "The exact objective or instructions for the background agent to execute."
          },
          target_layer: {
            type: "STRING",
            description: "Optional layer: 'claude' (GUI/browser), 'chatgpt' (research/docs), 'background' (CLI/code)."
          }
        },
        required: ["task_description"]
      }
    }
  ]
};

async function dispatchGitHubWorkflow(taskDescription, targetLayer = "background") {
  if (!HERMES_PAT) {
    console.error("[Hermes Dispatcher] Error: HERMES_PAT variable missing.");
    return false;
  }

  try {
    const response = await fetch(GITHUB_DISPATCH_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HERMES_PAT}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        event_type: "hermes_request",
        client_payload: {
          question: taskDescription,
          target_layer: targetLayer
        }
      })
    });

    return response.status === 204;
  } catch (err) {
    console.error("[Hermes Dispatcher] Error:", err.message);
    return false;
  }
}

// 1. Create a native HTTP server instance
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Serve static UI index page
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const filePath = path.join(process.cwd(), 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// 2. Attach WebSocket Server directly to the HTTP server
const wss = new WebSocketServer({ server });

wss.on('connection', (clientWs) => {
  console.log('[Gateway] Client connected via Vercel WebSocket');

  if (!GEMINI_API_KEY) {
    console.error('[Gateway] GEMINI_API_KEY is missing.');
    clientWs.close(4001, 'GEMINI_API_KEY missing');
    return;
  }

  const geminiWs = new WebSocket(GEMINI_WS_URL);

  geminiWs.on('open', () => {
    console.log('[Gateway] Connected to Gemini Live API');
    
    const setupMsg = {
      setup: {
        model: "models/gemini-2.0-flash-exp",
        generationConfig: {
          responseModalities: ["AUDIO", "TEXT"]
        },
        tools: [HERMES_TOOL_DECLARATION]
      }
    };
    geminiWs.send(JSON.stringify(setupMsg));
  });

  geminiWs.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: true });
      }
      return;
    }

    try {
      const parsed = JSON.parse(data.toString());
      
      if (parsed.toolCall) {
        const calls = parsed.toolCall.functionCalls || [];
        for (const fc of calls) {
          if (fc.name === 'trigger_hermes_agent') {
            const taskDesc = fc.args?.task_description || '';
            const layer = fc.args?.target_layer || 'background';
            
            console.log(`[Tool Call] Dispatching task: "${taskDesc}"`);
            dispatchGitHubWorkflow(taskDesc, layer);

            const toolAck = {
              toolResponse: {
                functionResponses: [
                  {
                    id: fc.id,
                    response: { output: { status: "Task dispatched successfully." } }
                  }
                ]
              }
            };
            geminiWs.send(JSON.stringify(toolAck));
          }
        }
      }

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data.toString());
      }
    } catch (err) {
      console.error('[Gateway] Parsing error:', err.message);
    }
  });

  clientWs.on('message', (message, isBinary) => {
    if (geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.send(message, { binary: isBinary });
    }
  });

  const cleanup = () => {
    if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  };

  clientWs.on('close', cleanup);
  geminiWs.on('close', cleanup);
  clientWs.on('error', cleanup);
  geminiWs.on('error', cleanup);
});

// 3. Export default HTTP server so Vercel hooks into it
export default server;
    
