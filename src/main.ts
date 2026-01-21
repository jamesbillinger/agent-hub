import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalPosition, LogicalSize, type Theme } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { marked } from "marked";
import "@xterm/xterm/css/xterm.css";

// Configure marked for safe rendering
marked.setOptions({
  breaks: true, // Convert \n to <br>
  gfm: true,    // GitHub Flavored Markdown
});

// Types
interface Session {
  id: string;
  name: string;
  agentType: "claude" | "claude-json" | "codex" | "aider" | "shell" | "custom";
  command: string;
  workingDir: string;
  createdAt: Date;
  isRunning: boolean;
  claudeSessionId?: string;
  hasBeenStarted?: boolean; // Tracks if this session has been started at least once
  terminal?: Terminal;
  fitAddon?: FitAddon;
  serializeAddon?: SerializeAddon;
  webglAddon?: WebglAddon;
  sortOrder: number;
  outputByteCount?: number; // Track bytes for periodic texture atlas clearing
}

interface SessionData {
  id: string;
  name: string;
  agent_type: string;
  command: string;
  working_dir: string;
  created_at: string;
  claude_session_id: string | null;
  sort_order: number;
}

type SortOption = "custom" | "name" | "date" | "agent";

interface PtyOutput {
  session_id: string;
  data: string;
}

// JSON streaming message types from Claude
interface ClaudeJsonMessage {
  type: "system" | "user" | "assistant" | "result";
  subtype?: "init" | "success" | "error" | "resumed" | "stopped";
  session_id?: string;
  message?: {
    id: string;
    type: string;
    role: string;
    content: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
    stop_reason?: string | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  // Init message fields
  cwd?: string;
  tools?: string[];
  model?: string;
  claude_code_version?: string;
  permissionMode?: string;
  // Result message fields
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// Pending image attachment
interface PendingImage {
  mediaType: string;
  base64Data: string;
  previewEl?: HTMLElement;
}

// Pending pasted text block
interface PastedTextBlock {
  id: number;
  text: string;
  lineCount: number;
}

// Chat UI state for JSON sessions
interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

interface ChatSession {
  messagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  statusEl: HTMLElement;
  containerEl: HTMLElement;
  attachmentsEl: HTMLElement; // Preview area for pending images
  todosEl: HTMLElement; // Todo panel for TodoWrite tracking
  messages: ClaudeJsonMessage[];
  todos: TodoItem[]; // Current todo list state
  isProcessing: boolean;
  inputBuffer: string; // Buffer for partial JSON lines
  pendingImages: PendingImage[]; // Images waiting to be sent
  pastedTextBlocks: PastedTextBlock[]; // Pasted text blocks (like CC)
  pasteBlockCounter: number; // Counter for paste block IDs
  cwd: string; // Working directory from init message
  // Streaming stats
  toolUseCount: number;
  streamingTokens: number;
  startTime: number | null;
}

interface WindowState {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  sidebar_width?: number;
}

interface AppSettings {
  font_size: number;
  font_family: string;
  theme: string;
  default_working_dir: string;
  default_agent_type: string;
  notifications_enabled: boolean;
  bell_notifications_enabled: boolean;
  bounce_dock_on_bell: boolean;
  read_aloud_enabled: boolean;
  renderer: "webgl" | "dom";
  remote_pin?: string | null;
}

// Recently closed session for undo functionality
interface RecentlyClosedSession {
  id: string;
  name: string;
  agentType: "claude" | "claude-json" | "codex" | "aider" | "shell" | "custom";
  command: string;
  workingDir: string;
  claudeSessionId?: string;
  closedAt: Date;
}

// State
const sessions: Map<string, Session> = new Map();
const chatSessions: Map<string, ChatSession> = new Map();
let activeSessionId: string | null = null;
let searchQuery = "";
let currentSort: SortOption = "custom";
let draggedSessionId: string | null = null;
let isDragging = false;
let dragStartY = 0;
let appSettings: AppSettings = {
  font_size: 13,
  font_family: "Menlo, Monaco, 'Courier New', monospace",
  theme: "system",
  default_working_dir: "~/dev/pplsi",
  default_agent_type: "claude",
  notifications_enabled: false,
  bell_notifications_enabled: true,
  bounce_dock_on_bell: true,
  read_aloud_enabled: false,
  renderer: "webgl",
};
let sidebarResizeHandle: HTMLElement;
let sidebarEl: HTMLElement;
let isResizingSidebar = false;

// Mobile state
type MobileView = "list" | "session";
let currentMobileView: MobileView = "list";
let isMobileLayout = false;

// Recently closed sessions (for undo close) - loaded from database
let recentlyClosed: RecentlyClosedSession[] = [];

// Agent commands
const AGENT_COMMANDS: Record<string, string> = {
  claude: "claude --dangerously-skip-permissions",
  "claude-json": "claude --print --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions",
  codex: "codex --full-auto",
  aider: "aider",
  shell: "$SHELL",
  custom: "",
};

// Default working directory
const DEFAULT_WORKING_DIR = "~/dev/pplsi";

// Read-aloud state (per session)
interface ReadAloudState {
  textBuffer: string;
  lastOutputTime: number;
  silenceTimer: number | null;
  isSpeaking: boolean;
}
const readAloudState: Map<string, ReadAloudState> = new Map();

// Activity tracking (per session) - tracks if session is actively outputting
interface ActivityState {
  lastOutputTime: number;
  lastInputTime: number;  // Track input to filter out echo
  isActive: boolean;
}
const activityState: Map<string, ActivityState> = new Map();

// Silence threshold for read-aloud (ms) - wait this long after output stops before speaking
const READ_ALOUD_SILENCE_THRESHOLD = 1500;

// Track sessions with detected errors (to avoid repeated notifications)
const sessionErrorsDetected: Set<string> = new Set();

// Activity threshold (ms) - consider session "active" if output within this window
const ACTIVITY_THRESHOLD = 1000;

// Echo filter (ms) - ignore output that comes shortly after input (likely echo)
const ECHO_FILTER_MS = 150;

/**
 * Strip ANSI escape codes from text for TTS.
 */
function stripAnsi(text: string): string {
  // Remove ANSI escape sequences
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    // Remove other control characters
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    // Normalize whitespace
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/**
 * Speak text using Web Speech API.
 */
function speakText(text: string): void {
  if (!text.trim()) return;

  // Cancel any ongoing speech
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  speechSynthesis.speak(utterance);
}

/**
 * Process new output for read-aloud functionality.
 */
function processReadAloudOutput(sessionId: string, rawData: string): void {
  if (!appSettings.read_aloud_enabled) return;

  let state = readAloudState.get(sessionId);
  if (!state) {
    state = {
      textBuffer: "",
      lastOutputTime: 0,
      silenceTimer: null,
      isSpeaking: false,
    };
    readAloudState.set(sessionId, state);
  }

  // Strip ANSI codes and add to buffer
  const cleanText = stripAnsi(rawData);
  state.textBuffer += cleanText;
  state.lastOutputTime = Date.now();

  // Clear existing silence timer
  if (state.silenceTimer) {
    clearTimeout(state.silenceTimer);
  }

  // Set new silence timer - when silence is detected, speak the buffer
  state.silenceTimer = window.setTimeout(() => {
    if (state && state.textBuffer.trim()) {
      speakText(state.textBuffer.trim());
      state.textBuffer = "";
    }
  }, READ_ALOUD_SILENCE_THRESHOLD);
}

/**
 * Update activity state for a session (called on output).
 */
function updateActivityState(sessionId: string): void {
  let state = activityState.get(sessionId);
  if (!state) {
    state = { lastOutputTime: 0, lastInputTime: 0, isActive: false };
    activityState.set(sessionId, state);
  }

  const now = Date.now();

  // Filter out echo: if output comes shortly after input, it's likely echo
  if (now - state.lastInputTime < ECHO_FILTER_MS) {
    return; // Ignore this output, it's probably echo
  }

  const wasActive = state.isActive;
  state.lastOutputTime = now;
  state.isActive = true;

  // Update UI if state changed
  if (!wasActive) {
    updateSessionActivityIndicator(sessionId, true);
  }

  // Schedule activity check
  setTimeout(() => {
    const currentState = activityState.get(sessionId);
    if (currentState && Date.now() - currentState.lastOutputTime >= ACTIVITY_THRESHOLD) {
      currentState.isActive = false;
      updateSessionActivityIndicator(sessionId, false);
    }
  }, ACTIVITY_THRESHOLD + 50);
}

/**
 * Record that input was sent to a session (for echo filtering).
 */
function recordSessionInput(sessionId: string): void {
  let state = activityState.get(sessionId);
  if (!state) {
    state = { lastOutputTime: 0, lastInputTime: 0, isActive: false };
    activityState.set(sessionId, state);
  }
  state.lastInputTime = Date.now();
}

/**
 * Update the activity indicator in the session list.
 */
function updateSessionActivityIndicator(sessionId: string, isActive: boolean): void {
  const sessionItem = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (sessionItem) {
    if (isActive) {
      sessionItem.classList.add("session-active");
    } else {
      sessionItem.classList.remove("session-active");
    }
  }
}

// Buffer for accumulating output to detect multi-line error messages
const errorDetectionBuffer: Map<string, string> = new Map();

/**
 * Detect Claude session errors like "No conversation found".
 * This can happen when:
 * - The session was created but never used
 * - Claude Code internally reset/moved the session
 * - The session data was cleaned up
 *
 * When detected, automatically reset and restart with a fresh session.
 */
function detectClaudeSessionError(sessionId: string, data: string): void {
  const session = sessions.get(sessionId);
  if (!session || session.agentType !== "claude") return;

  // Accumulate output for error detection (keep last 500 chars)
  const currentBuffer = errorDetectionBuffer.get(sessionId) || "";
  const newBuffer = (currentBuffer + data).slice(-500);
  errorDetectionBuffer.set(sessionId, newBuffer);

  // Check for the specific error message
  if (newBuffer.includes("No conversation found with session ID:") && !sessionErrorsDetected.has(sessionId)) {
    sessionErrorsDetected.add(sessionId);

    // Show brief message and auto-recover
    session.terminal?.write("\r\n\x1b[33m[Session not found - starting fresh...]\x1b[0m\r\n");

    // Auto-recover: reset session ID and restart
    autoRecoverClaudeSession(sessionId);
  }
}

/**
 * Automatically recover from a Claude session error by resetting and restarting.
 */
async function autoRecoverClaudeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session || session.agentType !== "claude") return;

  // Generate new Claude session ID
  session.claudeSessionId = crypto.randomUUID();
  session.hasBeenStarted = false;

  // Clear error detection state
  sessionErrorsDetected.delete(sessionId);
  errorDetectionBuffer.delete(sessionId);

  // Save to database
  await saveSessionToDb(session);

  // Wait a moment for the failed process to exit, then restart
  setTimeout(async () => {
    // Only restart if the session is no longer running (process exited)
    if (!session.isRunning) {
      session.terminal?.write("\x1b[32m[Restarting with new session...]\x1b[0m\r\n\r\n");
      await startSessionProcess(session);
    }
  }, 500);
}

/**
 * Reset a Claude session ID to start fresh.
 */
async function resetClaudeSessionId(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session || session.agentType !== "claude") return;

  // Generate new Claude session ID
  session.claudeSessionId = crypto.randomUUID();
  session.hasBeenStarted = false;

  // Clear error detection state
  sessionErrorsDetected.delete(sessionId);
  errorDetectionBuffer.delete(sessionId);

  // Save to database
  await saveSessionToDb(session);

  // Show message
  session.terminal?.write("\r\n\x1b[32m[Session ID reset - ready to start fresh]\x1b[0m\r\n");
}

/**
 * Calculate PTY dimensions with a buffer zone.
 * WKWebView has rendering bugs when escape sequences target exact terminal edges.
 * Testing with Safari showed it's primarily a WIDTH issue - output formatted for
 * wider terminals causes artifacts, narrower is fine.
 */
function getPtyDimensions(terminalCols: number, terminalRows: number): { cols: number; rows: number } {
  return {
    cols: Math.max(40, terminalCols - 2),
    rows: terminalRows,  // No row reduction needed - it's a width issue
  };
}

// DOM Elements
let sessionListEl: HTMLElement;
let terminalContainerEl: HTMLElement;
let chatContainerEl: HTMLElement;
let emptyStateEl: HTMLElement;
let newSessionModal: HTMLElement;
let sessionNameInput: HTMLInputElement;
let agentTypeSelect: HTMLSelectElement;
let customCommandInput: HTMLInputElement;
let customCommandGroup: HTMLElement;
let workingDirInput: HTMLInputElement;
let sessionSearchInput: HTMLInputElement;
let sortSelect: HTMLSelectElement;
let settingsModal: HTMLElement;
let aboutModal: HTMLElement;
let settingsFontSizeInput: HTMLInputElement;
let settingsFontFamilySelect: HTMLSelectElement;
let settingsThemeSelect: HTMLSelectElement;
let settingsDefaultWorkingDirInput: HTMLInputElement;
let settingsDefaultAgentSelect: HTMLSelectElement;
let settingsNotificationsCheckbox: HTMLInputElement;
let settingsBellNotificationsCheckbox: HTMLInputElement;
let settingsBounceDockCheckbox: HTMLInputElement;
let settingsReadAloudCheckbox: HTMLInputElement;
let settingsRendererSelect: HTMLSelectElement;
let settingsRemotePinInput: HTMLInputElement;

