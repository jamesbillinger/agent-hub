// Simple MCP server implementation for Agent Hub
// Implements the Model Context Protocol over stdio

use once_cell::sync::Lazy;
use parking_lot::Mutex as ParkingMutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

const PROTOCOL_VERSION: &str = "2024-11-05";

// Global map for pending MCP requests that await results from JS
static PENDING_REQUESTS: Lazy<ParkingMutex<HashMap<String, oneshot::Sender<String>>>> =
    Lazy::new(|| ParkingMutex::new(HashMap::new()));

/// Called by the IPC command when JS sends back a result
pub fn resolve_mcp_request(request_id: String, result: String) {
    let mut pending = PENDING_REQUESTS.lock();
    if let Some(sender) = pending.remove(&request_id) {
        let _ = sender.send(result);
    }
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

impl JsonRpcResponse {
    fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Value, code: i32, message: String) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message,
                data: None,
            }),
        }
    }
}

/// MCP Server for controlling the Agent Hub app
pub struct McpServer {
    app_handle: Arc<Mutex<Option<AppHandle>>>,
}

impl McpServer {
    pub fn new() -> Self {
        Self {
            app_handle: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn set_app_handle(&self, handle: AppHandle) {
        let mut app_handle = self.app_handle.lock().await;
        *app_handle = Some(handle);
    }

    async fn get_window(&self) -> Result<WebviewWindow, String> {
        let handle = self.app_handle.lock().await;
        let handle = handle.as_ref().ok_or("App handle not initialized")?;
        handle.get_webview_window("main").ok_or("Main window not found".to_string())
    }

    /// Execute JS and get the result back via callback
    async fn eval_with_result(&self, js_code: &str, timeout_ms: u64) -> Result<String, String> {
        let window = self.get_window().await?;
        let request_id = Uuid::new_v4().to_string();

        // Create oneshot channel for the result
        let (tx, rx) = oneshot::channel();

        // Store the sender
        {
            let mut pending = PENDING_REQUESTS.lock();
            pending.insert(request_id.clone(), tx);
        }

        // Encode js_code as base64 to avoid any escaping issues
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, js_code);

        // Build the JS: decode base64, wrap in async function, execute, send result via callback
        // The code is wrapped in an async IIFE so return statements work properly
        let wrapped_js = [
            "(async () => {",
            "try {",
            &format!("const __mcpEncoded = '{}';", encoded),
            "const __mcpCode = atob(__mcpEncoded);",
            // Create async function from decoded code, then call it
            "const __mcpAsyncFn = new Function('return (async function() {' + __mcpCode + '})');",
            "const __mcpResult = await __mcpAsyncFn()();",
            "const __mcpStr = __mcpResult === undefined ? 'null' : (typeof __mcpResult === 'string' ? __mcpResult : JSON.stringify(__mcpResult));",
            &format!("window.__TAURI__.core.invoke('mcp_callback', {{ requestId: '{}', result: __mcpStr }});", request_id),
            "} catch (__mcpErr) {",
            &format!("window.__TAURI__.core.invoke('mcp_callback', {{ requestId: '{}', result: JSON.stringify({{ error: __mcpErr.message }}) }});", request_id),
            "}",
            "})();",
        ].join("\n");

        // Execute the JS
        window.eval(&wrapped_js).map_err(|e| format!("Failed to execute JS: {}", e))?;

        // Wait for result with timeout
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => Err("Channel closed".to_string()),
            Err(_) => {
                // Clean up pending request on timeout
                let mut pending = PENDING_REQUESTS.lock();
                pending.remove(&request_id);
                Err("Timeout waiting for result".to_string())
            }
        }
    }

