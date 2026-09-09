import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket, { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8000;
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
    console.error("[Hermes Dispatcher] Error: HERMES_PAT/GITHUB_TOKEN environment variable not set.");
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

    console.log(`[Hermes Dispatcher] GitHub Trigger Response: ${response.status}`);
    return response.status === 204;
  } catch (err) {
    console.error("[Hermes Dispatcher] Error sending dispatch request:", err.message);
    return false;
  }
}

// HTTP Server serving the UI
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
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

// WebSocket Server for Voice Gateway
const wss = new WebSocketServer({ server, path: '/ws/live' });

wss.on('connection', async (clientWs) => {
  console.log('[Gateway] Client connected');

  if (!GEMINI_API_KEY) {
    console.error('[Gateway] GEMINI_API_KEY is missing.');
    clientWs.close(4001, 'GEMINI_API_KEY missing');
    return;
  }

  const geminiWs = new WebSocket(GEMINI_WS_URL);

  geminiWs.on('open', () => {
    console.log('[Gateway] Connected to Gemini Live API');
    
    // Send Setup Message
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
            
            console.log(`[Tool Call Detected] Dispatched task: "${taskDesc}"`);
            
            dispatchGitHubWorkflow(taskDesc, layer);

            // Acknowledge Tool Execution back to Gemini
            const toolAck = {
              toolResponse: {
                functionResponses: [
                  {
                    id: fc.id,
                    response: {
                      output: { status: "Task dispatched successfully to GitHub Actions Hermes Worker." }
                    }
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
      console.error('[Gateway] Error parsing Gemini message:', err.message);
    }
  });

  clientWs.on('message', (message, isBinary) => {
    if (geminiWs.readyState === WebSocket.OPEN) {
      if (isBinary) {
        geminiWs.send(message, { binary: true });
      } else {
        geminiWs.send(message.toString());
      }
    }
  });

  clientWs.on('close', () => {
    console.log('[Gateway] Client disconnected');
    if (geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  });

  geminiWs.on('close', () => {
    console.log('[Gateway] Gemini socket closed');
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close();
    }
  });

  geminiWs.on('error', (err) => {
    console.error('[Gateway] Gemini WS Error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`Hermes JS Voice Gateway running at http://localhost:${PORT}`);
});
