#!/usr/bin/env node
// MCP Bridge for Agent Hub
// This lightweight script bridges MCP (stdio JSON-RPC) to the Agent Hub HTTP API
// Run the app separately with `npx tauri dev`, then use this as the MCP server

const http = require('http');
const readline = require('readline');

const AGENT_HUB_PORT = process.env.AGENT_HUB_PORT || 3857;
const PROTOCOL_VERSION = '2024-11-05';

// Tool definitions
const TOOLS = [
  {
    name: 'take_screenshot',
    description: 'Get information about the current window state including page content',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'execute_js',
    description: 'Execute JavaScript code in the Agent Hub webview and return the result',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The JavaScript code to execute. Should return a value.' }
      },
      required: ['code']
    }
  },
  {
    name: 'get_ui_state',
    description: 'Get the current UI state including visible elements, buttons, inputs, and text content',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'click_element',
    description: 'Click on an element using a CSS selector',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the element to click' }
      },
      required: ['selector']
    }
  },
  {
    name: 'type_text',
    description: 'Type text into an input field',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the input element' },
        text: { type: 'string', description: 'Text to type' }
      },
      required: ['selector', 'text']
    }
  },
  {
    name: 'wait_for_element',
    description: 'Wait for an element to appear in the DOM',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 5000)' }
      },
      required: ['selector']
    }
  },
  {
    name: 'get_text',
    description: 'Get text content from an element',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the element' }
      },
      required: ['selector']
    }
  },
  {
    name: 'list_elements',
    description: 'List all interactive elements on the page with their selectors',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
];

// Execute JS via HTTP API
function executeJs(code, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ code, timeout_ms: timeoutMs });

    const req = http.request({
      hostname: 'localhost',
      port: AGENT_HUB_PORT,
      path: '/api/mcp/execute',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: timeoutMs + 1000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.success) {
            resolve(parsed.result);
          } else {
            reject(new Error(parsed.error || parsed.message || 'Unknown error'));
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(data);
    req.end();
  });
}