// Initialize app
document.addEventListener("DOMContentLoaded", async () => {
  // Get DOM elements
  sessionListEl = document.getElementById("session-list")!;
  terminalContainerEl = document.getElementById("terminal-container")!;
  chatContainerEl = document.getElementById("chat-container")!;
  emptyStateEl = document.getElementById("empty-state")!;
  newSessionModal = document.getElementById("new-session-modal")!;
  sessionNameInput = document.getElementById("session-name") as HTMLInputElement;
  agentTypeSelect = document.getElementById("agent-type") as HTMLSelectElement;
  customCommandInput = document.getElementById("custom-command") as HTMLInputElement;
  customCommandGroup = document.getElementById("custom-command-group")!;
  workingDirInput = document.getElementById("working-dir") as HTMLInputElement;
  sessionSearchInput = document.getElementById("session-search") as HTMLInputElement;
  sortSelect = document.getElementById("sort-select") as HTMLSelectElement;
  sidebarEl = document.getElementById("sidebar")!;
  sidebarResizeHandle = document.getElementById("sidebar-resize-handle")!;
  settingsModal = document.getElementById("settings-modal")!;
  aboutModal = document.getElementById("about-modal")!;
  settingsFontSizeInput = document.getElementById("settings-font-size") as HTMLInputElement;
  settingsFontFamilySelect = document.getElementById("settings-font-family") as HTMLSelectElement;
  settingsThemeSelect = document.getElementById("settings-theme") as HTMLSelectElement;
  settingsDefaultWorkingDirInput = document.getElementById("settings-default-working-dir") as HTMLInputElement;
  settingsDefaultAgentSelect = document.getElementById("settings-default-agent") as HTMLSelectElement;
  settingsNotificationsCheckbox = document.getElementById("settings-notifications") as HTMLInputElement;
  settingsBellNotificationsCheckbox = document.getElementById("settings-bell-notifications") as HTMLInputElement;
  settingsBounceDockCheckbox = document.getElementById("settings-bounce-dock") as HTMLInputElement;
  settingsReadAloudCheckbox = document.getElementById("settings-read-aloud") as HTMLInputElement;
  settingsRendererSelect = document.getElementById("settings-renderer") as HTMLSelectElement;
  settingsRemotePinInput = document.getElementById("settings-remote-pin") as HTMLInputElement;

  // Load window state and app settings
  await loadWindowState();
  await loadAppSettings();

  // Set up sidebar resize
  setupSidebarResize();

  // Mobile layout initialization
  isMobileLayout = checkMobileLayout();
  window.addEventListener("resize", updateMobileLayout);
  initMobileMenuInfo();

  // Mobile header event listeners
  document.getElementById("mobile-back-btn")?.addEventListener("click", navigateBackToList);
  document.getElementById("mobile-menu-btn")?.addEventListener("click", toggleMobileMenu);
  document.getElementById("mobile-settings-btn")?.addEventListener("click", () => {
    hideMobileMenu();
    showSettingsModal();
  });
  document.getElementById("mobile-logout-btn")?.addEventListener("click", () => {
    hideMobileMenu();
    window.location.reload();
  });

  // Close mobile menu when clicking outside
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("mobile-user-menu");
    const menuBtn = document.getElementById("mobile-menu-btn");
    if (menu?.classList.contains("visible") &&
        !menu.contains(e.target as Node) &&
        !menuBtn?.contains(e.target as Node)) {
      hideMobileMenu();
    }
  });

  // Initial mobile view state
  if (isMobileLayout) {
    setMobileView("list");
  }

  // Set up search and sort event listeners
  sessionSearchInput.addEventListener("input", () => {
    searchQuery = sessionSearchInput.value.toLowerCase();
    renderSessionList();
  });

  sortSelect.addEventListener("change", () => {
    currentSort = sortSelect.value as SortOption;
    // Update session list class for drag handle visibility
    if (currentSort === "custom") {
      sessionListEl.classList.remove("session-list-sorted");
    } else {
      sessionListEl.classList.add("session-list-sorted");
    }
    renderSessionList();
  });

  // Set up event listeners - direct session creation
  document.getElementById("new-session-btn")!.addEventListener("click", createQuickSession);
  document.getElementById("empty-new-session-btn")!.addEventListener("click", createQuickSession);
  document.getElementById("modal-cancel")!.addEventListener("click", hideNewSessionModal);
  document.getElementById("modal-create")!.addEventListener("click", saveSessionFromModal);

  // Dropdown menu for creating sessions with different agents
  const dropdownBtn = document.getElementById("new-session-dropdown-btn")!;
  const dropdownMenu = document.getElementById("new-session-menu")!;

  dropdownBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdownMenu.classList.toggle("visible");
  });

  // Handle dropdown menu item clicks
  dropdownMenu.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      dropdownMenu.classList.remove("visible");
      const agentType = (btn as HTMLElement).dataset.agent as Session["agentType"];
      if (agentType === "custom") {
        // Show modal for custom command
        showNewSessionModal("custom");
      } else {
        // Quick create with selected agent
        await createQuickSessionWithAgent(agentType);
      }
    });
  });

  // Close dropdowns when clicking outside
  document.addEventListener("click", () => {
    dropdownMenu.classList.remove("visible");
  });

  // Enter key to save in session modal
  sessionNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveSessionFromModal();
    }
  });

  // Agent type change handler
  agentTypeSelect.addEventListener("change", () => {
    customCommandGroup.style.display = agentTypeSelect.value === "custom" ? "block" : "none";
  });

  // Close modal on backdrop click
  newSessionModal.addEventListener("click", (e) => {
    if (e.target === newSessionModal) hideNewSessionModal();
  });

  // Settings modal event listeners
  document.getElementById("settings-cancel")!.addEventListener("click", hideSettingsModal);
  document.getElementById("settings-save")!.addEventListener("click", saveSettings);
  document.getElementById("settings-check-update")!.addEventListener("click", checkForUpdates);
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) hideSettingsModal();
  });

  // About modal event listeners
  document.getElementById("about-close")!.addEventListener("click", hideAboutModal);
  aboutModal.addEventListener("click", (e) => {
    if (e.target === aboutModal) hideAboutModal();
  });

  // Diff modal event listeners
  const diffModal = document.getElementById("diff-modal")!;
  document.getElementById("diff-modal-close")!.addEventListener("click", hideDiffModal);
  diffModal.addEventListener("click", (e) => {
    if (e.target === diffModal) hideDiffModal();
  });

  // Event delegation for diff expand buttons (dynamically added)
  // Use chat-container since chat-messages elements are created dynamically per session
  document.getElementById("chat-container")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".diff-expand-btn") as HTMLButtonElement;
    if (btn) {
      const path = btn.dataset.path || "";
      const oldB64 = btn.dataset.old || "";
      const newB64 = btn.dataset.new || "";
      // Decode from base64
      const oldContent = decodeURIComponent(escape(atob(oldB64)));
      const newContent = decodeURIComponent(escape(atob(newB64)));
      showDiffModal(path, oldContent, newContent);
    }
  });

  // Claude sessions modal event listeners
  const claudeSessionsModalEl = document.getElementById("claude-sessions-modal")!;
  document.getElementById("claude-sessions-cancel")!.addEventListener("click", hideClaudeSessionsModal);
  claudeSessionsModalEl.addEventListener("click", (e) => {
    if (e.target === claudeSessionsModalEl) hideClaudeSessionsModal();
  });

  // Start session banner click handler
  document.getElementById("start-session-banner")!.addEventListener("click", async () => {
    if (activeSessionId) {
      const session = sessions.get(activeSessionId);
      if (session && !session.isRunning) {
        await startSessionProcess(session);
      }
    }
  });

  // Listen for menu events from Rust
  await listen<string>("menu-event", (event) => {
    handleMenuEvent(event.payload);
  });

  // Listen for PTY events
  // Batch terminal writes using requestAnimationFrame to avoid overwhelming WKWebView
  // This collects all output within a frame and writes it in one batch
  const pendingWrites: Map<string, string> = new Map();
  let writeFrameScheduled = false;

  const flushPendingWrites = () => {
    writeFrameScheduled = false;
    for (const [sessionId, data] of pendingWrites) {
      const session = sessions.get(sessionId);
      if (session?.terminal) {
        session.terminal.write(data);
      }
    }
    pendingWrites.clear();
  };

  await listen<PtyOutput>("pty-output", (event) => {
    const sessionId = event.payload.session_id;
    const data = event.payload.data;
    const currentData = pendingWrites.get(sessionId) || "";
    pendingWrites.set(sessionId, currentData + data);

    // Update activity state (for spinner indicator)
    updateActivityState(sessionId);

    // Process for read-aloud if enabled
    processReadAloudOutput(sessionId, data);

    // Detect Claude session errors
    detectClaudeSessionError(sessionId, data);

    if (!writeFrameScheduled) {
      writeFrameScheduled = true;
      requestAnimationFrame(flushPendingWrites);
    }
  });

  await listen<PtyOutput>("pty-exit", async (event) => {
    const session = sessions.get(event.payload.session_id);
    if (session) {
      session.isRunning = false;
      session.terminal?.write("\r\n\x1b[33m[Process exited]\x1b[0m\r\n");

      // Save terminal buffer when process exits
      await saveTerminalBuffer(session);

      renderSessionList();
      updateStartBanner();

      // Send notification if enabled and window is not focused
      if (appSettings.notifications_enabled) {
        try {
          const win = getCurrentWindow();
          const isFocused = await win.isFocused();
          if (!isFocused) {
            await showNotification(
              "Process Completed",
              `Session "${session.name}" has exited`
            );
          }
        } catch (err) {
          console.error("Failed to check focus or send notification:", err);
        }
      }
    }
  });

  // Listen for Claude session ID detection (for PTY/terminal sessions)
  // The backend scans ~/.claude/projects/ after starting Claude to find the actual session ID
  await listen<{ session_id: string; claude_session_id: string }>("claude-session-detected", async (event) => {
    const { session_id, claude_session_id } = event.payload;
    const session = sessions.get(session_id);
    if (session && session.agentType === "claude") {
      console.log(`[Claude Session Detected] session=${session_id}, claude_id=${claude_session_id}`);
      session.claudeSessionId = claude_session_id;
      session.hasBeenStarted = true;
      // DB is already updated by backend, but we keep the local state in sync
    }
  });

  // JSON process event listeners (for claude-json sessions)
  await listen<{ session_id: string; data: string }>("json-process-output", (event) => {
    const { session_id, data } = event.payload;
    processChatOutput(session_id, data);
  });

  await listen<{ session_id: string }>("json-process-started", (event) => {
    const session = sessions.get(event.payload.session_id);
    if (session) {
      session.isRunning = true;
      const chatSession = chatSessions.get(event.payload.session_id);
      if (chatSession) {
        chatSession.statusEl.textContent = "Connected";
        chatSession.statusEl.className = "chat-status connected";
      }
      renderSessionList();
      updateStartBanner();
    }
  });

  await listen<{ session_id: string; exit_code?: number }>("json-process-exit", async (event) => {
    const session = sessions.get(event.payload.session_id);
    if (session) {
      session.isRunning = false;
      const chatSession = chatSessions.get(event.payload.session_id);
      if (chatSession) {
        chatSession.statusEl.textContent = `Process exited (${event.payload.exit_code ?? "unknown"})`;
        chatSession.statusEl.className = "chat-status";
        chatSession.isProcessing = false;
        const thinkingEl = chatSession.containerEl.querySelector(".chat-thinking") as HTMLElement;
        if (thinkingEl) thinkingEl.style.display = "none";

        // Add session stopped event
        addSessionEvent(event.payload.session_id, "stopped");
      }
      renderSessionList();
      updateStartBanner();

      // Send notification if enabled and window is not focused
      if (appSettings.notifications_enabled) {
        try {
          const win = getCurrentWindow();
          const isFocused = await win.isFocused();
          if (!isFocused) {
            await showNotification(
              "Process Completed",
              `Chat session "${session.name}" has exited`
            );
          }
        } catch (err) {
          console.error("Failed to check focus or send notification:", err);
        }
      }
    }
  });

  await listen<{ session_id: string; error: string }>("json-process-error", (event) => {
    const chatSession = chatSessions.get(event.payload.session_id);
    if (chatSession) {
      chatSession.statusEl.textContent = `Error: ${event.payload.error}`;
      chatSession.statusEl.className = "chat-status error";
      addChatMessage(event.payload.session_id, {
        type: "system",
        subtype: "error",
        result: event.payload.error,
      });
    }
  });

  // Listen for remote client disconnect (restore desktop terminal size)
  await listen<string>("remote-client-disconnected", async (event) => {
    const sessionId = event.payload;
    const session = sessions.get(sessionId);
    if (session?.terminal && session.fitAddon) {
      // Re-fit terminal to desktop window size and notify PTY
      session.fitAddon.fit();
      const dims = session.fitAddon.proposeDimensions();
      if (dims) {
        const ptyDims = getPtyDimensions(dims.cols, dims.rows);
        await invoke("resize_pty", {
          sessionId,
          cols: ptyDims.cols,
          rows: ptyDims.rows,
        });
      }
    }
  });

  // Listen for remote session starts (from mobile web)
  await listen<string>("remote-session-started", async (event) => {
    const sessionId = event.payload;
    const session = sessions.get(sessionId);
    if (session) {
      // Session already exists in our map, just mark as running and switch to it
      session.isRunning = true;
      if (!session.terminal) {
        // Create terminal if it doesn't exist
        await initializeTerminalView(session);
      }
      switchToSession(sessionId);
      renderSessionList();

      // Send notification
      if (appSettings.notifications_enabled) {
        try {
          const win = getCurrentWindow();
          const isFocused = await win.isFocused();
          if (!isFocused) {
            await showNotification(
              "Remote Session Started",
              `Session "${session.name}" started from mobile`
            );
          }
        } catch (err) {
          console.error("Failed to send notification:", err);
        }
      }
    }
  });

  // Listen for remote session creation (from mobile web)
  await listen<{ session: { id: string; name: string; agent_type: string; working_dir: string } }>("remote-session-created", async (event) => {
    const { session: remoteSession } = event.payload;

    // Only add the new session if it doesn't already exist (to avoid overwriting terminal instances)
    if (!sessions.has(remoteSession.id)) {
      // Load sessions from database, but only add the new one to avoid overwriting existing sessions
      const savedSessions: SessionData[] = await invoke("load_sessions");
      const newSessionData = savedSessions.find(s => s.id === remoteSession.id);
      if (newSessionData) {
        const minSortOrder = Math.min(0, ...Array.from(sessions.values()).map(s => s.sortOrder));
        const claudeSessionId = newSessionData.agent_type === "claude" ? (newSessionData.claude_session_id || crypto.randomUUID()) : undefined;
        const session: Session = {
          id: newSessionData.id,
          name: newSessionData.name,
          agentType: newSessionData.agent_type as Session["agentType"],
          command: newSessionData.command,
          workingDir: newSessionData.working_dir,
          createdAt: new Date(newSessionData.created_at),
          isRunning: false,
          claudeSessionId,
          hasBeenStarted: false,
          sortOrder: newSessionData.sort_order || minSortOrder - 1,
        };
        sessions.set(session.id, session);
      }
    }
    renderSessionList();

    // Send notification
    if (appSettings.notifications_enabled) {
      try {
        const win = getCurrentWindow();
        const isFocused = await win.isFocused();
        if (!isFocused) {
          await showNotification(
            "Remote Session Created",
            `Session "${remoteSession.name}" created from mobile`
          );
        }
      } catch (err) {
        console.error("Failed to send notification:", err);
      }
    }
  });

  // Listen for pairing requests (show code to user for mobile authentication)
  await listen<{ code: string; device_name?: string }>("pairing-requested", async (event) => {
    const { code, device_name } = event.payload;

    // Show pairing modal with the code
    showPairingModal(code, device_name);

    // Also try to show a notification (in case app is in background)
    const deviceInfo = device_name ? ` from "${device_name}"` : "";
    await showNotification(
      "Device Pairing Request",
      `Enter code ${code}${deviceInfo} to pair this device`
    );

    console.log(`Pairing request: code=${code}, device=${device_name || "unknown"}`);
  });

  // Listen for successful pairing (hide modal)
  await listen("device-paired", () => {
    hidePairingModal();
  });

  // Listen for MCP execute requests from the HTTP API
  await listen<{ request_id: string; code: string }>("mcp-execute", async (event) => {
    const { request_id, code } = event.payload;
    let result: unknown;
    try {
      // Execute the JS code using eval to properly return expression values
      // eslint-disable-next-line no-eval
      result = eval(code);
      // Handle async results
      if (result instanceof Promise) {
        result = await result;
      }
    } catch (e) {
      result = { error: e instanceof Error ? e.message : String(e) };
    }
    // Send result back via HTTP
    try {
      const port = 3857; // TODO: get dynamically if needed
      await fetch(`http://localhost:${port}/api/mcp/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id,
          result: typeof result === "string" ? result : JSON.stringify(result),
        }),
      });
    } catch (e) {
      console.error("Failed to send MCP result:", e);
    }
  });

  // Pairing modal dismiss button
  document.getElementById("pairing-dismiss")!.addEventListener("click", hidePairingModal);

  // Handle window resize
  window.addEventListener("resize", () => {
    if (activeSessionId) {
      const session = sessions.get(activeSessionId);
      if (session?.fitAddon && session.terminal) {
        session.fitAddon.fit();
        const ptyDims = getPtyDimensions(session.terminal.cols, session.terminal.rows);
        invoke("resize_pty", {
          sessionId: session.id,
          cols: ptyDims.cols,
          rows: ptyDims.rows,
        });
      }
    }
  });

  // CRITICAL: Capture-phase handler for Ctrl+Tab to intercept BEFORE xterm.js gets it
  // This must use capture phase (true) and stopImmediatePropagation to prevent the key
  // from reaching xterm.js, which would otherwise send it to Claude Code's PTY
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      cycleSessions(e.shiftKey ? "prev" : "next");
    }
  }, true); // true = capture phase, runs before bubbling phase handlers

  // Keyboard shortcuts (bubbling phase)
  document.addEventListener("keydown", (e) => {
    // Cmd+Shift+T or Ctrl+Shift+T to reopen recently closed session
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "t") {
      e.preventDefault();
      reopenLastClosedSession();
      return;
    }
    // Cmd+T or Ctrl+T for new session
    if ((e.metaKey || e.ctrlKey) && e.key === "t") {
      e.preventDefault();
      createQuickSession();
    }
    // Cmd+I to edit/rename current session
    if ((e.metaKey || e.ctrlKey) && e.key === "i") {
      e.preventDefault();
      if (activeSessionId) {
        showEditSessionModal(activeSessionId);
      }
    }
    // Cmd+, for settings
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      showSettingsModal();
    }
    // Cmd+W to close current session (but not when typing in an input)
    if ((e.metaKey || e.ctrlKey) && e.key === "w") {
      const activeEl = document.activeElement;
      const isTyping = activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement;
      if (!isTyping) {
        e.preventDefault();
        if (activeSessionId) {
          closeSession(activeSessionId);
        }
      }
      // Let the chat input handle its own Ctrl+W for word deletion
    }
    // Cmd+B to toggle sidebar
    if ((e.metaKey || e.ctrlKey) && e.key === "b") {
      e.preventDefault();
      toggleSidebar();
    }
    // Escape to close modals or interrupt processing
    if (e.key === "Escape") {
      if (settingsModal.classList.contains("visible")) {
        hideSettingsModal();
      } else if (aboutModal.classList.contains("visible")) {
        hideAboutModal();
      } else if (newSessionModal.classList.contains("visible")) {
        hideNewSessionModal();
      } else if (activeSessionId) {
        // Interrupt current session if processing
        const chatSession = chatSessions.get(activeSessionId);
        if (chatSession?.isProcessing) {
          interruptSession(activeSessionId);
        }
      }
    }
    // Cmd+1-9,0 to switch to sessions (like iTerm2)
    if ((e.metaKey || e.ctrlKey) && /^[0-9]$/.test(e.key)) {
      e.preventDefault();
      const sessionArray = getFilteredAndSortedSessions();
      if (sessionArray.length > 0) {
        let index: number;
        if (e.key === "0") {
          // Cmd+0 = last session
          index = sessionArray.length - 1;
        } else {
          // Cmd+1 = first, Cmd+2 = second, etc.
          index = parseInt(e.key) - 1;
        }
        if (index >= 0 && index < sessionArray.length) {
          switchToSession(sessionArray[index].id);
        }
      }
    }
    // Cmd+Shift+] = next session, Cmd+Shift+[ = previous session (iTerm2 style)
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "]" || e.key === "[")) {
      e.preventDefault();
      cycleSessions(e.key === "]" ? "next" : "prev");
    }
    // Ctrl+V (not Cmd+V) = paste image (like Claude Code)
    if (e.ctrlKey && !e.metaKey && e.key === "v") {
      // Only handle for chat sessions
      if (activeSessionId) {
        const chatSession = chatSessions.get(activeSessionId);
        if (chatSession) {
          e.preventDefault();
          pasteImageFromClipboard(activeSessionId);
        }
      }
    }
  });

  // Save terminal buffers before window closes
  window.addEventListener("beforeunload", () => {
    // Note: beforeunload doesn't support async, so we start the save but can't await it
    // For better persistence, consider using Tauri's window close event instead
    saveAllTerminalBuffers();
  });

  // Also save periodically (every 30 seconds) to prevent data loss
  setInterval(() => {
    saveAllTerminalBuffers();
  }, 30000);

  // Mouse-based drag and drop for session reordering
  document.addEventListener("mousemove", (e) => {
    if (!isDragging || !draggedSessionId || currentSort !== "custom") return;

    // Find the session item we're over
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".session-item") as HTMLElement;

    // Clear all indicators
    sessionListEl.querySelectorAll(".session-item").forEach(el => {
      el.classList.remove("drag-over", "drag-over-bottom");
    });

    if (!target || target.dataset.sessionId === draggedSessionId) return;

    // Show indicator based on mouse position
    const rect = target.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      target.classList.add("drag-over");
    } else {
      target.classList.add("drag-over-bottom");
    }
  });

  document.addEventListener("mouseup", async (e) => {
    if (!isDragging || !draggedSessionId || currentSort !== "custom") {
      isDragging = false;
      draggedSessionId = null;
      return;
    }

    // Find the session item we're over
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".session-item") as HTMLElement;

    // Clear indicators and dragging state
    sessionListEl.querySelectorAll(".session-item").forEach(el => {
      el.classList.remove("drag-over", "drag-over-bottom", "dragging");
    });
    document.body.style.cursor = "";

    if (!target || target.dataset.sessionId === draggedSessionId) {
      isDragging = false;
      draggedSessionId = null;
      return;
    }

    const targetSessionId = target.dataset.sessionId;
    if (!targetSessionId) {
      isDragging = false;
      draggedSessionId = null;
      return;
    }

    const rect = target.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const insertBefore = e.clientY < midY;

    // Reorder sessions
    const draggedSession = sessions.get(draggedSessionId);
    if (!draggedSession) {
      isDragging = false;
      draggedSessionId = null;
      return;
    }

    // Get all sessions sorted by current order
    const allSessions = Array.from(sessions.values()).sort((a, b) => a.sortOrder - b.sortOrder);

    // Remove dragged session from its position
    const reorderedSessions = allSessions.filter(s => s.id !== draggedSessionId);

    // Find target index
    let targetIndex = reorderedSessions.findIndex(s => s.id === targetSessionId);
    if (!insertBefore) {
      targetIndex += 1;
    }

    // Insert at new position
    reorderedSessions.splice(targetIndex, 0, draggedSession);

    // Update sort orders
    const updates: [string, number][] = [];
    reorderedSessions.forEach((s, index) => {
      s.sortOrder = index;
      updates.push([s.id, index]);
    });

    await updateSessionOrders(updates);
    isDragging = false;
    draggedSessionId = null;
    renderSessionList();
  });

  // Load saved sessions from database
  await loadSavedSessions();
  await loadRecentlyClosed();

  // Initial render
  renderSessionList();
  updateView();

  // Check for updates in the background after a short delay
  setTimeout(async () => {
    try {
      const update = await check();
      if (update) {
        console.log(`Update available: v${update.version}`);
        // Show notification about available update
        if (appSettings.notifications_enabled) {
          await showNotification(
            "Update Available",
            `Agent Hub v${update.version} is available. Open Settings to install.`
          );
        }
      }
    } catch (err) {
      console.log("Update check skipped:", err);
    }
  }, 5000); // Check 5 seconds after startup
});

async function loadSavedSessions() {
  try {
    const savedSessions: SessionData[] = await invoke("load_sessions");
    for (const data of savedSessions) {
      const session: Session = {
        id: data.id,
        name: data.name,
        agentType: data.agent_type as Session["agentType"],
        command: data.command,
        workingDir: data.working_dir,
        createdAt: new Date(data.created_at),
        isRunning: false,
        claudeSessionId: data.claude_session_id || undefined,
        // If the session has a claudeSessionId saved, it has been started before
        // This ensures we use --resume when restarting
        hasBeenStarted: !!data.claude_session_id,
        sortOrder: data.sort_order,
      };
      sessions.set(session.id, session);
    }
  } catch (err) {
    console.error("Failed to load sessions:", err);
  }
}

async function saveSessionToDb(session: Session) {
  try {
    const data: SessionData = {
      id: session.id,
      name: session.name,
      agent_type: session.agentType,
      command: session.command,
      working_dir: session.workingDir,
      created_at: session.createdAt.toISOString(),
      claude_session_id: session.claudeSessionId || null,
      sort_order: session.sortOrder,
    };
    await invoke("save_session", { session: data });
  } catch (err) {
    console.error("Failed to save session:", err);
  }
}

async function updateSessionOrders(sessionOrders: [string, number][]) {
  try {
    await invoke("update_session_orders", { sessionOrders });
  } catch (err) {
    console.error("Failed to update session orders:", err);
  }
}

async function deleteSessionFromDb(sessionId: string) {
  try {
    await invoke("delete_session", { sessionId });
  } catch (err) {
    console.error("Failed to delete session:", err);
  }
}

// Quick create session without modal - auto-starts the session
async function createQuickSession() {
  // Calculate the next sort order (put new sessions at the top)
  const minSortOrder = Math.min(0, ...Array.from(sessions.values()).map(s => s.sortOrder));

  // Generate a Claude session ID for Claude sessions
  // This allows us to use --session-id on first run and --resume on subsequent runs
  const claudeSessionId = crypto.randomUUID();

  const session: Session = {
    id: crypto.randomUUID(),
    name: `Claude ${sessions.size + 1}`,
    agentType: "claude-json",
    command: AGENT_COMMANDS["claude-json"],
    workingDir: DEFAULT_WORKING_DIR,
    createdAt: new Date(),
    isRunning: false,
    claudeSessionId, // Pre-generated Claude session ID
    hasBeenStarted: false,
    sortOrder: minSortOrder - 1,
  };

  sessions.set(session.id, session);
  await saveSessionToDb(session);
  await switchToSession(session.id);
  // Auto-start new sessions
  await startSessionProcess(session);
  renderSessionList();
}

// Quick create session with a specific agent type
async function createQuickSessionWithAgent(agentType: Session["agentType"]) {
  const minSortOrder = Math.min(0, ...Array.from(sessions.values()).map(s => s.sortOrder));

  // Generate a Claude session ID for Claude sessions (both xterm and JSON)
  const claudeSessionId = (agentType === "claude" || agentType === "claude-json") ? crypto.randomUUID() : undefined;

  const agentLabel = getAgentLabel(agentType);
  const session: Session = {
    id: crypto.randomUUID(),
    name: `${agentLabel} ${sessions.size + 1}`,
    agentType,
    command: AGENT_COMMANDS[agentType],
    workingDir: DEFAULT_WORKING_DIR,
    createdAt: new Date(),
    isRunning: false,
    claudeSessionId,
    hasBeenStarted: false,
    sortOrder: minSortOrder - 1,
  };

  sessions.set(session.id, session);
  await saveSessionToDb(session);
  await switchToSession(session.id);
  await startSessionProcess(session);
  renderSessionList();
}

// Edit session modal state
let editingSessionId: string | null = null;

function showEditSessionModal(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  editingSessionId = sessionId;
  sessionNameInput.value = session.name;
  agentTypeSelect.value = session.agentType;
  workingDirInput.value = session.workingDir;
  customCommandInput.value = session.agentType === "custom" ? session.command : "";
  customCommandGroup.style.display = session.agentType === "custom" ? "block" : "none";

  // Update modal title and button for editing
  const modalTitle = newSessionModal.querySelector("h2");
  if (modalTitle) modalTitle.textContent = "Edit Session";
  const createBtn = document.getElementById("modal-create");
  if (createBtn) createBtn.textContent = "Save";

  newSessionModal.classList.add("visible");
  sessionNameInput.focus();
  sessionNameInput.select();
}

function showNewSessionModal(agentType: Session["agentType"] = "claude") {
  editingSessionId = null;
  sessionNameInput.value = "";
  agentTypeSelect.value = agentType;
  customCommandInput.value = "";
  workingDirInput.value = DEFAULT_WORKING_DIR;
  customCommandGroup.style.display = agentType === "custom" ? "block" : "none";

  // Update modal title and button for new
  const modalTitle = newSessionModal.querySelector("h2");
  if (modalTitle) modalTitle.textContent = "New Session";
  const createBtn = document.getElementById("modal-create");
  if (createBtn) createBtn.textContent = "Create";

  newSessionModal.classList.add("visible");
  sessionNameInput.focus();
}

function hideNewSessionModal() {
  newSessionModal.classList.remove("visible");
  editingSessionId = null;
}

async function saveSessionFromModal() {
  const name = sessionNameInput.value.trim() || `Session ${sessions.size + 1}`;
  const agentType = agentTypeSelect.value as Session["agentType"];
  let command = AGENT_COMMANDS[agentType];

  if (agentType === "custom") {
    command = customCommandInput.value.trim() || "/bin/zsh";
  }

  if (editingSessionId) {
    // Editing existing session
    const session = sessions.get(editingSessionId);
    if (session) {
      const oldAgentType = session.agentType;
      session.name = name;
      session.agentType = agentType;
      session.command = command;
      session.workingDir = workingDirInput.value.trim() || DEFAULT_WORKING_DIR;

      // If changing to/from Claude, handle claudeSessionId
      if (agentType === "claude" && !session.claudeSessionId) {
        session.claudeSessionId = crypto.randomUUID();
        session.hasBeenStarted = false;
      } else if (agentType !== "claude") {
        session.claudeSessionId = undefined;
      }

      // If agent type changed, mark as not started (new agent = fresh start)
      if (oldAgentType !== agentType) {
        session.hasBeenStarted = false;
      }

      await saveSessionToDb(session);
      renderSessionList();
    }
  } else {
    // Creating new session
    const minSortOrder = Math.min(0, ...Array.from(sessions.values()).map(s => s.sortOrder));

    // Generate a Claude session ID for Claude sessions
    const claudeSessionId = agentType === "claude" ? crypto.randomUUID() : undefined;

    const session: Session = {
      id: crypto.randomUUID(),
      name,
      agentType,
      command,
      workingDir: workingDirInput.value.trim() || DEFAULT_WORKING_DIR,
      createdAt: new Date(),
      isRunning: false,
      claudeSessionId,
      hasBeenStarted: false,
      sortOrder: minSortOrder - 1,
    };

    sessions.set(session.id, session);
    await saveSessionToDb(session);
    await switchToSession(session.id);
    renderSessionList();
  }

  hideNewSessionModal();
}

// ============================================
// Mobile Navigation
// ============================================

function checkMobileLayout(): boolean {
  return window.matchMedia("(max-width: 768px)").matches;
}

function setMobileView(view: MobileView): void {
  currentMobileView = view;

  if (!isMobileLayout) return;

  document.body.classList.remove("mobile-view-list", "mobile-view-session");
  document.body.classList.add(`mobile-view-${view}`);

  updateMobileHeader();
}

function updateMobileHeader(): void {
  const titleEl = document.getElementById("mobile-session-name");
  const statusEl = document.getElementById("mobile-session-status");

  if (!titleEl || !statusEl) return;

  if (currentMobileView === "list" || !activeSessionId) {
    titleEl.textContent = "Sessions";
    statusEl.classList.remove("running");
    statusEl.style.display = "none";
  } else {
    const session = sessions.get(activeSessionId);
    if (session) {
      titleEl.textContent = session.name;
      statusEl.style.display = "inline-block";
      if (session.isRunning) {
        statusEl.classList.add("running");
      } else {
        statusEl.classList.remove("running");
      }
    }
  }
}

function updateMobileLayout(): void {
  isMobileLayout = checkMobileLayout();

  if (isMobileLayout) {
    setMobileView(currentMobileView);
  } else {
    document.body.classList.remove("mobile-view-list", "mobile-view-session");
  }
}

function navigateBackToList(): void {
  if (isMobileLayout) {
    setMobileView("list");
  }
}

function toggleMobileMenu(): void {
  const menu = document.getElementById("mobile-user-menu");
  if (menu) {
    menu.classList.toggle("visible");
  }
}

function hideMobileMenu(): void {
  const menu = document.getElementById("mobile-user-menu");
  if (menu) {
    menu.classList.remove("visible");
  }
}

async function initMobileMenuInfo(): Promise<void> {
  const serverUrlEl = document.getElementById("mobile-server-url");
  const appVersionEl = document.getElementById("mobile-app-version");

  if (appVersionEl) {
    try {
      const version = await getVersion();
      appVersionEl.textContent = version;
    } catch {
      appVersionEl.textContent = "Unknown";
    }
  }

  if (serverUrlEl) {
    serverUrlEl.textContent = window.location.host || "localhost:3857";
  }
}

async function switchToSession(sessionId: string) {
  // Hide current session UI
  if (activeSessionId) {
    const currentSession = sessions.get(activeSessionId);
    if (currentSession) {
      if (isJsonAgent(currentSession.agentType)) {
        // Hide chat session
        const chatSession = chatSessions.get(activeSessionId);
        if (chatSession) {
          chatSession.containerEl.classList.remove("active");
        }
      } else if (currentSession.terminal) {
        // Hide terminal
        currentSession.terminal.element?.parentElement?.classList.add("hidden");
      }
    }
  }

  activeSessionId = sessionId;
  const session = sessions.get(sessionId);
  if (!session) return;

  // Switch to session view on mobile
  if (isMobileLayout) {
    setMobileView("session");
  }

  // Handle JSON (chat) sessions differently
  if (isJsonAgent(session.agentType)) {
    // Create or show chat UI
    if (!chatSessions.has(sessionId)) {
      await initializeChatView(session);
    }
    showChatSession(sessionId);
    updateView();
    updateStartBanner();
    renderSessionList();
    return;
  }

  // Terminal-based sessions
  // Create terminal view if it doesn't exist (but don't auto-start process)
  if (!session.terminal) {
    await initializeTerminalView(session);
  } else {
    // Ensure terminal has correct theme before showing
    session.terminal.options.theme = getTerminalTheme();
    // Clear WebGL texture atlas to prevent visual artifacts
    if (session.webglAddon) {
      session.webglAddon.clearTextureAtlas();
    }
    // Fit BEFORE showing to get correct dimensions while still invisible
    session.fitAddon?.fit();
    // Show existing terminal
    session.terminal.element?.parentElement?.classList.remove("hidden");
    session.terminal.focus();
    // Fit again after showing and refresh
    setTimeout(async () => {
      if (session.fitAddon && session.terminal) {
        session.fitAddon.fit();
        // Force a full refresh to redraw content at new size
        session.terminal.refresh(0, session.terminal.rows - 1);
        // Update PTY size if session is running
        if (session.isRunning) {
          const ptyDims = getPtyDimensions(session.terminal.cols, session.terminal.rows);
          await invoke("resize_pty", {
            sessionId: session.id,
            cols: ptyDims.cols,
            rows: ptyDims.rows,
          });
        }
      }
    }, 50);
  }

  // Hide chat container for terminal sessions
  chatContainerEl.style.display = "none";
  terminalContainerEl.style.display = "block";

  updateView();
  updateStartBanner();
  renderSessionList();

  // Focus terminal after all view updates to ensure it receives keyboard input
  // Keep trying until terminal is ready (can take seconds for large buffers)
  const focusTerminal = () => {
    if (session.terminal) {
      session.terminal.focus();
    }
  };

  // Try immediately and then periodically for up to 3 seconds
  focusTerminal();
  const focusInterval = setInterval(focusTerminal, 200);
  setTimeout(() => clearInterval(focusInterval), 3000);
}

/**
 * Initialize terminal view without starting the process.
 * This allows viewing session history without spawning a PTY.
 */
async function initializeTerminalView(session: Session) {
  // Ensure terminal container is visible and sized
  terminalContainerEl.style.display = "block";
  terminalContainerEl.style.position = "relative";
  emptyStateEl.style.display = "none";

  // Create wrapper div for this terminal
  const wrapper = document.createElement("div");
  wrapper.className = "terminal-wrapper";
  wrapper.dataset.sessionId = session.id;
  // Set background to match terminal theme BEFORE adding to DOM to prevent flash
  const isDark = getEffectiveTheme() === "dark";
  wrapper.style.background = isDark ? "#1a1a1a" : "#ffffff";
  // Start hidden, show after terminal is ready
  wrapper.style.opacity = "0";
  terminalContainerEl.appendChild(wrapper);

  const terminal = new Terminal({
    fontFamily: appSettings.font_family || "Menlo, Monaco, 'Courier New', monospace",
    fontSize: appSettings.font_size || 13,
    theme: getTerminalTheme(),
    cursorBlink: true,
    cursorStyle: "block",
    scrollback: 10000,
    allowProposedApi: true,
    // Options that may help with TUI rendering (like Claude Code)
    customGlyphs: true, // Better rendering for box-drawing characters
    rescaleOverlappingGlyphs: true, // Fix overlapping glyphs
    drawBoldTextInBrightColors: false, // More consistent rendering
  });

  const fitAddon = new FitAddon();
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(serializeAddon);
  terminal.loadAddon(new WebLinksAddon());

  terminal.open(wrapper);

  // Load WebGL addon for better rendering performance (must be after open)
  // Can be disabled in settings if experiencing visual artifacts
  let webglAddon: WebglAddon | undefined;
  if (appSettings.renderer === "webgl") {
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon?.dispose();
        session.webglAddon = undefined;
      });
      terminal.loadAddon(webglAddon);
    } catch (err) {
      console.warn("WebGL addon failed to load, falling back to canvas renderer:", err);
      webglAddon = undefined;
    }
  }

  session.terminal = terminal;
  session.fitAddon = fitAddon;
  session.serializeAddon = serializeAddon;
  session.webglAddon = webglAddon;

  // Try to restore saved terminal buffer
  try {
    const savedBuffer: string | null = await invoke("load_terminal_buffer", { sessionId: session.id });
    if (savedBuffer) {
      terminal.write(savedBuffer);
    }
  } catch (err) {
    console.error("Failed to load terminal buffer:", err);
  }

  // Fit after a short delay to ensure container is properly sized
  await new Promise(resolve => setTimeout(resolve, 100));
  fitAddon.fit();

  // Fit again after another delay to handle any layout changes
  await new Promise(resolve => setTimeout(resolve, 200));
  fitAddon.fit();

  // Show the wrapper now that terminal is ready
  wrapper.style.opacity = "1";

  // Custom key handler - intercept keys before they go to PTY
  terminal.attachCustomKeyEventHandler((event) => {
    // Shift+Enter - send newline
    if (event.key === "Enter" && event.shiftKey) {
      if (event.type === "keydown" && session.isRunning) {
        invoke("write_pty", { sessionId: session.id, data: "\n" });
      }
      return false;
    }
    // Ctrl+Tab / Ctrl+Shift+Tab - cycle sessions (prevent from going to PTY)
    if (event.ctrlKey && event.key === "Tab") {
      if (event.type === "keydown") {
        cycleSessions(event.shiftKey ? "prev" : "next");
      }
      return false;
    }
    return true;
  });

  // Handle terminal input - only send to PTY if session is running
  terminal.onData(async (data) => {
    if (!session.isRunning) {
      // Session not running - ignore input, user must click banner to start
      return;
    }
    // Record input time for echo filtering in activity indicator
    recordSessionInput(session.id);
    invoke("write_pty", { sessionId: session.id, data });

    // Mark Claude session as started when user sends first input
    if (session.agentType === "claude" && !session.hasBeenStarted) {
      session.hasBeenStarted = true;
      await saveSessionToDb(session);
    }
  });

  // Handle terminal resize - only if running
  terminal.onResize(({ cols, rows }) => {
    if (session.isRunning) {
      const ptyDims = getPtyDimensions(cols, rows);
      invoke("resize_pty", { sessionId: session.id, cols: ptyDims.cols, rows: ptyDims.rows });
    }
  });

  // Handle terminal bell (attention needed)
  terminal.onBell(async () => {
    // Show notification if enabled
    if (appSettings.bell_notifications_enabled) {
      try {
        const win = getCurrentWindow();
        const isFocused = await win.isFocused();
        if (!isFocused) {
          await showNotification(
            "Agent Hub",
            `${session.name} needs attention`
          );
        }
      } catch (err) {
        console.error("Failed to send bell notification:", err);
      }
    }

    // Bounce dock icon if enabled
    if (appSettings.bounce_dock_on_bell) {
      try {
        const win = getCurrentWindow();
        // 1 = informational attention (bounces once)
        // 2 = critical attention (bounces until focused)
        await win.requestUserAttention(1);
      } catch (err) {
        console.error("Failed to request user attention:", err);
      }
    }
  });

  // Set up mobile momentum scrolling
  setupMobileTouchScroll(terminal, wrapper);

  terminal.focus();
}

/**
 * Set up momentum-based touch scrolling for mobile devices.
 * xterm.js intercepts touch events for mouse reporting, which kills native
 * momentum scrolling. This implementation provides native-like inertia scrolling.
 */
function setupMobileTouchScroll(terminal: Terminal, wrapper: HTMLElement): void {
  // Only set up on touch devices
  if (!('ontouchstart' in window)) return;

  // Get the xterm viewport element where scrolling happens
  const viewport = wrapper.querySelector('.xterm-viewport') as HTMLElement | null;
  if (!viewport) return;

  // State for touch tracking
  let touchStartY = 0;
  let touchStartTime = 0;
  let lastTouchY = 0;
  let lastTouchTime = 0;
  let velocity = 0;
  let momentumId: number | null = null;
  let isTracking = false;

  // Velocity samples for smoother momentum calculation
  const velocitySamples: { dy: number; dt: number }[] = [];
  const maxSamples = 5;

  // Physics constants for natural feeling scroll
  const friction = 0.95; // Deceleration per frame (lower = more friction)
  const minVelocity = 0.5; // Stop momentum below this threshold
  const scrollMultiplier = 0.8; // Pixels per velocity unit

  function cancelMomentum(): void {
    if (momentumId !== null) {
      cancelAnimationFrame(momentumId);
      momentumId = null;
    }
    velocity = 0;
  }

  function handleTouchStart(e: TouchEvent): void {
    // Cancel any existing momentum scroll
    cancelMomentum();

    const touch = e.touches[0];
    touchStartY = touch.clientY;
    touchStartTime = performance.now();
    lastTouchY = touch.clientY;
    lastTouchTime = touchStartTime;
    velocitySamples.length = 0;
    isTracking = true;
  }

  function handleTouchMove(e: TouchEvent): void {
    if (!isTracking) return;

    const touch = e.touches[0];
    const currentTime = performance.now();
    const deltaY = lastTouchY - touch.clientY;
    const deltaTime = currentTime - lastTouchTime;

    // Scroll the terminal
    if (Math.abs(deltaY) > 0 && viewport) {
      // Use viewport scrollTop directly for smoother scrolling
      viewport.scrollTop += deltaY;

      // Prevent default to avoid page scroll
      e.preventDefault();
    }

    // Track velocity samples
    if (deltaTime > 0) {
      velocitySamples.push({ dy: deltaY, dt: deltaTime });
      if (velocitySamples.length > maxSamples) {
        velocitySamples.shift();
      }
    }

    lastTouchY = touch.clientY;
    lastTouchTime = currentTime;
  }

  function handleTouchEnd(e: TouchEvent): void {
    if (!isTracking) return;
    isTracking = false;

    // Calculate average velocity from samples
    if (velocitySamples.length > 0) {
      let totalDy = 0;
      let totalDt = 0;
      for (const sample of velocitySamples) {
        totalDy += sample.dy;
        totalDt += sample.dt;
      }
      // Velocity in pixels per millisecond
      velocity = totalDt > 0 ? (totalDy / totalDt) * 16 : 0; // Convert to per-frame
    }

    // Start momentum scrolling if velocity is significant
    if (Math.abs(velocity) > minVelocity) {
      startMomentumScroll();
    }
  }

  function startMomentumScroll(): void {
    function animate(): void {
      if (Math.abs(velocity) < minVelocity || !viewport) {
        cancelMomentum();
        return;
      }

      // Apply scroll
      const scrollAmount = velocity * scrollMultiplier;
      viewport.scrollTop += scrollAmount;

      // Apply friction
      velocity *= friction;

      // Continue animation
      momentumId = requestAnimationFrame(animate);
    }

    momentumId = requestAnimationFrame(animate);
  }

  // Add event listeners with passive: false to allow preventDefault
  viewport.addEventListener('touchstart', handleTouchStart, { passive: true });
  viewport.addEventListener('touchmove', handleTouchMove, { passive: false });
  viewport.addEventListener('touchend', handleTouchEnd, { passive: true });
  viewport.addEventListener('touchcancel', handleTouchEnd, { passive: true });
}

/**
 * Start the session process (spawn PTY or JSON process).
 * Called when user explicitly starts a session or types in an inactive one.
 */
async function startSessionProcess(session: Session) {
  if (session.isRunning) return;

  // Handle JSON sessions differently
  if (isJsonAgent(session.agentType)) {
    await startJsonProcess(session);
    return;
  }

  // Terminal-based sessions require terminal
  if (!session.terminal) return;

  const terminal = session.terminal;

  // For Claude sessions, determine if we should resume
  const shouldResume = session.agentType === "claude" && session.hasBeenStarted === true;

  const ptyDims = getPtyDimensions(terminal.cols, terminal.rows);

  try {
    await invoke("spawn_pty", {
      sessionId: session.id,
      command: session.command,
      workingDir: session.workingDir || null,
      cols: ptyDims.cols,
      rows: ptyDims.rows,
      claudeSessionId: session.claudeSessionId || null,
      resumeSession: shouldResume,
    });
    session.isRunning = true;
    updateStartBanner();
    renderSessionList();
  } catch (err) {
    terminal.write(`\x1b[31mError spawning PTY: ${err}\x1b[0m\r\n`);
  }
}

/**
 * Start a JSON streaming process for chat-based sessions.
 */
async function startJsonProcess(session: Session) {
  if (session.isRunning) return;

  const chatSession = chatSessions.get(session.id);
  if (!chatSession) return;

  // For claude-json sessions, determine if we should resume
  const shouldResume = session.hasBeenStarted === true && !!session.claudeSessionId;

  chatSession.statusEl.textContent = "Starting...";
  chatSession.statusEl.className = "chat-status";

  // Check if this is a resume (session already has an init message)
  const existingInit = chatSession.messagesEl.querySelector(".init-details");
  const isResume = existingInit !== null;

  if (!existingInit) {
    // First time - insert a placeholder init message at the top
    const initPlaceholder = document.createElement("div");
    initPlaceholder.className = "chat-message system init-details";
    initPlaceholder.innerHTML = `
      <div class="init-header">Session starting...</div>
      <div class="init-main">${session.workingDir || "~"}</div>
    `;
    // Insert at the beginning, not end
    const firstChild = chatSession.messagesEl.firstChild;
    if (firstChild) {
      chatSession.messagesEl.insertBefore(initPlaceholder, firstChild);
    } else {
      chatSession.messagesEl.appendChild(initPlaceholder);
    }
  } else {
    // Resuming - add a session resumed event
    addSessionEvent(session.id, "resumed");
  }

  try {
    await invoke("spawn_json_process", {
      sessionId: session.id,
      command: session.command,
      workingDir: session.workingDir || null,
      claudeSessionId: session.claudeSessionId || null,
      resumeSession: shouldResume,
    });
    // Note: isRunning will be set by the json-process-started event
  } catch (err) {
    chatSession.statusEl.textContent = `Error: ${err}`;
    chatSession.statusEl.className = "chat-status error";
    addChatMessage(session.id, {
      type: "system",
      subtype: "error",
      result: `Failed to start process: ${err}`,
    });
  }
}

async function closeSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Save to recently closed database before deleting
  const closedSession: RecentlyClosedSession = {
    id: session.id,
    name: session.name,
    agentType: session.agentType,
    command: session.command,
    workingDir: session.workingDir,
    claudeSessionId: session.claudeSessionId,
    closedAt: new Date(),
  };
  await saveRecentlyClosed(closedSession);
  await loadRecentlyClosed(); // Refresh the list from database

  // Kill process (PTY or JSON)
  if (isJsonAgent(session.agentType)) {
    invoke("kill_json_process", { sessionId });
    // Remove chat UI
    const chatSession = chatSessions.get(sessionId);
    if (chatSession) {
      chatSession.containerEl.remove();
      chatSessions.delete(sessionId);
    }
  } else {
    invoke("kill_pty", { sessionId });
    // Remove terminal DOM
    const wrapper = terminalContainerEl.querySelector(`[data-session-id="${sessionId}"]`);
    if (wrapper) {
      session.terminal?.dispose();
      wrapper.remove();
    }
  }

  // Delete from database (including terminal buffer)
  await deleteSessionFromDb(sessionId);
  await deleteTerminalBuffer(sessionId);

  sessions.delete(sessionId);

  // Switch to another session or show empty state
  if (activeSessionId === sessionId) {
    const remaining = Array.from(sessions.keys());
    if (remaining.length > 0) {
      switchToSession(remaining[remaining.length - 1]);
    } else {
      activeSessionId = null;
      updateView();
    }
  }

  renderSessionList();
}

// Recently closed functions
function reopenLastClosedSession() {
  if (recentlyClosed.length > 0) {
    restoreRecentlyClosed(0);
  }
}

async function restoreRecentlyClosed(index: number) {
  const closed = recentlyClosed[index];
  if (!closed) return;

  // Remove from database
  await invoke("delete_recently_closed", { sessionId: closed.id });
  await loadRecentlyClosed(); // Refresh the list from database

  // Calculate sort order
  const minSortOrder = Math.min(0, ...Array.from(sessions.values()).map(s => s.sortOrder));

  // Create the session with the saved settings
  const session: Session = {
    id: crypto.randomUUID(),
    name: closed.name,
    agentType: closed.agentType,
    command: closed.command,
    workingDir: closed.workingDir,
    createdAt: new Date(),
    isRunning: false,
    claudeSessionId: closed.claudeSessionId, // Preserve for --resume
    hasBeenStarted: false,
    sortOrder: minSortOrder - 1,
  };

  sessions.set(session.id, session);
  await saveSessionToDb(session);
  await switchToSession(session.id);
  await startSessionProcess(session);
  renderSessionList();
}

// Database helpers for recently closed sessions
async function saveRecentlyClosed(session: RecentlyClosedSession): Promise<void> {
  await invoke("save_recently_closed", {
    session: {
      id: session.id,
      name: session.name,
      agent_type: session.agentType,
      command: session.command,
      working_dir: session.workingDir,
      claude_session_id: session.claudeSessionId || null,
      closed_at: session.closedAt.toISOString(),
    },
  });
}

async function loadRecentlyClosed(): Promise<void> {
  try {
    const data = await invoke<Array<{
      id: string;
      name: string;
      agent_type: string;
      command: string;
      working_dir: string;
      claude_session_id: string | null;
      closed_at: string;
    }>>("get_recently_closed");

    recentlyClosed = data.map((d) => ({
      id: d.id,
      name: d.name,
      agentType: d.agent_type as RecentlyClosedSession["agentType"],
      command: d.command,
      workingDir: d.working_dir,
      claudeSessionId: d.claude_session_id || undefined,
      closedAt: new Date(d.closed_at),
    }));

    // Update the History menu with recently closed sessions
    await invoke("update_history_menu", {
      sessions: data,
    });
  } catch (err) {
    console.error("Failed to load recently closed sessions:", err);
    recentlyClosed = [];
  }
}

async function renameSession(sessionId: string, newName: string) {
  const session = sessions.get(sessionId);
  if (session) {
    session.name = newName.trim() || session.name;
    await saveSessionToDb(session);
    renderSessionList();
  }
}

// Helper function to cycle through sessions
function cycleSessions(direction: "next" | "prev"): void {
  const sessionArray = getFilteredAndSortedSessions();
  if (sessionArray.length > 1 && activeSessionId) {
    const currentIndex = sessionArray.findIndex(s => s.id === activeSessionId);
    let nextIndex: number;
    if (direction === "prev") {
      nextIndex = currentIndex <= 0 ? sessionArray.length - 1 : currentIndex - 1;
    } else {
      nextIndex = currentIndex >= sessionArray.length - 1 ? 0 : currentIndex + 1;
    }
    switchToSession(sessionArray[nextIndex].id);
  }
}

// Helper function to get sessions filtered and sorted (used by renderSessionList and keyboard shortcuts)
function getFilteredAndSortedSessions(): Session[] {
  let filteredSessions = Array.from(sessions.values());

  if (searchQuery) {
    filteredSessions = filteredSessions.filter(session => {
      const nameMatch = session.name.toLowerCase().includes(searchQuery);
      const agentMatch = session.agentType.toLowerCase().includes(searchQuery);
      const dirMatch = session.workingDir.toLowerCase().includes(searchQuery);
      return nameMatch || agentMatch || dirMatch;
    });
  }

  // Apply sorting
  let sortedSessions: Session[];
  switch (currentSort) {
    case "name":
      sortedSessions = filteredSessions.sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      break;
    case "date":
      sortedSessions = filteredSessions.sort((a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime()
      );
      break;
    case "agent":
      sortedSessions = filteredSessions.sort((a, b) =>
        a.agentType.localeCompare(b.agentType)
      );
      break;
    case "custom":
    default:
      sortedSessions = filteredSessions.sort((a, b) =>
        a.sortOrder - b.sortOrder
      );
      break;
  }

  return sortedSessions;
}

function renderSessionList() {
  sessionListEl.innerHTML = "";

  const sortedSessions = getFilteredAndSortedSessions();

  // Show "no results" message if search has no matches
  if (sortedSessions.length === 0 && searchQuery) {
    const noResults = document.createElement("div");
    noResults.className = "no-results";
    noResults.textContent = `No sessions match "${searchQuery}"`;
    sessionListEl.appendChild(noResults);
    return;
  }

  for (let i = 0; i < sortedSessions.length; i++) {
    const session = sortedSessions[i];
    const item = document.createElement("div");
    // Preserve activity state across re-renders
    const isSessionActive = activityState.get(session.id)?.isActive || false;
    item.className = `session-item${session.id === activeSessionId ? " active" : ""}${isSessionActive ? " session-active" : ""}`;
    item.dataset.sessionId = session.id;

    const agentBadgeClass = session.agentType === "claude" ? "claude" :
                           session.agentType === "codex" ? "codex" :
                           session.agentType === "aider" ? "aider" : "";

    // Show shortcut indicator for first 10 sessions (⌘1-9, ⌘0)
    const shortcutKey = i < 9 ? String(i + 1) : i === 9 ? "0" : null;
    const shortcutHtml = shortcutKey ? `<span class="shortcut-hint">⌘${shortcutKey}</span>` : "";

    item.innerHTML = `
      <div class="drag-handle" title="Drag to reorder">⋮⋮</div>
      <div class="status ${session.isRunning ? "running" : ""}"></div>
      <div class="details">
        <div class="name">${escapeHtml(session.name)}</div>
        <div class="meta">
          <span class="agent-badge ${agentBadgeClass}">${getAgentLabel(session.agentType)}</span>
        </div>
      </div>
      ${shortcutHtml}
      <button class="close-btn" title="Close session">×</button>
    `;

    // Click to switch
    item.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains("close-btn") && !target.classList.contains("drag-handle")) {
        switchToSession(session.id);
      }
    });

    // Double-click to rename
    const nameEl = item.querySelector(".name")!;
    nameEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRenaming(session.id, nameEl as HTMLElement);
    });

    // Close button
    item.querySelector(".close-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSession(session.id);
    });

    // Mouse-based drag - start on drag handle mousedown
    if (currentSort === "custom") {
      const dragHandle = item.querySelector(".drag-handle") as HTMLElement;
      if (dragHandle) {
        dragHandle.addEventListener("mousedown", (e) => {
          e.preventDefault();
          isDragging = true;
          draggedSessionId = session.id;
          dragStartY = e.clientY;
          item.classList.add("dragging");
          document.body.style.cursor = "grabbing";
        });
      }
    }

    sessionListEl.appendChild(item);
  }
}

function startRenaming(sessionId: string, nameEl: HTMLElement) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const input = document.createElement("input");
  input.type = "text";
  input.value = session.name;

  const finishRename = () => {
    renameSession(sessionId, input.value);
  };

  input.addEventListener("blur", finishRename);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finishRename();
    }
    if (e.key === "Escape") {
      renderSessionList();
    }
  });

  nameEl.innerHTML = "";
  nameEl.appendChild(input);
  input.focus();
  input.select();
}

function updateView() {
  const hasActiveSession = activeSessionId !== null;
  const activeSession = activeSessionId ? sessions.get(activeSessionId) : null;
  const isJsonSession = activeSession && isJsonAgent(activeSession.agentType);

  emptyStateEl.style.display = hasActiveSession ? "none" : "flex";

  // Show terminal container only for terminal sessions, hide for JSON/chat sessions
  if (isJsonSession) {
    terminalContainerEl.style.display = "none";
    chatContainerEl.style.display = "flex";
  } else {
    terminalContainerEl.style.display = hasActiveSession ? "block" : "none";
    chatContainerEl.style.display = "none";
  }

  // Update terminal container to position properly
  if (hasActiveSession && !isJsonSession) {
    terminalContainerEl.style.position = "relative";
  }

  // Hide all terminal wrappers except active
  const wrappers = terminalContainerEl.querySelectorAll(".terminal-wrapper");
  wrappers.forEach((wrapper) => {
    const el = wrapper as HTMLElement;
    el.style.display = el.dataset.sessionId === activeSessionId ? "block" : "none";
  });

  // Update mobile header
  updateMobileHeader();
}

/**
 * Update the start banner visibility based on active session state.
 * For chat sessions, uses the inline status instead of the global banner.
 */
function updateStartBanner() {
  const startBanner = document.getElementById("start-session-banner");
  if (!startBanner) return;

  if (!activeSessionId) {
    startBanner.style.display = "none";
    return;
  }

  const session = sessions.get(activeSessionId);
  if (!session) {
    startBanner.style.display = "none";
    return;
  }

  // For JSON chat sessions, use inline status instead of banner
  if (isJsonAgent(session.agentType)) {
    startBanner.style.display = "none";
    const chatSession = chatSessions.get(activeSessionId);
    if (chatSession && !session.isRunning) {
      const statusText = session.hasBeenStarted ? "Session inactive" : "New session";
      const actionText = session.hasBeenStarted ? "Press any key or click to resume" : "Press any key or click to start";
      chatSession.statusEl.textContent = `${statusText} · ${actionText}`;
      chatSession.statusEl.className = "chat-status inactive";
    }
    return;
  }

  // Show banner if session is not running (terminal sessions)
  if (!session.isRunning) {
    startBanner.style.display = "flex";
    const statusText = startBanner.querySelector(".banner-status");
    const actionText = startBanner.querySelector(".banner-action");
    if (statusText) {
      statusText.textContent = session.hasBeenStarted ? "Session inactive" : "New session";
    }
    if (actionText) {
      actionText.textContent = session.hasBeenStarted ? "Press any key or click to resume" : "Press any key or click to start";
    }
  } else {
    startBanner.style.display = "none";
  }
}

function getAgentLabel(agentType: string): string {
  switch (agentType) {
    case "claude": return "Claude (xterm)";
    case "claude-json": return "Claude";
    case "aider": return "Aider";
    case "shell": return "Shell";
    case "custom": return "Custom";
    default: return agentType;
  }
}

// Check if agent type uses JSON streaming (chat UI) vs terminal
function isJsonAgent(agentType: string): boolean {
  return agentType === "claude-json";
}

// ============================================
// Chat UI Functions for JSON Sessions
// ============================================

/**
 * Initialize chat UI for a JSON session
 */
async function initializeChatView(session: Session): Promise<ChatSession> {
  // Create chat container for this session
  const containerEl = document.createElement("div");
  containerEl.className = "chat-session";
  containerEl.dataset.sessionId = session.id;

  containerEl.innerHTML = `
    <div class="chat-todos"></div>
    <div class="chat-messages"></div>
    <div class="chat-thinking" style="display: none;">
      <span>Claude is thinking</span>
      <div class="dots">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </div>
    </div>
    <div class="chat-attachments"></div>
    <div class="chat-input-container">
      <textarea class="chat-input" placeholder="Type a message..." rows="1"></textarea>
      <button class="chat-send-btn">Send</button>
    </div>
    <div class="chat-status">Ready</div>
  `;

  chatContainerEl.appendChild(containerEl);

  const messagesEl = containerEl.querySelector(".chat-messages") as HTMLElement;
  const inputEl = containerEl.querySelector(".chat-input") as HTMLTextAreaElement;
  const sendBtn = containerEl.querySelector(".chat-send-btn") as HTMLButtonElement;
  const statusEl = containerEl.querySelector(".chat-status") as HTMLElement;
  const attachmentsEl = containerEl.querySelector(".chat-attachments") as HTMLElement;
  const todosEl = containerEl.querySelector(".chat-todos") as HTMLElement;

  const chatSession: ChatSession = {
    messagesEl,
    inputEl,
    sendBtn,
    statusEl,
    containerEl,
    attachmentsEl,
    todosEl,
    messages: [],
    todos: [],
    isProcessing: false,
    inputBuffer: "",
    pendingImages: [],
    pastedTextBlocks: [],
    pasteBlockCounter: 0,
    cwd: "",
    toolUseCount: 0,
    streamingTokens: 0,
    startTime: null,
  };

  // Auto-resize textarea
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + "px";
  });

  // Send on Enter (Shift+Enter for newline)
  inputEl.addEventListener("keydown", (e) => {
    // Start session if inactive and user types
    const sess = sessions.get(session.id);
    if (sess && !sess.isRunning && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      startSessionProcess(sess);
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage(session.id);
    }
    // Ctrl+W to delete previous word
    if (e.key === "w" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const pos = inputEl.selectionStart || 0;
      const text = inputEl.value;
      // Find start of previous word
      let wordStart = pos;
      // Skip trailing spaces
      while (wordStart > 0 && text[wordStart - 1] === " ") wordStart--;
      // Skip word characters
      while (wordStart > 0 && text[wordStart - 1] !== " ") wordStart--;
      // Delete from wordStart to pos
      inputEl.value = text.slice(0, wordStart) + text.slice(pos);
      inputEl.selectionStart = inputEl.selectionEnd = wordStart;
      inputEl.dispatchEvent(new Event("input")); // Trigger resize
    }
  });

  // Handle paste events for images and long text
  inputEl.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    // Check for images first
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        // Read as base64
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          // Extract base64 data (remove "data:image/png;base64," prefix)
          const base64Match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (!base64Match) return;

          const mediaType = base64Match[1];
          const base64Data = base64Match[2];

          // Create preview element
          const previewEl = document.createElement("div");
          previewEl.className = "attachment-preview";
          previewEl.innerHTML = `
            <img src="${dataUrl}" alt="Attached image" />
            <button class="attachment-remove" title="Remove">×</button>
          `;

          // Remove button handler
          const removeBtn = previewEl.querySelector(".attachment-remove")!;
          removeBtn.addEventListener("click", () => {
            const idx = chatSession.pendingImages.findIndex(img => img.previewEl === previewEl);
            if (idx >= 0) {
              chatSession.pendingImages.splice(idx, 1);
            }
            previewEl.remove();
          });

          chatSession.attachmentsEl.appendChild(previewEl);
          chatSession.pendingImages.push({ mediaType, base64Data, previewEl });
        };
        reader.readAsDataURL(file);
        return; // Don't process text if pasting image
      }
    }

    // Check for long text paste (>500 chars or >10 lines) - use inline placeholder like CC
    const pastedText = e.clipboardData?.getData("text");
    if (pastedText) {
      const lineCount = pastedText.split("\n").length;
      const charCount = pastedText.length;

      if (charCount > 500 || lineCount > 10) {
        e.preventDefault();

        // Increment block counter and create placeholder
        chatSession.pasteBlockCounter++;
        const blockId = chatSession.pasteBlockCounter;
        const placeholder = `[Pasted text #${blockId} +${lineCount} lines]`;

        // Store the actual text
        chatSession.pastedTextBlocks.push({
          id: blockId,
          text: pastedText,
          lineCount,
        });

        // Insert placeholder at cursor position
        const cursorPos = inputEl.selectionStart || 0;
        const beforeCursor = inputEl.value.slice(0, cursorPos);
        const afterCursor = inputEl.value.slice(inputEl.selectionEnd || cursorPos);

        inputEl.value = beforeCursor + placeholder + afterCursor;

        // Position cursor after the placeholder
        const newCursorPos = cursorPos + placeholder.length;
        inputEl.selectionStart = inputEl.selectionEnd = newCursorPos;

        // Trigger resize
        inputEl.dispatchEvent(new Event("input"));
      }
    }
  });

  // Send button click
  sendBtn.addEventListener("click", () => sendChatMessage(session.id));

  // Status click to start/resume inactive session
  statusEl.addEventListener("click", () => {
    const sess = sessions.get(session.id);
    if (sess && !sess.isRunning && statusEl.classList.contains("inactive")) {
      startSessionProcess(sess);
    }
  });

  chatSessions.set(session.id, chatSession);

  // Always try to load existing messages - buffer may exist even if claudeSessionId is missing
  // (e.g., session was used but claudeSessionId wasn't saved properly)
  await loadChatMessages(session.id, chatSession);

  // If we loaded messages, mark the session as having been started
  if (chatSession.messages.length > 0 && !session.hasBeenStarted) {
    session.hasBeenStarted = true;
  }

  return chatSession;
}

/**
 * Handle slash commands in chat
 * Returns true if the command was handled, false to pass through to Claude
 */
async function handleSlashCommand(sessionId: string, command: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  const chatSession = chatSessions.get(sessionId);
  if (!session || !chatSession) return false;

  const parts = command.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(" ");

  switch (cmd) {
    case "help":
      addChatMessage(sessionId, {
        type: "system",
        result: `**App Commands (handled locally):**
• \`/help\` - Show this help message
• \`/clear\` - Clear chat display (keeps conversation in Claude's context)
• \`/restart\` - Restart an inactive session process
• \`/status\` - Show session status

**Claude Commands (passed through):**
• \`/compact [instructions]\` - Compact conversation context
• \`/cost\` - Show token usage and cost
• \`/context\` - Show context usage
• \`/review\` - Review code changes
• \`/init\` - Reinitialize session

**Not available in JSON mode:**
• \`/resume\` - Use Session > Browse Claude Sessions menu instead
• \`/memory\`, \`/config\` - Interactive only`,
      });
      return true;

    case "clear":
      // Clear the chat display (but not Claude's context)
      chatSession.messagesEl.innerHTML = "";
      chatSession.messages = [];
      addChatMessage(sessionId, {
        type: "system",
        result: "Chat display cleared. Claude still remembers the conversation.",
      });
      return true;

    case "restart":
      if (!session.isRunning) {
        addChatMessage(sessionId, { type: "system", result: "Restarting session..." });
        await startSessionProcess(session);
      } else {
        addChatMessage(sessionId, { type: "system", result: "Session is already running." });
      }
      return true;

    case "status":
      const statusInfo = [
        `**Session:** ${session.name}`,
        `**Agent:** ${session.agentType}`,
        `**Running:** ${session.isRunning ? "Yes" : "No"}`,
        `**Working Dir:** ${session.workingDir}`,
        session.claudeSessionId ? `**Claude Session:** ${session.claudeSessionId}` : null,
      ].filter(Boolean).join("\n");
      addChatMessage(sessionId, { type: "system", result: statusInfo });
      return true;

    // These commands work in JSON mode and are passed through to Claude
    case "compact":
    case "cost":
    case "context":
    case "review":
    case "init":
    case "pr-comments":
    case "release-notes":
    case "security-review":
      // Pass these to Claude - return false so they're sent as messages
      return false;

    // These commands don't work in JSON mode - show helpful message
    case "resume":
    case "memory":
    case "config":
      addChatMessage(sessionId, {
        type: "system",
        result: `\`/${cmd}\` requires interactive mode and doesn't work in Agent Hub. See Session menu for alternatives.`,
      });
      return true;

    default:
      // Unknown command - let Claude handle it
      return false;
  }
}

/**
 * Interrupt a running chat session (like pressing Escape in CLI)
 */
async function interruptSession(sessionId: string) {
  const session = sessions.get(sessionId);
  const chatSession = chatSessions.get(sessionId);
  if (!session || !chatSession || !chatSession.isProcessing) return;

  try {
    await invoke("interrupt_json_process", { sessionId });
    chatSession.statusEl.textContent = "Interrupted";
    chatSession.statusEl.className = "chat-status";
    // Note: isProcessing will be set to false when we receive the result message
  } catch (err) {
    console.error("Failed to interrupt session:", err);
  }
}

/**
 * Send a message in a chat session
 */
async function sendChatMessage(sessionId: string) {
  const session = sessions.get(sessionId);
  const chatSession = chatSessions.get(sessionId);
  if (!session || !chatSession) return;

  let message = chatSession.inputEl.value.trim();

  // Expand pasted text placeholders
  for (const block of chatSession.pastedTextBlocks) {
    const placeholder = `[Pasted text #${block.id} +${block.lineCount} lines]`;
    message = message.replace(placeholder, block.text);
  }

  // Allow sending if there's text OR images attached
  if (!message && chatSession.pendingImages.length === 0) return;

  // Handle slash commands
  if (message.startsWith("/")) {
    const handled = await handleSlashCommand(sessionId, message);
    if (handled) {
      chatSession.inputEl.value = "";
      chatSession.inputEl.style.height = "auto";
      return;
    }
    // If not handled, send as regular message (Claude may handle it)
  }

  // Clear input and pasted text blocks
  chatSession.inputEl.value = "";
  chatSession.inputEl.style.height = "auto";
  chatSession.pastedTextBlocks = [];

  // Add user message to UI
  addChatMessage(sessionId, { type: "user", result: message });

  // Show thinking indicator and reset stats
  chatSession.isProcessing = true;
  chatSession.toolUseCount = 0;
  chatSession.streamingTokens = 0;
  chatSession.startTime = Date.now();
  chatSession.statusEl.textContent = "Starting...";
  chatSession.statusEl.className = "chat-status";
  const thinkingEl = chatSession.containerEl.querySelector(".chat-thinking") as HTMLElement;
  if (thinkingEl) thinkingEl.style.display = "flex";

  // Start session if not running
  if (!session.isRunning) {
    try {
      // Wait for the process-started event before continuing
      const processReady = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Process startup timed out"));
        }, 30000); // 30 second timeout for slow startup

        const unlisten = listen<{ session_id: string }>("json-process-started", (event) => {
          if (event.payload.session_id === sessionId) {
            clearTimeout(timeout);
            unlisten.then(fn => fn());
            resolve();
          }
        });

        const unlistenError = listen<{ session_id: string; error: string }>("json-process-error", (event) => {
          if (event.payload.session_id === sessionId) {
            clearTimeout(timeout);
            unlistenError.then(fn => fn());
            reject(new Error(event.payload.error));
          }
        });
      });

      await startJsonProcess(session);
      await processReady;
    } catch (err) {
      console.error("Failed to start session:", err);
      const errMsg = err instanceof Error ? err.message : String(err);
      chatSession.statusEl.textContent = `Start failed: ${errMsg}`;
      chatSession.statusEl.className = "chat-status error";
      chatSession.isProcessing = false;
      if (thinkingEl) thinkingEl.style.display = "none";
      return;
    }
  }

  chatSession.statusEl.textContent = "Thinking...";

  // Build message content - either string or array with images
  let messageContent: string | Array<{type: string; text?: string; source?: {type: string; media_type: string; data: string}}>;

  if (chatSession.pendingImages.length > 0) {
    // Build content array with images and text
    messageContent = [];
    for (const img of chatSession.pendingImages) {
      messageContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType,
          data: img.base64Data,
        }
      });
    }
    if (message) {
      messageContent.push({ type: "text", text: message });
    }
    // Clear attachments
    chatSession.pendingImages = [];
    chatSession.attachmentsEl.innerHTML = "";
  } else {
    messageContent = message;
    // Clear any text paste preview
    chatSession.attachmentsEl.innerHTML = "";
  }

  // Send to process stdin as JSON
  // Format: {"type":"user","message":{"role":"user","content":"..."}}
  const jsonMessage = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: messageContent,
    }
  }) + "\n";

  try {
    await invoke("write_to_process", { sessionId, data: jsonMessage });
  } catch (err) {
    console.error("Failed to send message:", err);
    const errMsg = err instanceof Error ? err.message : String(err);
    chatSession.statusEl.textContent = `Send failed: ${errMsg}`;
    chatSession.statusEl.className = "chat-status error";
    chatSession.isProcessing = false;
    if (thinkingEl) thinkingEl.style.display = "none";
  }
}

