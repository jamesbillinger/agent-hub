export const COLORS = {
  background: '#1a1a1a',
  backgroundSecondary: '#252526',
  backgroundTertiary: '#2d2d30',
  text: '#e6e6e6',
  textSecondary: '#a0a0a0',
  textMuted: '#6e6e6e',
  accent: '#0e639c',
  accentLight: '#1177bb',
  success: '#4caf50',
  error: '#f44336',
  warning: '#ff9800',
  border: '#3c3c3c',
  userBubble: '#0e639c',
  assistantBubble: '#252526',
  toolUse: '#2d2d30',
} as const;

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const FONT_SIZES = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 24,
  xxl: 32,
} as const;

export const DEFAULT_PORT = 3857;

export const STORAGE_KEYS = {
  SERVER_URL: 'server_url',
  AUTH_TOKEN: 'auth_token',
  DEVICE_ID: 'device_id',
} as const;

export const API_ENDPOINTS = {
  AUTH_CHECK: '/api/auth/check',
  AUTH_REQUEST_PAIRING: '/api/auth/request-pairing',
  AUTH_PAIR: '/api/auth/pair',
  AUTH_PIN_STATUS: '/api/auth/pin-status',
  AUTH_PIN_LOGIN: '/api/auth/pin-login',
  SESSIONS: '/api/sessions',
  WS: '/api/ws',
} as const;