// Tool implementations
const toolHandlers = {
  async take_screenshot() {
    // Use parentheses to make object literal an expression
    const js = `({
      width: window.innerWidth,
      height: window.innerHeight,
      title: document.title,
      url: window.location.href,
      bodyText: document.body.innerText.substring(0, 8000)
    })`;
    return executeJs(js);
  },

  async execute_js({ code }) {
    // Wrap in IIFE without return - eval returns the result of the expression
    const js = `(function() { ${code} })()`;
    return executeJs(js, 10000);
  },

  async get_ui_state() {
    // Use parentheses to make object literal an expression
    const js = `({
      title: document.title,
      url: window.location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      buttons: Array.from(document.querySelectorAll('button')).slice(0, 50).map((b, i) => ({
        index: i,
        text: (b.textContent || '').trim().substring(0, 100),
        id: b.id || null,
        className: (b.className || '').substring(0, 100),
        disabled: b.disabled,
        selector: b.id ? '#' + b.id : (b.className ? 'button.' + b.className.split(' ')[0] : 'button:nth-of-type(' + (i+1) + ')')
      })),
      inputs: Array.from(document.querySelectorAll('input, textarea')).slice(0, 30).map((i, idx) => ({
        index: idx,
        type: i.type || i.tagName.toLowerCase(),
        id: i.id || null,
        name: i.name || null,
        placeholder: (i.placeholder || '').substring(0, 100),
        value: (i.value || '').substring(0, 100),
        selector: i.id ? '#' + i.id : (i.name ? '[name="' + i.name + '"]' : 'input:nth-of-type(' + (idx+1) + ')')
      })),
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 20).map(a => ({
        text: (a.textContent || '').trim().substring(0, 50),
        href: a.href
      })),
      text: document.body.innerText.substring(0, 5000)
    })`;
    return executeJs(js);
  },

  async click_element({ selector }) {
    const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    // Wrap in IIFE - return inside IIFE is valid
    const js = `(function() {
      const el = document.querySelector("${escaped}");
      if (!el) {
        return { success: false, error: 'Element not found: ${escaped}' };
      }
      el.click();
      return { success: true, clicked: '${escaped}', tagName: el.tagName, text: (el.textContent || '').trim().substring(0, 50) };
    })()`;
    return executeJs(js);
  },

  async type_text({ selector, text }) {
    const escapedSel = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    const escapedText = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
    // Wrap in IIFE - return inside IIFE is valid
    const js = `(function() {
      const el = document.querySelector("${escapedSel}");
      if (!el) {
        return { success: false, error: 'Element not found: ${escapedSel}' };
      }
      el.focus();
      el.value = "${escapedText}";
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, selector: '${escapedSel}', typedLength: ${text.length} };
    })()`;
    return executeJs(js);
  },

  async wait_for_element({ selector, timeout_ms = 5000 }) {
    const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    // Wrap in async IIFE for await support
    const js = `(async function() {
      const start = Date.now();
      while (Date.now() - start < ${timeout_ms}) {
        const el = document.querySelector("${escaped}");
        if (el) {
          return { success: true, found: true, selector: '${escaped}', waitedMs: Date.now() - start };
        }
        await new Promise(r => setTimeout(r, 100));
      }
      return { success: false, found: false, selector: '${escaped}', error: 'Timeout after ${timeout_ms}ms' };
    })()`;
    return executeJs(js, timeout_ms + 1000);
  },

  async get_text({ selector }) {
    const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    // Wrap in IIFE - return inside IIFE is valid
    const js = `(function() {
      const el = document.querySelector("${escaped}");
      if (!el) {
        return { success: false, error: 'Element not found: ${escaped}' };
      }
      const text = (el.textContent || el.innerText || '').trim();
      return { success: true, selector: '${escaped}', text: text.substring(0, 5000), length: text.length };
    })()`;
    return executeJs(js);
  },

  async list_elements() {
    // Wrap in IIFE - return inside IIFE is valid
    const js = `(function() {
      const elements = [];
      document.querySelectorAll('button').forEach((el, i) => {
        const text = (el.textContent || '').trim().substring(0, 50);
        elements.push({
          type: 'button',
          index: i,
          selector: el.id ? '#' + el.id : 'button:nth-of-type(' + (i+1) + ')',
          text: text,
          disabled: el.disabled
        });
      });
      document.querySelectorAll('input, textarea').forEach((el, i) => {
        elements.push({
          type: el.tagName.toLowerCase(),
          inputType: el.type || null,
          index: i,
          selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : (el.tagName.toLowerCase() + ':nth-of-type(' + (i+1) + ')')),
          placeholder: (el.placeholder || '').substring(0, 50),
          value: (el.value || '').substring(0, 30)
        });
      });
      document.querySelectorAll('select').forEach((el, i) => {
        elements.push({
          type: 'select',
          index: i,
          selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : 'select:nth-of-type(' + (i+1) + ')'),
          options: Array.from(el.options).map(o => o.text).slice(0, 10)
        });
      });
      document.querySelectorAll('[onclick], [role="button"]').forEach((el, i) => {
        if (el.tagName !== 'BUTTON') {
          elements.push({
            type: 'clickable',
            tagName: el.tagName.toLowerCase(),
            selector: el.id ? '#' + el.id : '[role="button"]:nth-of-type(' + (i+1) + ')',
            text: (el.textContent || '').trim().substring(0, 50)
          });
        }
      });
      return { elements: elements, count: elements.length };
    })()`;
    return executeJs(js);
  }
};

// Handle MCP requests
async function handleRequest(request) {
  const { id, method, params } = request;

  if (id === undefined) {
    // Notification, no response needed
    return null;
  }

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'agent-hub-bridge', version: '1.0.0' }
          }
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: TOOLS }
        };

      case 'tools/call': {
        const toolName = params?.name;
        const args = params?.arguments || {};
        const handler = toolHandlers[toolName];

        if (!handler) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
              isError: true
            }
          };
        }

        try {
          const result = await handler(args);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
              isError: false
            }
          };
        } catch (e) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Error: ${e.message}` }],
              isError: true
            }
          };
        }
      }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        };
    }
  } catch (e) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: `Internal error: ${e.message}` }
    };
  }
}

// Main loop - read from stdin, write to stdout
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

let pendingRequests = 0;
let stdinClosed = false;

function checkExit() {
  if (stdinClosed && pendingRequests === 0) {
    process.exit(0);
  }
}

rl.on('line', async (line) => {
  if (!line.trim()) return;

  pendingRequests++;
  try {
    const request = JSON.parse(line);
    const response = await handleRequest(request);
    if (response) {
      console.log(JSON.stringify(response));
    }
  } catch (e) {
    console.log(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: `Parse error: ${e.message}` }
    }));
  } finally {
    pendingRequests--;
    checkExit();
  }
});

rl.on('close', () => {
  stdinClosed = true;
  checkExit();
});