/**
 * Paste image from clipboard (Ctrl+V)
 */
async function pasteImageFromClipboard(sessionId: string) {
  const chatSession = chatSessions.get(sessionId);
  if (!chatSession) return;

  try {
    const clipboardItems = await navigator.clipboard.read();
    for (const item of clipboardItems) {
      // Find image type
      const imageType = item.types.find(t => t.startsWith("image/"));
      if (imageType) {
        const blob = await item.getType(imageType);
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64Match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (!base64Match) return;

          const mediaType = base64Match[1];
          const base64Data = base64Match[2];

          // Create preview element
          const previewEl = document.createElement("div");
          previewEl.className = "attachment-preview";
          previewEl.innerHTML = `
            <img src="${dataUrl}" alt="Attached image" />
            <button class="attachment-remove" title="Remove">×</button>
          `;

          // Remove button handler
          const removeBtn = previewEl.querySelector(".attachment-remove")!;
          removeBtn.addEventListener("click", () => {
            const idx = chatSession.pendingImages.findIndex(img => img.previewEl === previewEl);
            if (idx >= 0) {
              chatSession.pendingImages.splice(idx, 1);
            }
            previewEl.remove();
          });

          chatSession.attachmentsEl.appendChild(previewEl);
          chatSession.pendingImages.push({ mediaType, base64Data, previewEl });

          // Focus the input
          chatSession.inputEl.focus();
        };
        reader.readAsDataURL(blob);
      }
    }
  } catch (err) {
    console.error("Failed to read clipboard:", err);
  }
}

