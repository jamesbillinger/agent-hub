import { API_ENDPOINTS } from '../utils/constants';
import {
  PairingRequest,
  PairingResponse,
  PinStatusResponse,
  PinLoginResponse,
  AuthCheckResponse
} from '../types/auth';
import { Session, CreateSessionRequest, SessionListResponse } from '../types/session';

class ApiClient {
  private baseUrl: string = '';
  private authToken: string | null = null;

  setBaseUrl(url: string) {
    // Ensure URL doesn't end with /
    this.baseUrl = url.replace(/\/$/, '');
  }

  setAuthToken(token: string | null) {
    this.authToken = token;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.authToken) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorJson.message || errorMessage;
      } catch {
        if (errorText) {
          errorMessage = errorText;
        }
      }
      throw new Error(errorMessage);
    }

    const text = await response.text();
    if (!text) {
      return {} as T;
    }
    return JSON.parse(text);
  }

  // Auth endpoints
  async checkAuth(): Promise<AuthCheckResponse> {
    return this.request<AuthCheckResponse>(API_ENDPOINTS.AUTH_CHECK);
  }

  async requestPairing(): Promise<PairingRequest> {
    return this.request<PairingRequest>(API_ENDPOINTS.AUTH_REQUEST_PAIRING, {
      method: 'POST',
    });
  }

  async completePairing(
    pairingId: string,
    code: string,
    deviceName: string
  ): Promise<PairingResponse> {
    return this.request<PairingResponse>(API_ENDPOINTS.AUTH_PAIR, {
      method: 'POST',
      body: JSON.stringify({
        pairing_id: pairingId,
        code,
        device_name: deviceName,
      }),
    });
  }

  async getPinStatus(): Promise<PinStatusResponse> {
    return this.request<PinStatusResponse>(API_ENDPOINTS.AUTH_PIN_STATUS);
  }

  async loginWithPin(pin: string, deviceName: string): Promise<PinLoginResponse> {
    return this.request<PinLoginResponse>(API_ENDPOINTS.AUTH_PIN_LOGIN, {
      method: 'POST',
      body: JSON.stringify({ pin, device_name: deviceName }),
    });
  }

  // Session endpoints
  async getSessions(): Promise<Session[]> {
    const response = await this.request<SessionListResponse | Session[]>(API_ENDPOINTS.SESSIONS);
    // Handle both array response and object with sessions field
    if (Array.isArray(response)) {
      return response;
    }
    return response.sessions || [];
  }

  async createSession(data: CreateSessionRequest): Promise<Session> {
    return this.request<Session>(API_ENDPOINTS.SESSIONS, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async deleteSession(id: string): Promise<void> {
    return this.request<void>(`${API_ENDPOINTS.SESSIONS}/${id}`, {
      method: 'DELETE',
    });
  }

  async startSession(id: string): Promise<{ status: string }> {
    const result = await this.request<{ status: string }>(`${API_ENDPOINTS.SESSIONS}/${id}/start`, {
      method: 'POST',
    });
    console.log('startSession response:', result);
    return result;
  }

  async getSession(id: string): Promise<Session> {
    return this.request<Session>(`${API_ENDPOINTS.SESSIONS}/${id}`);
  }

  // WebSocket URL helper
  getWebSocketUrl(sessionId: string): string {
    const wsProtocol = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
    const host = this.baseUrl.replace(/^https?:\/\//, '');
    return `${wsProtocol}://${host}${API_ENDPOINTS.WS}/${sessionId}`;
  }
}

export const apiClient = new ApiClient();
