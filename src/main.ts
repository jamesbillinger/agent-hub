import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalPosition, LogicalSize, type Theme } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

// Types
interface Session {
  id: string;
  name: string;
  agentType: "claude" | "codex" | "aider" | "shell" | "custom";
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
  renderer: "webgl" | "dom";
}

// State
const sessions: Map<string, Session> = new Map();
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
  renderer: "webgl",
};
let sidebarResizeHandle: HTMLElement;
let sidebarEl: HTMLElement;
let isResizingSidebar = false;

// Agent commands
const AGENT_COMMANDS: Record<string, string> = {
  claude: "claude --dangerously-skip-permissions",
  codex: "codex --full-auto",
  aider: "aider",
  shell: "$SHELL",
  custom: "",
};

// Default working directory
const DEFAULT_WORKING_DIR = "~/dev/pplsi";

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
let settingsRendererSelect: HTMLSelectElement;

// Initialize app
document.addEventListener("DOMContentLoaded", async () => {
  // Get DOM elements
  sessionListEl = document.getElementById("session-list")!;
  terminalContainerEl = document.getElementById("terminal-container")!;
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
  settingsRendererSelect = document.getElementById("settings-renderer") as HTMLSelectElement;

  // Load window state and app settings
  await loadWindowState();
  await loadAppSettings();

  // Set up sidebar resize
  setupSidebarResize();

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

  // Close dropdown when clicking outside
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
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) hideSettingsModal();
  });

  // About modal event listeners
  document.getElementById("about-close")!.addEventListener("click", hideAboutModal);
  aboutModal.addEventListener("click", (e) => {
    if (e.target === aboutModal) hideAboutModal();
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
    const currentData = pendingWrites.get(sessionId) || "";
    pendingWrites.set(sessionId, currentData + event.payload.data);

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
    // Cmd+W to close current session
    if ((e.metaKey || e.ctrlKey) && e.key === "w") {
      e.preventDefault();
      if (activeSessionId) {
        closeSession(activeSessionId);
      }
    }
    // Cmd+B to toggle sidebar
    if ((e.metaKey || e.ctrlKey) && e.key === "b") {
      e.preventDefault();
      toggleSidebar();
    }
    // Escape to close modals
    if (e.key === "Escape") {
      if (settingsModal.classList.contains("visible")) {
        hideSettingsModal();
      } else if (aboutModal.classList.contains("visible")) {
        hideAboutModal();
      } else if (newSessionModal.classList.contains("visible")) {
        hideNewSessionModal();
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

  // Initial render
  renderSessionList();
  updateView();
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
    name: `Session ${sessions.size + 1}`,
    agentType: "claude",
    command: AGENT_COMMANDS.claude,
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

  // Generate a Claude session ID only for Claude sessions
  const claudeSessionId = agentType === "claude" ? crypto.randomUUID() : undefined;

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

async function switchToSession(sessionId: string) {
  // Hide current terminal if any
  if (activeSessionId) {
    const currentSession = sessions.get(activeSessionId);
    if (currentSession?.terminal) {
      currentSession.terminal.element?.parentElement?.classList.add("hidden");
    }
  }

  activeSessionId = sessionId;
  const session = sessions.get(sessionId);
  if (!session) return;

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

  updateView();
  updateStartBanner();
  renderSessionList();

  // Focus terminal after all view updates to ensure it receives keyboard input
  setTimeout(() => {
    session.terminal?.focus();
  }, 0);
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

  terminal.focus();
}

/**
 * Start the session process (spawn PTY).
 * Called when user explicitly starts a session or types in an inactive one.
 */
async function startSessionProcess(session: Session) {
  if (session.isRunning || !session.terminal) return;

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

async function closeSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Kill PTY
  invoke("kill_pty", { sessionId });

  // Remove terminal DOM
  const wrapper = terminalContainerEl.querySelector(`[data-session-id="${sessionId}"]`);
  if (wrapper) {
    session.terminal?.dispose();
    wrapper.remove();
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
    item.className = `session-item${session.id === activeSessionId ? " active" : ""}`;
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
  emptyStateEl.style.display = hasActiveSession ? "none" : "flex";
  terminalContainerEl.style.display = hasActiveSession ? "block" : "none";

  // Update terminal container to position properly
  if (hasActiveSession) {
    terminalContainerEl.style.position = "relative";
  }

  // Hide all terminal wrappers except active
  const wrappers = terminalContainerEl.querySelectorAll(".terminal-wrapper");
  wrappers.forEach((wrapper) => {
    const el = wrapper as HTMLElement;
    el.style.display = el.dataset.sessionId === activeSessionId ? "block" : "none";
  });
}

/**
 * Update the start banner visibility based on active session state.
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

  // Show banner if session is not running
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
    case "claude": return "Claude";
    case "aider": return "Aider";
    case "shell": return "Shell";
    case "custom": return "Custom";
    default: return agentType;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
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

  for (const session of sessions.values()) {
    if (session.terminal && session.serializeAddon) {
      savePromises.push(saveTerminalBuffer(session));
    }
  }

  await Promise.all(savePromises);
}

// Settings modal functions

function showSettingsModal(): void {
  // Populate settings form with current values
  settingsFontSizeInput.value = String(appSettings.font_size);
  settingsFontFamilySelect.value = appSettings.font_family;
  settingsThemeSelect.value = appSettings.theme;
  settingsDefaultWorkingDirInput.value = appSettings.default_working_dir;
  settingsDefaultAgentSelect.value = appSettings.default_agent_type;
  settingsNotificationsCheckbox.checked = appSettings.notifications_enabled;
  settingsRendererSelect.value = appSettings.renderer || "webgl";
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
    renderer: settingsRendererSelect.value as "webgl" | "dom",
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

// About modal functions

function showAboutModal(): void {
  aboutModal.classList.add("visible");
}

function hideAboutModal(): void {
  aboutModal.classList.remove("visible");
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
    case "next_session":
      cycleSessions("next");
      break;
    case "prev_session":
      cycleSessions("prev");
      break;
    case "about":
      showAboutModal();
      break;
    default:
      // Unknown menu event - ignore silently
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