/**
 * Format tool call for display based on tool type
 * Makes common tools more readable (Read, Edit, Bash, etc.)
 */
function formatToolCall(toolName: string, input: Record<string, unknown>, cwd: string): string {
  const escapeForHtml = (str: string) => {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  };

  // Helper to make paths relative to cwd
  const relativePath = (fullPath: string) => {
    if (cwd && fullPath.startsWith(cwd)) {
      const rel = fullPath.slice(cwd.length);
      return rel.startsWith("/") ? rel.slice(1) : rel;
    }
    return fullPath;
  };

  switch (toolName) {
    case "Read": {
      const filePath = input.file_path as string || "";
      const relPath = relativePath(filePath);
      let details = "";
      if (input.offset || input.limit) {
        const parts = [];
        if (input.offset) parts.push(`from line ${input.offset}`);
        if (input.limit) parts.push(`${input.limit} lines`);
        details = ` <span class="tool-detail">(${parts.join(", ")})</span>`;
      }
      return `<span class="tool-name">Read</span><span class="tool-path">${escapeForHtml(relPath)}</span>${details}`;
    }

    case "Edit": {
      const filePath = input.file_path as string || "";
      const relPath = relativePath(filePath);
      const oldStr = input.old_string as string || "";
      const newStr = input.new_string as string || "";
      const replaceAll = input.replace_all as boolean;

      // Generate a proper line-by-line diff
      let diffHtml = "";
      if (oldStr || newStr) {
        const oldLines = oldStr.split("\n");
        const newLines = newStr.split("\n");

        // Find common prefix lines
        let prefixLen = 0;
        while (prefixLen < oldLines.length && prefixLen < newLines.length &&
               oldLines[prefixLen] === newLines[prefixLen]) {
          prefixLen++;
        }

        // Find common suffix lines (but don't overlap with prefix)
        let suffixLen = 0;
        while (suffixLen < oldLines.length - prefixLen &&
               suffixLen < newLines.length - prefixLen &&
               oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]) {
          suffixLen++;
        }

        // Extract the changed portions
        const oldChanged = oldLines.slice(prefixLen, oldLines.length - suffixLen);
        const newChanged = newLines.slice(prefixLen, newLines.length - suffixLen);

        // Build diff HTML showing only changed lines with minimal context
        diffHtml = `<div class="tool-diff">`;
        const maxLines = 8;
        const truncateLine = (s: string) => s.length > 80 ? s.slice(0, 80) + "..." : s;

        // Show context indicator if there's unchanged prefix
        if (prefixLen > 0) {
          const contextLine = prefixLen === 1 ? oldLines[0] : `... ${prefixLen} unchanged lines ...`;
          diffHtml += `<div class="diff-context">  ${escapeForHtml(truncateLine(contextLine))}</div>`;
        }

        // Show removed lines
        const oldToShow = oldChanged.length > maxLines ? oldChanged.slice(0, maxLines) : oldChanged;
        for (const line of oldToShow) {
          diffHtml += `<div class="diff-old">- ${escapeForHtml(truncateLine(line))}</div>`;
        }
        if (oldChanged.length > maxLines) {
          diffHtml += `<div class="diff-old">- ... ${oldChanged.length - maxLines} more lines removed</div>`;
        }

        // Show added lines
        const newToShow = newChanged.length > maxLines ? newChanged.slice(0, maxLines) : newChanged;
        for (const line of newToShow) {
          diffHtml += `<div class="diff-new">+ ${escapeForHtml(truncateLine(line))}</div>`;
        }
        if (newChanged.length > maxLines) {
          diffHtml += `<div class="diff-new">+ ... ${newChanged.length - maxLines} more lines added</div>`;
        }

        // Show context indicator if there's unchanged suffix
        if (suffixLen > 0) {
          const contextLine = suffixLen === 1 ? oldLines[oldLines.length - 1] : `... ${suffixLen} unchanged lines ...`;
          diffHtml += `<div class="diff-context">  ${escapeForHtml(truncateLine(contextLine))}</div>`;
        }

        diffHtml += `</div>`;
      }

      const replaceNote = replaceAll ? ` <span class="tool-detail">(replace all)</span>` : "";

      // Add expand button if there's actual diff content
      let expandBtn = "";
      if (oldStr || newStr) {
        // Encode the strings as base64 to safely embed in data attributes
        const oldB64 = btoa(unescape(encodeURIComponent(oldStr)));
        const newB64 = btoa(unescape(encodeURIComponent(newStr)));
        expandBtn = `<button class="diff-expand-btn" data-path="${escapeForHtml(relPath)}" data-old="${oldB64}" data-new="${newB64}" title="View full diff">⤢</button>`;
      }

      return `<span class="tool-name">Edit</span><span class="tool-path">${escapeForHtml(relPath)}</span>${replaceNote}${expandBtn}${diffHtml}`;
    }

    case "Write": {
      const filePath = input.file_path as string || "";
      const relPath = relativePath(filePath);
      const content = input.content as string || "";
      const lineCount = content.split("\n").length;
      return `<span class="tool-name">Write</span><span class="tool-path">${escapeForHtml(relPath)}</span><span class="tool-detail">(${lineCount} lines)</span>`;
    }

    case "Bash": {
      const command = input.command as string || "";
      const description = input.description as string || "";
      const timeout = input.timeout as number;
      const background = input.run_in_background as boolean;

      let html = `<span class="tool-name">Bash</span>`;
      if (description) {
        html += `<span class="tool-desc">${escapeForHtml(description)}</span>`;
      }
      html += `<pre class="tool-command">${escapeForHtml(command)}</pre>`;

      const flags = [];
      if (background) flags.push("background");
      if (timeout) flags.push(`timeout: ${Math.round(timeout / 1000)}s`);
      if (flags.length > 0) {
        html += `<span class="tool-detail">(${flags.join(", ")})</span>`;
      }
      return html;
    }

    case "Glob":
    case "Grep": {
      const pattern = input.pattern as string || "";
      const path = input.path as string;
      let pathInfo = "";
      if (path) {
        pathInfo = ` in ${escapeForHtml(relativePath(path))}`;
      }
      return `<span class="tool-name">Search</span><code class="tool-pattern">${escapeForHtml(pattern)}</code>${pathInfo}`;
    }

    case "Task": {
      const description = input.description as string || "";
      const subagentType = input.subagent_type as string || "";
      const prompt = input.prompt as string || "";
      // Show Task with description as subtitle and truncated prompt preview
      let html = `<div class="tool-task">`;
      html += `<div class="tool-task-header"><span class="tool-name">Task</span><span class="tool-task-type">${escapeForHtml(subagentType)}</span></div>`;
      if (description) {
        html += `<div class="tool-task-desc">${escapeForHtml(description)}</div>`;
      }
      if (prompt) {
        const truncatedPrompt = prompt.length > 200 ? prompt.slice(0, 200) + "..." : prompt;
        html += `<div class="tool-task-prompt">${escapeForHtml(truncatedPrompt)}</div>`;
      }
      html += `</div>`;
      return html;
    }

    case "WebFetch": {
      const url = input.url as string || "";
      const prompt = input.prompt as string || "";
      return `<span class="tool-name">WebFetch</span><a href="${escapeForHtml(url)}" target="_blank" class="tool-url">${escapeForHtml(url)}</a><span class="tool-detail">${escapeForHtml(prompt.slice(0, 50))}${prompt.length > 50 ? "..." : ""}</span>`;
    }

    case "WebSearch": {
      const query = input.query as string || "";
      return `<span class="tool-name">WebSearch</span><span class="tool-query">"${escapeForHtml(query)}"</span>`;
    }

    default: {
      // Fall back to JSON for unknown tools
      const inputJson = JSON.stringify(input || {}, null, 2);
      return `<span class="tool-name">${escapeForHtml(toolName)}</span><span class="tool-input">${escapeForHtml(inputJson)}</span>`;
    }
  }
}