    fn get_tools_list(&self) -> Value {
        json!([
            {
                "name": "take_screenshot",
                "description": "Get information about the current window state including page content",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            },
            {
                "name": "execute_js",
                "description": "Execute JavaScript code in the Agent Hub webview and return the result",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": "The JavaScript code to execute. Should return a value."
                        }
                    },
                    "required": ["code"]
                }
            },
            {
                "name": "get_ui_state",
                "description": "Get the current UI state including visible elements, buttons, inputs, and text content",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            },
            {
                "name": "click_element",
                "description": "Click on an element using a CSS selector",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "selector": {
                            "type": "string",
                            "description": "CSS selector for the element to click"
                        }
                    },
                    "required": ["selector"]
                }
            },
            {
                "name": "type_text",
                "description": "Type text into an input field",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "selector": {
                            "type": "string",
                            "description": "CSS selector for the input element"
                        },
                        "text": {
                            "type": "string",
                            "description": "Text to type"
                        }
                    },
                    "required": ["selector", "text"]
                }
            },
            {
                "name": "wait_for_element",
                "description": "Wait for an element to appear in the DOM",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "selector": {
                            "type": "string",
                            "description": "CSS selector to wait for"
                        },
                        "timeout_ms": {
                            "type": "integer",
                            "description": "Timeout in milliseconds (default 5000)"
                        }
                    },
                    "required": ["selector"]
                }
            },
            {
                "name": "get_text",
                "description": "Get text content from an element",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "selector": {
                            "type": "string",
                            "description": "CSS selector for the element"
                        }
                    },
                    "required": ["selector"]
                }
            },
            {
                "name": "list_elements",
                "description": "List all interactive elements on the page with their selectors",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        ])
    }

    async fn handle_request(&self, request: JsonRpcRequest) -> Option<JsonRpcResponse> {
        let id = match &request.id {
            Some(id) => id.clone(),
            None => return None, // Notification, no response needed
        };

        match request.method.as_str() {
            "initialize" => {
                Some(JsonRpcResponse::success(id, json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": "agent-hub",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                })))
            }
            "tools/list" => {
                Some(JsonRpcResponse::success(id, json!({
                    "tools": self.get_tools_list()
                })))
            }
            "tools/call" => {
                let tool_name = request.params.get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                let arguments = request.params.get("arguments")
                    .cloned()
                    .unwrap_or(json!({}));

                match self.call_tool(tool_name, arguments).await {
                    Ok(result) => Some(JsonRpcResponse::success(id, json!({
                        "content": [{"type": "text", "text": result}],
                        "isError": false
                    }))),
                    Err(e) => Some(JsonRpcResponse::success(id, json!({
                        "content": [{"type": "text", "text": e}],
                        "isError": true
                    }))),
                }
            }
            "ping" => {
                Some(JsonRpcResponse::success(id, json!({})))
            }
            _ => {
                // Unknown method - return method not found error
                Some(JsonRpcResponse::error(id, -32601, format!("Method not found: {}", request.method)))
            }
        }
    }

    async fn call_tool(&self, name: &str, args: Value) -> Result<String, String> {
        match name {
            "take_screenshot" => self.tool_take_screenshot().await,
            "execute_js" => {
                let code = args.get("code")
                    .and_then(|c| c.as_str())
                    .ok_or("Missing 'code' parameter")?;
                self.tool_execute_js(code).await
            }
            "get_ui_state" => self.tool_get_ui_state().await,
            "click_element" => {
                let selector = args.get("selector")
                    .and_then(|s| s.as_str())
                    .ok_or("Missing 'selector' parameter")?;
                self.tool_click_element(selector).await
            }
            "type_text" => {
                let selector = args.get("selector")
                    .and_then(|s| s.as_str())
                    .ok_or("Missing 'selector' parameter")?;
                let text = args.get("text")
                    .and_then(|t| t.as_str())
                    .ok_or("Missing 'text' parameter")?;
                self.tool_type_text(selector, text).await
            }
            "wait_for_element" => {
                let selector = args.get("selector")
                    .and_then(|s| s.as_str())
                    .ok_or("Missing 'selector' parameter")?;
                let timeout = args.get("timeout_ms")
                    .and_then(|t| t.as_i64())
                    .map(|t| t as u64)
                    .unwrap_or(5000);
                self.tool_wait_for_element(selector, timeout).await
            }
            "get_text" => {
                let selector = args.get("selector")
                    .and_then(|s| s.as_str())
                    .ok_or("Missing 'selector' parameter")?;
                self.tool_get_text(selector).await
            }
            "list_elements" => self.tool_list_elements().await,
            _ => Err(format!("Unknown tool: {}", name)),
        }
    }

    async fn tool_take_screenshot(&self) -> Result<String, String> {
        let js = r#"
            return {
                width: window.innerWidth,
                height: window.innerHeight,
                title: document.title,
                url: window.location.href,
                bodyText: document.body.innerText.substring(0, 8000)
            };
        "#;
        self.eval_with_result(js, 5000).await
    }

    async fn tool_execute_js(&self, code: &str) -> Result<String, String> {
        let trimmed = code.trim();
        // If code doesn't have a return statement, wrap as return expression
        let has_return = trimmed.contains("return ") ||
                         trimmed.contains("return;") ||
                         trimmed.ends_with("return");

        let js = if has_return {
            code.to_string()
        } else {
            // Wrap expression in return so we get the value
            format!("return ({});", code)
        };

        self.eval_with_result(&js, 10000).await
    }

    async fn tool_get_ui_state(&self) -> Result<String, String> {
        let js = r#"
            return {
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
            };
        "#;
        self.eval_with_result(js, 5000).await
    }

    async fn tool_click_element(&self, selector: &str) -> Result<String, String> {
        let escaped = selector.replace('\\', "\\\\").replace('\'', "\\'").replace('"', "\\\"");
        let js = format!(r#"
            const el = document.querySelector("{}");
            if (!el) {{
                return {{ success: false, error: 'Element not found: {}' }};
            }}
            el.click();
            return {{ success: true, clicked: '{}', tagName: el.tagName, text: (el.textContent || '').trim().substring(0, 50) }};
        "#, escaped, escaped, escaped);
        self.eval_with_result(&js, 5000).await
    }

    async fn tool_type_text(&self, selector: &str, text: &str) -> Result<String, String> {
        let escaped_sel = selector.replace('\\', "\\\\").replace('\'', "\\'").replace('"', "\\\"");
        let escaped_text = text.replace('\\', "\\\\").replace('\'', "\\'").replace('"', "\\\"").replace('\n', "\\n");
        let js = format!(r#"
            const el = document.querySelector("{}");
            if (!el) {{
                return {{ success: false, error: 'Element not found: {}' }};
            }}
            el.focus();
            el.value = "{}";
            el.dispatchEvent(new Event('input', {{ bubbles: true }}));
            el.dispatchEvent(new Event('change', {{ bubbles: true }}));
            return {{ success: true, selector: '{}', typedLength: {} }};
        "#, escaped_sel, escaped_sel, escaped_text, escaped_sel, text.len());
        self.eval_with_result(&js, 5000).await
    }

    async fn tool_wait_for_element(&self, selector: &str, timeout_ms: u64) -> Result<String, String> {
        let escaped = selector.replace('\\', "\\\\").replace('\'', "\\'").replace('"', "\\\"");
        let js = format!(r#"
            const start = Date.now();
            while (Date.now() - start < {}) {{
                const el = document.querySelector("{}");
                if (el) {{
                    return {{ success: true, found: true, selector: '{}', waitedMs: Date.now() - start }};
                }}
                await new Promise(r => setTimeout(r, 100));
            }}
            return {{ success: false, found: false, selector: '{}', error: 'Timeout after {}ms' }};
        "#, timeout_ms, escaped, escaped, escaped, timeout_ms);
        // Add extra time for the JS timeout plus overhead
        self.eval_with_result(&js, timeout_ms + 1000).await
    }

    async fn tool_get_text(&self, selector: &str) -> Result<String, String> {
        let escaped = selector.replace('\\', "\\\\").replace('\'', "\\'").replace('"', "\\\"");
        let js = format!(r#"
            const el = document.querySelector("{}");
            if (!el) {{
                return {{ success: false, error: 'Element not found: {}' }};
            }}
            const text = (el.textContent || el.innerText || '').trim();
            return {{ success: true, selector: '{}', text: text.substring(0, 5000), length: text.length }};
        "#, escaped, escaped, escaped);
        self.eval_with_result(&js, 5000).await
    }

    async fn tool_list_elements(&self) -> Result<String, String> {
        let js = r#"
            const elements = [];

            // Buttons
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

            // Inputs and textareas
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

            // Select dropdowns
            document.querySelectorAll('select').forEach((el, i) => {
                elements.push({
                    type: 'select',
                    index: i,
                    selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : 'select:nth-of-type(' + (i+1) + ')'),
                    options: Array.from(el.options).map(o => o.text).slice(0, 10)
                });
            });

            // Clickable divs/spans with onclick or role=button
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
        "#;
        self.eval_with_result(js, 5000).await
    }

    pub async fn run(&self) {
        let stdin = io::stdin();
        let mut stdout = io::stdout();

        for line in stdin.lock().lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };

            if line.trim().is_empty() {
                continue;
            }

            let request: JsonRpcRequest = match serde_json::from_str(&line) {
                Ok(r) => r,
                Err(e) => {
                    let error_response = JsonRpcResponse::error(
                        Value::Null,
                        -32700,
                        format!("Parse error: {}", e),
                    );
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&error_response).unwrap());
                    let _ = stdout.flush();
                    continue;
                }
            };

            if let Some(response) = self.handle_request(request).await {
                let response_str = serde_json::to_string(&response).unwrap();
                let _ = writeln!(stdout, "{}", response_str);
                let _ = stdout.flush();
            }
        }
    }
}

/// Start the MCP server on stdio
pub async fn start_mcp_server(app_handle: AppHandle) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let server = McpServer::new();
    server.set_app_handle(app_handle).await;
    server.run().await;
    Ok(())
}
