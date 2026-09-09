import { fileURLToPath } from 'url';
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

// Vercel Serverless Function Handler
export default async function handler(req, res) {
  if (req.method === 'GET' && req.url === '/api/health') {
    return res.status(200).json({ status: "Hermes Gateway Active" });
  }

  res.status(405).json({ error: "Method not allowed. Use WebSocket connection at /ws/live" });
}