/**
 * Add a session event (resumed, stopped) to the chat
 */
function addSessionEvent(sessionId: string, eventType: "resumed" | "stopped") {
  const chatSession = chatSessions.get(sessionId);
  if (!chatSession) return;

  const timestamp = new Date().toLocaleTimeString();
  const eventText = eventType === "resumed" ? "Session resumed" : "Session stopped";

  // Create event message
  const eventMessage: ClaudeJsonMessage = {
    type: "system",
    subtype: eventType,
    result: `--- ${eventText} (${timestamp}) ---`,
  };

  chatSession.messages.push(eventMessage);

  // Render the event
  const eventEl = document.createElement("div");
  eventEl.className = "chat-message system session-event";
  eventEl.textContent = `--- ${eventText} (${timestamp}) ---`;
  chatSession.messagesEl.appendChild(eventEl);

  // Save messages
  saveChatMessages(sessionId);
}

/**
 * Add a message to the chat UI
 */
function addChatMessage(sessionId: string, message: ClaudeJsonMessage) {
  const chatSession = chatSessions.get(sessionId);
  if (!chatSession) return;

  // For init messages, only save the first one - ignore subsequent ones
  if (message.type === "system" && message.subtype === "init") {
    const hasInit = chatSession.messages.some(
      m => m.type === "system" && m.subtype === "init"
    );
    if (hasInit) {
      // Already have an init, ignore this one but still capture session_id
      if (message.session_id) {
        const session = sessions.get(sessionId);
        if (session) {
          session.claudeSessionId = message.session_id;
          saveSessionToDb(session);
        }
      }
      return; // Don't render or save duplicate init
    }
    // First init - insert at beginning
    chatSession.messages.unshift(message);
  } else {
    chatSession.messages.push(message);
  }

  const messageEl = document.createElement("div");
  messageEl.className = "chat-message";

  if (message.type === "user") {
    // Skip rendering user messages with empty/non-string content (e.g., tool_result messages)
    // but still save them to preserve history
    if (typeof message.result !== "string" || !message.result.trim()) {
      saveChatMessages(sessionId);
      return;
    }
    messageEl.classList.add("user");
    messageEl.textContent = message.result;
  } else if (message.type === "assistant" && message.message?.content) {
    messageEl.classList.add("assistant");
    // Render assistant content and count tool uses
    const content = message.message.content;
    let html = "";
    let hasToolUse = false;
    for (const block of content) {
      if (block.type === "text" && block.text) {
        // Render markdown to HTML
        const renderedMarkdown = marked.parse(block.text) as string;
        html += `<div>${renderedMarkdown}</div>`;
      } else if (block.type === "tool_use") {
        hasToolUse = true;
        chatSession.toolUseCount++;
        messageEl.classList.remove("assistant");
        messageEl.classList.add("tool-use");

        // Special handling for TodoWrite - update the todo panel
        if (block.name === "TodoWrite") {
          const input = block.input as { todos?: TodoItem[] };
          if (input.todos && Array.isArray(input.todos)) {
            chatSession.todos = input.todos;
            renderTodosPanel(chatSession);
          }
          // Don't show TodoWrite in the message stream - it's shown in the panel
          continue;
        }

        // Format tool call with special handling for known tools
        const formattedTool = formatToolCall(block.name || "Tool", (block.input || {}) as Record<string, unknown>, chatSession.cwd);
        html += `<div class="tool-call">${formattedTool}</div>`;
      }
    }

    // Add token usage details if available
    const usage = message.message?.usage;
    if (usage) {
      const tokenParts: string[] = [];
      if (usage.input_tokens) tokenParts.push(`in: ${usage.input_tokens}`);
      if (usage.cache_read_input_tokens) tokenParts.push(`cache read: ${usage.cache_read_input_tokens}`);
      if (usage.cache_creation_input_tokens) tokenParts.push(`cache write: ${usage.cache_creation_input_tokens}`);
      if (usage.output_tokens) tokenParts.push(`out: ${usage.output_tokens}`);
      if (tokenParts.length > 0) {
        html += `<div class="token-usage">${tokenParts.join(" • ")}</div>`;
      }
    }

    messageEl.innerHTML = html || "(empty response)";

    // Update streaming status
    if (chatSession.isProcessing && chatSession.startTime) {
      const elapsed = Math.round((Date.now() - chatSession.startTime) / 1000);
      const parts = ["Thinking..."];
      if (chatSession.toolUseCount > 0) {
        parts.push(`${chatSession.toolUseCount} tool${chatSession.toolUseCount > 1 ? "s" : ""}`);
      }
      parts.push(`${elapsed}s`);
      chatSession.statusEl.textContent = parts.join(" · ");
    }
  } else if (message.type === "result") {
    // Only show result messages if they're errors - normal results duplicate the assistant message
    if (message.is_error && message.result) {
      messageEl.classList.add("tool-result", "error");
      messageEl.innerHTML = `<pre><code>${escapeHtml(message.result)}</code></pre>`;
    } else {
      // Skip rendering non-error results (they just duplicate assistant content)
      return;
    }
  } else if (message.type === "system" && message.subtype === "init") {
    messageEl.classList.add("system", "init-details");
    // Build detailed init message
    const details: string[] = [];
    if (message.model) details.push(message.model);
    if (message.cwd) details.push(message.cwd);

    const meta: string[] = [];
    if (message.permissionMode) meta.push(`permissions: ${message.permissionMode}`);
    if (message.claude_code_version) meta.push(`CC v${message.claude_code_version}`);
    if (message.session_id) meta.push(`session: ${message.session_id}`);

    messageEl.innerHTML = `
      <div class="init-header">Session initialized</div>
      <div class="init-main">${details.join(" • ")}</div>
      ${meta.length > 0 ? `<div class="init-meta">${meta.join(" • ")}</div>` : ""}
    `;

    // Capture session_id and cwd from init message
    if (message.session_id) {
      const session = sessions.get(sessionId);
      if (session) {
        session.claudeSessionId = message.session_id;
        session.hasBeenStarted = true;
        saveSessionToDb(session);
      }
    }
    // Store cwd for relative path display in tool calls
    if (message.cwd) {
      chatSession.cwd = message.cwd;
    }

    // Insert or update init message at the very beginning
    const existingInit = chatSession.messagesEl.querySelector(".init-details") as HTMLElement;
    if (existingInit) {
      // Update existing placeholder with real init data
      existingInit.innerHTML = messageEl.innerHTML;
    } else {
      // No init yet - insert at the beginning
      const firstChild = chatSession.messagesEl.firstChild;
      if (firstChild) {
        chatSession.messagesEl.insertBefore(messageEl, firstChild);
      } else {
        chatSession.messagesEl.appendChild(messageEl);
      }
    }
    // Save init message so it persists across restarts
    saveChatMessages(sessionId);
    return;
  } else if (message.type === "system" && message.result) {
    // Plain system messages (e.g., from slash commands)
    messageEl.classList.add("system");
    // Render markdown
    const renderedMarkdown = marked.parse(message.result) as string;
    messageEl.innerHTML = renderedMarkdown;
  } else {
    // Skip rendering other message types but still save
    saveChatMessages(sessionId);
    return;
  }

  // Check if at bottom before appending (for smart scroll)
  const wasAtBottom = isChatAtBottom(chatSession.messagesEl);

  chatSession.messagesEl.appendChild(messageEl);

  // Only auto-scroll if was already at bottom (or user message)
  if (wasAtBottom || message.type === "user") {
    // Use requestAnimationFrame to ensure DOM is painted before scrolling
    requestAnimationFrame(() => {
      chatSession.messagesEl.scrollTop = chatSession.messagesEl.scrollHeight;
    });
  }

  // Save messages after every message for safety
  saveChatMessages(sessionId);
}

/**
 * Process incoming JSON data for a chat session
 */
function processChatOutput(sessionId: string, data: string) {
  const chatSession = chatSessions.get(sessionId);
  if (!chatSession) return;

  // Add to buffer and process complete lines
  chatSession.inputBuffer += data;

  const lines = chatSession.inputBuffer.split("\n");
  // Keep last incomplete line in buffer
  chatSession.inputBuffer = lines.pop() || "";

  for (let line of lines) {
    if (!line.trim()) continue;

    // Strip iTerm2 shell integration escape codes that may prefix the JSON
    // These look like: ]1337;RemoteHost=...]1337;CurrentDir=...{"type":...}
    const jsonStart = line.indexOf("{");
    if (jsonStart > 0) {
      line = line.substring(jsonStart);
    }

    try {
      const message = JSON.parse(line) as ClaudeJsonMessage;
      addChatMessage(sessionId, message);

      // Check if response is complete
      if (message.type === "result") {
        chatSession.isProcessing = false;
        const thinkingEl = chatSession.containerEl.querySelector(".chat-thinking") as HTMLElement;
        if (thinkingEl) thinkingEl.style.display = "none";

        // Update status with detailed usage info
        const parts: string[] = ["Done"];

        // Turns
        if (message.num_turns && message.num_turns > 1) {
          parts.push(`${message.num_turns} turns`);
        }

        // Tool uses
        if (chatSession.toolUseCount > 0) {
          parts.push(`${chatSession.toolUseCount} tool${chatSession.toolUseCount > 1 ? "s" : ""}`);
        }

        // Token breakdown from result
        const usage = message.usage;
        if (usage) {
          const tokenDetails: string[] = [];
          const totalIn = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
          if (totalIn > 0) tokenDetails.push(`${formatTokens(totalIn)} in`);
          if (usage.output_tokens) tokenDetails.push(`${formatTokens(usage.output_tokens)} out`);
          if (tokenDetails.length > 0) {
            parts.push(tokenDetails.join("/"));
          }
        }

        // Duration from API
        if (message.duration_ms) {
          const secs = (message.duration_ms / 1000).toFixed(1);
          parts.push(`${secs}s`);
        } else if (chatSession.startTime) {
          const elapsed = Math.round((Date.now() - chatSession.startTime) / 1000);
          parts.push(`${elapsed}s`);
        }

        // Cost
        if (message.total_cost_usd && message.total_cost_usd > 0) {
          parts.push(`$${message.total_cost_usd.toFixed(4)}`);
        }

        chatSession.statusEl.textContent = parts.join(" · ");
        chatSession.statusEl.className = "chat-status connected";
        chatSession.startTime = null;

        // Save all messages when response is complete
        saveChatMessages(sessionId);
      }
    } catch (err) {
      console.warn("Failed to parse JSON line:", line, err);
    }
  }
}

/**
 * Show chat session and hide terminal
 */
function showChatSession(sessionId: string) {
  // Hide all chat sessions
  chatContainerEl.querySelectorAll(".chat-session").forEach((el) => {
    (el as HTMLElement).classList.remove("active");
  });

  // Show the active one
  const chatSession = chatSessions.get(sessionId);
  if (chatSession) {
    chatSession.containerEl.classList.add("active");
    chatContainerEl.style.display = "flex";
    terminalContainerEl.style.display = "none";
    chatSession.inputEl.focus();
    // Scroll to bottom when opening session
    setTimeout(() => {
      chatSession.messagesEl.scrollTop = chatSession.messagesEl.scrollHeight;
    }, 50);
  }
}

/**
 * Check if chat is scrolled to bottom (within threshold)
 */
function isChatAtBottom(messagesEl: HTMLElement): boolean {
  const threshold = 50; // pixels from bottom to consider "at bottom"
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toString();
}

/**
 * Render the todos panel for a chat session
 */
function renderTodosPanel(chatSession: ChatSession): void {
  const { todosEl, todos } = chatSession;

  // Hide if no todos
  if (!todos || todos.length === 0) {
    todosEl.innerHTML = "";
    todosEl.style.display = "none";
    return;
  }

  todosEl.style.display = "block";

  // Count completed and find current task
  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.find((t) => t.status === "in_progress");
  const total = todos.length;

  // Build the HTML
  let html = `<div class="todos-header">
    <span class="todos-title">Tasks</span>
    <span class="todos-progress">${completed}/${total}</span>
  </div>`;

  // Show current task prominently if there is one
  if (inProgress) {
    html += `<div class="todo-current">
      <span class="todo-spinner"></span>
      <span class="todo-text">${escapeHtml(inProgress.activeForm || inProgress.content)}</span>
    </div>`;
  }

  // Collapsible list of all todos
  html += `<div class="todos-list">`;
  for (const todo of todos) {
    const statusClass = todo.status;
    const icon =
      todo.status === "completed"
        ? "✓"
        : todo.status === "in_progress"
          ? "◐"
          : "○";
    html += `<div class="todo-item ${statusClass}">
      <span class="todo-icon">${icon}</span>
      <span class="todo-content">${escapeHtml(todo.content)}</span>
    </div>`;
  }
  html += `</div>`;

  todosEl.innerHTML = html;
}

// Chat message persistence functions

/**
 * Save chat messages to the database (uses terminal_buffer table for storage)
 */
async function saveChatMessages(sessionId: string): Promise<void> {
  const chatSession = chatSessions.get(sessionId);
  if (!chatSession || chatSession.messages.length === 0) return;

  try {
    const bufferContent = JSON.stringify(chatSession.messages);
    await invoke("save_terminal_buffer", {
      sessionId,
      bufferContent,
    });
  } catch (err) {
    console.error("Failed to save chat messages:", err);
  }
}

/**
 * Load chat messages from the database and restore to UI
 */
async function loadChatMessages(sessionId: string, chatSession: ChatSession): Promise<void> {
  try {
    const bufferContent = await invoke<string | null>("load_terminal_buffer", { sessionId });
    if (bufferContent) {
      const messages = JSON.parse(bufferContent) as ClaudeJsonMessage[];

      // Find the most recent init message and filter out duplicates
      let latestInit: ClaudeJsonMessage | null = null;
      const nonInitMessages: ClaudeJsonMessage[] = [];

      for (const msg of messages) {
        if (msg.type === "system" && msg.subtype === "init") {
          latestInit = msg; // Keep the last one (most recent)
        } else {
          nonInitMessages.push(msg);
        }
      }

      // Add init first (if any), then other messages
      if (latestInit) {
        chatSession.messages.push(latestInit);
        renderChatMessage(chatSession, latestInit);

        // If session is missing claudeSessionId, extract it from the init message
        const session = sessions.get(sessionId);
        if (session && !session.claudeSessionId && latestInit.session_id) {
          session.claudeSessionId = latestInit.session_id;
          session.hasBeenStarted = true;
          saveSessionToDb(session);
          console.log(`[loadChatMessages] Recovered claudeSessionId from buffer: ${latestInit.session_id}`);
        }
      }

      for (const msg of nonInitMessages) {
        chatSession.messages.push(msg);
        renderChatMessage(chatSession, msg);
      }
    }
  } catch (err) {
    console.error("Failed to load chat messages:", err);
  }
}

/**
 * Render a single chat message to the UI (without adding to messages array)
 */
function renderChatMessage(chatSession: ChatSession, message: ClaudeJsonMessage): void {
  const messageEl = document.createElement("div");
  messageEl.className = "chat-message";

  if (message.type === "user") {
    // Skip user messages with empty content (e.g., tool_result messages)
    if (!message.result?.trim()) {
      return;
    }
    messageEl.classList.add("user");
    messageEl.textContent = message.result;
  } else if (message.type === "assistant" && message.message?.content) {
    messageEl.classList.add("assistant");
    const content = message.message.content;
    let html = "";
    for (const block of content) {
      if (block.type === "text" && block.text) {
        // Render markdown to HTML
        const renderedMarkdown = marked.parse(block.text) as string;
        html += `<div>${renderedMarkdown}</div>`;
      } else if (block.type === "tool_use") {
        messageEl.classList.remove("assistant");
        messageEl.classList.add("tool-use");

        // Special handling for TodoWrite - update the todo panel
        if (block.name === "TodoWrite") {
          const input = block.input as { todos?: TodoItem[] };
          if (input.todos && Array.isArray(input.todos)) {
            chatSession.todos = input.todos;
            renderTodosPanel(chatSession);
          }
          // Don't show TodoWrite in the message stream
          continue;
        }

        // Format tool call with special handling for known tools
        const formattedTool = formatToolCall(block.name || "Tool", (block.input || {}) as Record<string, unknown>, chatSession.cwd);
        html += `<div class="tool-call">${formattedTool}</div>`;
      }
    }
    messageEl.innerHTML = html || "(empty response)";
  } else if (message.type === "result") {
    if (message.is_error && message.result) {
      messageEl.classList.add("tool-result", "error");
      messageEl.innerHTML = `<pre><code>${escapeHtml(message.result)}</code></pre>`;
    } else {
      return; // Skip non-error results
    }
  } else if (message.type === "system" && message.subtype === "init") {
    messageEl.classList.add("system", "init-details");
    // Build detailed init message (same as live rendering)
    const details: string[] = [];
    if (message.model) details.push(message.model);
    if (message.cwd) details.push(message.cwd);

    const meta: string[] = [];
    if (message.permissionMode) meta.push(`permissions: ${message.permissionMode}`);
    if (message.claude_code_version) meta.push(`CC v${message.claude_code_version}`);
    if (message.session_id) meta.push(`session: ${message.session_id}`);

    messageEl.innerHTML = `
      <div class="init-header">Session initialized</div>
      <div class="init-main">${details.join(" • ")}</div>
      ${meta.length > 0 ? `<div class="init-meta">${meta.join(" • ")}</div>` : ""}
    `;

    // Insert init at the beginning, or update existing
    const existingInit = chatSession.messagesEl.querySelector(".init-details") as HTMLElement;
    if (existingInit) {
      existingInit.innerHTML = messageEl.innerHTML;
      return;
    } else {
      const firstChild = chatSession.messagesEl.firstChild;
      if (firstChild) {
        chatSession.messagesEl.insertBefore(messageEl, firstChild);
      } else {
        chatSession.messagesEl.appendChild(messageEl);
      }
      return;
    }
  } else if (message.type === "system" && (message.subtype === "resumed" || message.subtype === "stopped")) {
    // Session event (resumed/stopped) - use saved result which includes timestamp
    messageEl.classList.add("system", "session-event");
    messageEl.textContent = message.result || `--- Session ${message.subtype} ---`;
  } else {
    return; // Skip other message types
  }

  chatSession.messagesEl.appendChild(messageEl);
  // Note: Caller should handle scrolling (showChatSession scrolls to bottom when opening)
}

// Terminal buffer persistence functions

/**
 * Serialize and save the terminal buffer to the database.
 * This captures the entire scrollback buffer including all ANSI escape sequences.
 */
async function saveTerminalBuffer(session: Session): Promise<void> {
  if (!session.serializeAddon || !session.terminal) {
    return;
  }

  try {
    // Serialize the entire terminal buffer including scrollback
    const bufferContent = session.serializeAddon.serialize({
      scrollback: session.terminal.options.scrollback || 10000,
    });

    if (bufferContent && bufferContent.length > 0) {
      await invoke("save_terminal_buffer", {
        sessionId: session.id,
        bufferContent,
      });
    }
  } catch (err) {
    console.error("Failed to save terminal buffer:", err);
  }
}

/**
 * Delete terminal buffer from database when session is deleted.
 */
async function deleteTerminalBuffer(sessionId: string): Promise<void> {
  try {
    await invoke("delete_terminal_buffer", { sessionId });
  } catch (err) {
    console.error("Failed to delete terminal buffer:", err);
  }
}

/**
 * Save all active terminal buffers before app closes.
 * Call this on beforeunload or similar cleanup events.
 */
async function saveAllTerminalBuffers(): Promise<void> {
  const savePromises: Promise<void>[] = [];

  // Save xterm terminal buffers
  for (const session of sessions.values()) {
    if (session.terminal && session.serializeAddon) {
      savePromises.push(saveTerminalBuffer(session));
    }
  }

  // Save chat session messages
  for (const [sessionId, chatSession] of chatSessions.entries()) {
    if (chatSession.messages.length > 0) {
      savePromises.push(saveChatMessages(sessionId));
    }
  }

  await Promise.all(savePromises);
}

// Settings modal functions

async function showSettingsModal(): Promise<void> {
  // Populate settings form with current values
  settingsFontSizeInput.value = String(appSettings.font_size);
  settingsFontFamilySelect.value = appSettings.font_family;
  settingsThemeSelect.value = appSettings.theme;
  settingsDefaultWorkingDirInput.value = appSettings.default_working_dir;
  settingsDefaultAgentSelect.value = appSettings.default_agent_type;
  settingsNotificationsCheckbox.checked = appSettings.notifications_enabled;
  settingsBellNotificationsCheckbox.checked = appSettings.bell_notifications_enabled ?? true;
  settingsBounceDockCheckbox.checked = appSettings.bounce_dock_on_bell ?? true;
  settingsReadAloudCheckbox.checked = appSettings.read_aloud_enabled ?? false;
  settingsRendererSelect.value = appSettings.renderer || "webgl";
  settingsRemotePinInput.value = appSettings.remote_pin || "";

  // Show app version
  try {
    const version = await getVersion();
    document.getElementById("settings-app-version")!.textContent = version;
  } catch {
    document.getElementById("settings-app-version")!.textContent = "unknown";
  }

  // Clear update status
  document.getElementById("settings-update-status")!.textContent = "";

  settingsModal.classList.add("visible");
}

function hideSettingsModal(): void {
  settingsModal.classList.remove("visible");
}

async function saveSettings(): Promise<void> {
  appSettings = {
    font_size: parseInt(settingsFontSizeInput.value) || 13,
    font_family: settingsFontFamilySelect.value,
    theme: settingsThemeSelect.value,
    default_working_dir: settingsDefaultWorkingDirInput.value || DEFAULT_WORKING_DIR,
    default_agent_type: settingsDefaultAgentSelect.value || "claude",
    notifications_enabled: settingsNotificationsCheckbox.checked,
    bell_notifications_enabled: settingsBellNotificationsCheckbox.checked,
    bounce_dock_on_bell: settingsBounceDockCheckbox.checked,
    read_aloud_enabled: settingsReadAloudCheckbox.checked,
    renderer: settingsRendererSelect.value as "webgl" | "dom",
    remote_pin: settingsRemotePinInput.value || null,
  };

  try {
    await invoke("save_app_settings", { settings: appSettings });
  } catch (err) {
    console.error("Failed to save app settings:", err);
  }

  // Apply theme immediately
  await applyTheme();

  hideSettingsModal();
}

// Update checking
async function checkForUpdates(): Promise<void> {
  const statusEl = document.getElementById("settings-update-status")!;
  const button = document.getElementById("settings-check-update") as HTMLButtonElement;

  try {
    button.disabled = true;
    statusEl.textContent = "Checking for updates...";

    const update = await check();

    if (update) {
      statusEl.innerHTML = `Update available: <strong>v${update.version}</strong>`;

      // Replace button with install button
      button.textContent = "Download & Install";
      button.disabled = false;
      button.onclick = async () => {
        try {
          button.disabled = true;
          statusEl.textContent = "Downloading update...";

          // Download the update
          let downloaded = 0;
          let contentLength = 0;
          await update.downloadAndInstall((progress) => {
            if (progress.event === "Started") {
              contentLength = (progress.data as { contentLength?: number }).contentLength || 0;
              statusEl.textContent = `Downloading...`;
            } else if (progress.event === "Progress") {
              downloaded += progress.data.chunkLength;
              if (contentLength > 0) {
                const percent = Math.round((downloaded / contentLength) * 100);
                statusEl.textContent = `Downloading... ${percent}%`;
              }
            } else if (progress.event === "Finished") {
              statusEl.textContent = "Download complete. Restarting...";
            }
          });

          // Relaunch the app
          await relaunch();
        } catch (err) {
          console.error("Update install failed:", err);
          statusEl.textContent = `Install failed: ${err}`;
          button.disabled = false;
        }
      };
    } else {
      statusEl.textContent = "You're running the latest version.";
      button.disabled = false;
    }
  } catch (err) {
    console.error("Update check failed:", err);
    statusEl.textContent = `Check failed: ${err}`;
    button.disabled = false;
  }
}

// Diff modal functions

function showDiffModal(path: string, oldContent: string, newContent: string): void {
  const modal = document.getElementById("diff-modal")!;
  const pathEl = document.getElementById("diff-modal-path")!;
  const oldEl = document.getElementById("diff-old-content")!;
  const newEl = document.getElementById("diff-new-content")!;

  pathEl.textContent = path;

  // Compute line-by-line diff
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // Simple diff: find changed, added, and removed lines
  // Use LCS-style approach for better matching
  const diff = computeLineDiff(oldLines, newLines);

  // Render old content with highlighting
  let oldHtml = "";
  let newHtml = "";

  for (const change of diff) {
    if (change.type === "unchanged") {
      oldHtml += `<div class="diff-line unchanged">${escapeHtml(change.oldLine || "")}</div>`;
      newHtml += `<div class="diff-line unchanged">${escapeHtml(change.newLine || "")}</div>`;
    } else if (change.type === "removed") {
      oldHtml += `<div class="diff-line removed">${escapeHtml(change.oldLine || "")}</div>`;
      newHtml += `<div class="diff-line spacer"></div>`;
    } else if (change.type === "added") {
      oldHtml += `<div class="diff-line spacer"></div>`;
      newHtml += `<div class="diff-line added">${escapeHtml(change.newLine || "")}</div>`;
    } else if (change.type === "modified") {
      oldHtml += `<div class="diff-line removed">${escapeHtml(change.oldLine || "")}</div>`;
      newHtml += `<div class="diff-line added">${escapeHtml(change.newLine || "")}</div>`;
    }
  }

  oldEl.innerHTML = oldHtml || "(empty)";
  newEl.innerHTML = newHtml || "(empty)";

  modal.classList.add("visible");
}

interface DiffChange {
  type: "unchanged" | "added" | "removed" | "modified";
  oldLine?: string;
  newLine?: string;
}

function computeLineDiff(oldLines: string[], newLines: string[]): DiffChange[] {
  const changes: DiffChange[] = [];

  // Simple diff algorithm using longest common subsequence approach
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS matrix
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find the diff
  let i = m, j = n;
  const tempChanges: DiffChange[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      tempChanges.unshift({ type: "unchanged", oldLine: oldLines[i - 1], newLine: newLines[j - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      tempChanges.unshift({ type: "added", newLine: newLines[j - 1] });
      j--;
    } else {
      tempChanges.unshift({ type: "removed", oldLine: oldLines[i - 1] });
      i--;
    }
  }

  // Merge adjacent removed+added into modified where lines are similar
  for (let k = 0; k < tempChanges.length; k++) {
    const change = tempChanges[k];
    const next = tempChanges[k + 1];

    // Check if this is a removed followed by added (potential modification)
    if (change.type === "removed" && next?.type === "added") {
      changes.push({ type: "modified", oldLine: change.oldLine, newLine: next.newLine });
      k++; // Skip the next one
    } else {
      changes.push(change);
    }
  }

  return changes;
}

function hideDiffModal(): void {
  const modal = document.getElementById("diff-modal")!;
  modal.classList.remove("visible");
}

// About modal functions

async function showAboutModal(): Promise<void> {
  // Update version dynamically from Tauri
  try {
    const version = await getVersion();
    const versionEl = aboutModal.querySelector(".version");
    if (versionEl) {
      versionEl.textContent = `Version ${version}`;
    }
  } catch (err) {
    console.warn("Failed to get app version:", err);
  }
  aboutModal.classList.add("visible");
}

function hideAboutModal(): void {
  aboutModal.classList.remove("visible");
}

// Claude Sessions Browser Modal

interface ClaudeSessionInfo {
  session_id: string;
  modified: number;
  first_message: string;
  project: string;
}

async function showClaudeSessionsModal(): Promise<void> {
  const claudeSessionsModal = document.getElementById("claude-sessions-modal")!;
  const claudeSessionsList = document.getElementById("claude-sessions-list")!;

  claudeSessionsModal.classList.add("visible");
  claudeSessionsList.innerHTML = '<p class="loading">Loading sessions...</p>';

  // Get the active session's working directory
  let workingDir: string | null = null;
  if (activeSessionId) {
    const session = sessions.get(activeSessionId);
    if (session?.workingDir) {
      workingDir = session.workingDir;
    }
  }

  try {
    const sessions_list = await invoke<ClaudeSessionInfo[]>("list_claude_sessions", {
      workingDir,
    });

    if (sessions_list.length === 0) {
      claudeSessionsList.innerHTML = '<p class="no-sessions">No Claude sessions found for this project.</p>';
      return;
    }

    claudeSessionsList.innerHTML = "";
    for (const session of sessions_list) {
      const item = document.createElement("div");
      item.className = "claude-session-item";

      const date = new Date(session.modified * 1000);
      const dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString();

      item.innerHTML = `
        <div class="session-date">${escapeHtml(dateStr)}</div>
        <div class="session-preview">${escapeHtml(session.first_message || "(No preview)")}</div>
        <div class="session-id">${escapeHtml(session.session_id)}</div>
      `;

      item.addEventListener("click", () => {
        resumeClaudeSession(session.session_id, session.project);
      });

      claudeSessionsList.appendChild(item);
    }
  } catch (err) {
    console.error("Failed to load Claude sessions:", err);
    claudeSessionsList.innerHTML = `<p class="no-sessions">Error loading sessions: ${err}</p>`;
  }
}

function hideClaudeSessionsModal(): void {
  const claudeSessionsModal = document.getElementById("claude-sessions-modal")!;
  claudeSessionsModal.classList.remove("visible");
}

async function resumeClaudeSession(claudeSessionId: string, project: string): Promise<void> {
  hideClaudeSessionsModal();

  // Create a new Agent Hub session that resumes the Claude session
  const newSession: Session = {
    id: crypto.randomUUID(),
    name: `Resumed: ${claudeSessionId.substring(0, 8)}...`,
    agentType: "claude-json",
    command: `claude --print --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions`,
    workingDir: project,
    createdAt: new Date(),
    claudeSessionId: claudeSessionId,
    hasBeenStarted: true, // Mark as started since we're resuming an existing Claude session
    sortOrder: sessions.size,
    isRunning: false,
  };

  sessions.set(newSession.id, newSession);

  // Save to database
  const data: SessionData = {
    id: newSession.id,
    name: newSession.name,
    agent_type: newSession.agentType,
    command: newSession.command,
    working_dir: newSession.workingDir,
    created_at: newSession.createdAt.toISOString(),
    claude_session_id: newSession.claudeSessionId || null,
    sort_order: newSession.sortOrder,
  };
  await invoke("save_session", { session: data });

  renderSessionList();
  await switchToSession(newSession.id);

  // Load and display chat history from the Claude session file
  try {
    const history = await invoke<Array<Record<string, unknown>>>("load_claude_session_history", {
      sessionId: claudeSessionId,
      project: project,
    });

    if (history && history.length > 0) {
      for (const msg of history) {
        const msgType = msg.type as string;
        if (msgType === "user") {
          // User messages have message.content as a string
          const content = (msg.message as Record<string, unknown>)?.content as string;
          if (content) {
            const claudeMsg: ClaudeJsonMessage = {
              type: "user",
              result: content,
            };
            addChatMessage(newSession.id, claudeMsg);
          }
        } else if (msgType === "assistant") {
          // Assistant messages have full message structure
          const message = msg.message as ClaudeJsonMessage["message"];
          if (message) {
            const claudeMsg: ClaudeJsonMessage = {
              type: "assistant",
              message: message,
            };
            addChatMessage(newSession.id, claudeMsg);
          }
        }
      }
    }
  } catch (e) {
    console.warn("Could not load session history:", e);
  }
}

// Pairing modal functions

let pairingExpiryInterval: number | null = null;

function showPairingModal(code: string, deviceName?: string): void {
  const modal = document.getElementById("pairing-modal")!;
  const codeValue = document.getElementById("pairing-code-value")!;
  const deviceNameEl = modal.querySelector(".pairing-device-name") as HTMLElement;
  const expiresTime = document.getElementById("pairing-expires-time")!;

  // Set the code
  codeValue.textContent = code;

  // Set device name if provided
  if (deviceName) {
    deviceNameEl.textContent = `Request from "${deviceName}"`;
    deviceNameEl.style.display = "block";
  } else {
    deviceNameEl.style.display = "none";
  }

  // Start countdown (5 minutes)
  let secondsLeft = 300;
  if (pairingExpiryInterval) {
    clearInterval(pairingExpiryInterval);
  }

  const updateTimer = () => {
    const mins = Math.floor(secondsLeft / 60);
    const secs = secondsLeft % 60;
    expiresTime.textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
    secondsLeft--;
    if (secondsLeft < 0) {
      hidePairingModal();
    }
  };
  updateTimer();
  pairingExpiryInterval = window.setInterval(updateTimer, 1000);

  modal.classList.add("visible");
}

function hidePairingModal(): void {
  const modal = document.getElementById("pairing-modal")!;
  modal.classList.remove("visible");

  if (pairingExpiryInterval) {
    clearInterval(pairingExpiryInterval);
    pairingExpiryInterval = null;
  }
}

// Menu event handler

function handleMenuEvent(eventId: string): void {
  switch (eventId) {
    case "new_session":
      createQuickSession();
      break;
    case "close_session":
      if (activeSessionId) {
        closeSession(activeSessionId);
      }
      break;
    case "settings":
      showSettingsModal();
      break;
    case "toggle_sidebar":
      toggleSidebar();
      break;
    case "zoom_in":
      zoomIn();
      break;
    case "zoom_out":
      zoomOut();
      break;
    case "reset_zoom":
      resetZoom();
      break;
    case "rename_session":
      if (activeSessionId) {
        showEditSessionModal(activeSessionId);
      }
      break;
    case "duplicate_session":
      if (activeSessionId) {
        duplicateSession(activeSessionId);
      }
      break;
    case "reset_session_id":
      if (activeSessionId) {
        resetClaudeSessionId(activeSessionId);
      }
      break;
    case "next_session":
      cycleSessions("next");
      break;
    case "prev_session":
      cycleSessions("prev");
      break;
    case "browse_claude_sessions":
      showClaudeSessionsModal();
      break;
    case "about":
      showAboutModal();
      break;
    default:
      // Handle recently closed menu items (recent_0, recent_1, etc.)
      if (eventId.startsWith("recent_")) {
        const index = parseInt(eventId.replace("recent_", ""), 10);
        if (!isNaN(index)) {
          restoreRecentlyClosed(index);
        }
      }
  }
}

// Zoom functions

function zoomIn(): void {
  appSettings.font_size = Math.min(32, appSettings.font_size + 1);
  applyFontSettings();
  saveAppSettings();
}

function zoomOut(): void {
  appSettings.font_size = Math.max(8, appSettings.font_size - 1);
  applyFontSettings();
  saveAppSettings();
}

function resetZoom(): void {
  appSettings.font_size = 13;
  applyFontSettings();
  saveAppSettings();
}

function applyFontSettings(): void {
  sessions.forEach(session => {
    if (session.terminal) {
      session.terminal.options.fontSize = appSettings.font_size;
      session.terminal.options.fontFamily = appSettings.font_family;
      session.fitAddon?.fit();
    }
  });
}

// Sidebar toggle

let sidebarVisible = true;

function toggleSidebar(): void {
  sidebarVisible = !sidebarVisible;
  sidebarEl.classList.toggle("hidden", !sidebarVisible);
  sidebarResizeHandle.classList.toggle("hidden", !sidebarVisible);

  if (activeSessionId) {
    const session = sessions.get(activeSessionId);
    if (session?.fitAddon) {
      setTimeout(() => {
        session.fitAddon?.fit();
        if (session.terminal) {
          const ptyDims = getPtyDimensions(session.terminal.cols, session.terminal.rows);
          invoke("resize_pty", {
            sessionId: session.id,
            cols: ptyDims.cols,
            rows: ptyDims.rows,
          });
        }
      }, 100);
    }
  }
}

// Duplicate session

async function duplicateSession(sessionId: string): Promise<void> {
  const sourceSession = sessions.get(sessionId);
  if (!sourceSession) return;

  const minSortOrder = Math.min(0, ...Array.from(sessions.values()).map(s => s.sortOrder));

  // Generate a new Claude session ID for duplicated Claude sessions
  // This is a fresh session, not a resume of the original
  const claudeSessionId = sourceSession.agentType === "claude" ? crypto.randomUUID() : undefined;

  const newSession: Session = {
    id: crypto.randomUUID(),
    name: `${sourceSession.name} (Copy)`,
    agentType: sourceSession.agentType,
    command: sourceSession.command,
    workingDir: sourceSession.workingDir,
    createdAt: new Date(),
    isRunning: false,
    claudeSessionId,
    hasBeenStarted: false,
    sortOrder: minSortOrder - 1,
  };

  sessions.set(newSession.id, newSession);
  await saveSessionToDb(newSession);
  await switchToSession(newSession.id);
  renderSessionList();
}

// Window state and settings persistence

/**
 * Load window state from backend and apply it.
 */
async function loadWindowState(): Promise<void> {
  try {
    const state: WindowState = await invoke("load_window_state");

    // Apply sidebar width if saved
    if (state.sidebar_width && sidebarEl) {
      sidebarEl.style.width = `${state.sidebar_width}px`;
    }

    // Apply window size and position
    const win = getCurrentWindow();
    if (state.width && state.height) {
      await win.setSize(new LogicalSize(state.width, state.height));
    }
    if (state.x !== undefined && state.y !== undefined) {
      await win.setPosition(new LogicalPosition(state.x, state.y));
    }
  } catch (err) {
    console.error("Failed to load window state:", err);
  }
}

/**
 * Save the current window state to backend.
 */
async function saveWindowState(): Promise<void> {
  try {
    const win = getCurrentWindow();
    const size = await win.innerSize();
    const position = await win.outerPosition();
    const sidebarWidth = sidebarEl ? parseInt(sidebarEl.style.width) || sidebarEl.offsetWidth : 250;

    const state: WindowState = {
      width: size.width,
      height: size.height,
      x: position.x,
      y: position.y,
      sidebar_width: sidebarWidth,
    };

    await invoke("save_window_state", { state });
  } catch (err) {
    console.error("Failed to save window state:", err);
  }
}

/**
 * Load app settings from backend.
 */
async function loadAppSettings(): Promise<void> {
  try {
    const settings: AppSettings = await invoke("load_app_settings");
    appSettings = settings;
    await applyTheme();
  } catch (err) {
    console.error("Failed to load app settings:", err);
  }
}

/**
 * Save app settings to backend.
 */
async function saveAppSettings(): Promise<void> {
  try {
    await invoke("save_app_settings", { settings: appSettings });
  } catch (err) {
    console.error("Failed to save app settings:", err);
  }
}

/**
 * Get the effective theme (resolves "system" to actual theme).
 */
function getEffectiveTheme(): "dark" | "light" {
  if (appSettings.theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return appSettings.theme as "dark" | "light";
}

/**
 * Get terminal theme colors based on the current app theme.
 */
function getTerminalTheme(): object {
  const isDark = getEffectiveTheme() === "dark";

  if (isDark) {
    return {
      background: "#1a1a1a",
      foreground: "#e6e6e6",
      cursor: "#e6e6e6",
      cursorAccent: "#1a1a1a",
      selectionBackground: "#444444",
      black: "#000000",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#bbbbbb",
      brightBlack: "#555555",
      brightRed: "#ff5555",
      brightGreen: "#50fa7b",
      brightYellow: "#f1fa8c",
      brightBlue: "#bd93f9",
      brightMagenta: "#ff79c6",
      brightCyan: "#8be9fd",
      brightWhite: "#ffffff",
    };
  } else {
    // Light theme colors
    return {
      background: "#ffffff",
      foreground: "#1a1a1a",
      cursor: "#1a1a1a",
      cursorAccent: "#ffffff",
      selectionBackground: "#add6ff",
      black: "#000000",
      red: "#cd3131",
      green: "#00bc00",
      yellow: "#949800",
      blue: "#0451a5",
      magenta: "#bc05bc",
      cyan: "#0598bc",
      white: "#555555",
      brightBlack: "#666666",
      brightRed: "#cd3131",
      brightGreen: "#14ce14",
      brightYellow: "#b5ba00",
      brightBlue: "#0451a5",
      brightMagenta: "#bc05bc",
      brightCyan: "#0598bc",
      brightWhite: "#1a1a1a",
    };
  }
}

/**
 * Apply the current theme setting to the window and app.
 */
async function applyTheme(): Promise<void> {
  const win = getCurrentWindow();
  const effectiveTheme = getEffectiveTheme();

  // Set window theme (affects title bar on macOS)
  try {
    await win.setTheme(effectiveTheme as Theme);
  } catch (err) {
    console.error("Failed to set window theme:", err);
  }

  // Apply to document for CSS
  document.documentElement.setAttribute("data-theme", effectiveTheme);

  // Update all terminal themes
  const terminalTheme = getTerminalTheme();
  sessions.forEach(session => {
    if (session.terminal) {
      session.terminal.options.theme = terminalTheme;
    }
  });
}

// Listen for system theme changes
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (appSettings.theme === "system") {
    applyTheme();
  }
});

/**
 * Set up sidebar resize functionality.
 */
function setupSidebarResize(): void {
  if (!sidebarResizeHandle || !sidebarEl) {
    console.warn("Sidebar resize elements not found");
    return;
  }

  let startX: number;
  let startWidth: number;

  const onMouseDown = (e: MouseEvent) => {
    isResizingSidebar = true;
    startX = e.clientX;
    startWidth = sidebarEl.offsetWidth;

    document.body.classList.add("resizing-sidebar");
    sidebarResizeHandle.classList.add("resizing");

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!isResizingSidebar) return;

    const deltaX = e.clientX - startX;
    const newWidth = Math.min(Math.max(startWidth + deltaX, 150), 500);

    sidebarEl.style.width = `${newWidth}px`;

    // Refit the active terminal
    if (activeSessionId) {
      const session = sessions.get(activeSessionId);
      if (session?.fitAddon) {
        session.fitAddon.fit();
      }
    }
  };

  const onMouseUp = () => {
    if (!isResizingSidebar) return;

    isResizingSidebar = false;
    document.body.classList.remove("resizing-sidebar");
    sidebarResizeHandle.classList.remove("resizing");

    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);

    // Save the new sidebar width
    saveWindowState();

    // Final terminal fit
    if (activeSessionId) {
      const session = sessions.get(activeSessionId);
      if (session?.fitAddon && session.terminal) {
        session.fitAddon.fit();
        const ptyDims = getPtyDimensions(session.terminal.cols, session.terminal.rows);
        invoke("resize_pty", {
          sessionId: session.id,
          cols: ptyDims.cols,
          rows: ptyDims.rows,
        });
      }
    }
  };

  sidebarResizeHandle.addEventListener("mousedown", onMouseDown);
}

/**
 * Show a macOS notification.
 */
async function showNotification(title: string, body: string): Promise<void> {
  try {
    let permissionGranted = await isPermissionGranted();

    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === "granted";
    }

    if (permissionGranted) {
      sendNotification({ title, body });
    }
  } catch (err) {
    console.error("Failed to send notification:", err);
  }
}

// Save window state when window is resized or moved (debounced)
let saveWindowStateTimeout: number | null = null;
function debouncedSaveWindowState(): void {
  if (saveWindowStateTimeout) {
    clearTimeout(saveWindowStateTimeout);
  }
  saveWindowStateTimeout = window.setTimeout(() => {
    saveWindowState();
    saveWindowStateTimeout = null;
  }, 500);
}

// Listen for window resize to save state
window.addEventListener("resize", debouncedSaveWindowState);
