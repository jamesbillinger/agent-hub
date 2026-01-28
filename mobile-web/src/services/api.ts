import { useAuthStore } from '../stores/authStore';
import type { Session } from '../types';

class ApiService {
  private getHeaders(): HeadersInit {
    const token = useAuthStore.getState().authToken;
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...this.getHeaders(),
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.message || `Request failed: ${response.status}`);
    }

    return response.json();
  }

  // Auth endpoints
  async checkPinStatus(): Promise<{ pin_configured: boolean }> {
    return this.request('/api/auth/pin-status');
  }

  async requestPairing(): Promise<{ pairing_id: string; expires_in: number }> {
    return this.request('/api/auth/request-pairing', { method: 'POST' });
  }

  async completePairing(pairingId: string, code: string, deviceName: string): Promise<{ token: string; device_id: string }> {
    return this.request('/api/auth/pair', {
      method: 'POST',
      body: JSON.stringify({
        pairing_id: pairingId,
        code,
        device_name: deviceName,
      }),
    });
  }

  async loginWithPin(pin: string, deviceName: string): Promise<{ token: string; device_id: string }> {
    return this.request('/api/auth/pin-login', {
      method: 'POST',
      body: JSON.stringify({
        pin,
        device_name: deviceName,
      }),
    });
  }

  async checkAuth(): Promise<{ valid: boolean }> {
    return this.request('/api/auth/check');
  }

  // Session endpoints
  async getSessions(): Promise<Session[]> {
    return this.request('/api/sessions');
  }

  async createSession(name: string, workingDir: string): Promise<Session> {
    return this.request('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name,
        agent_type: 'claude-json',
        working_dir: workingDir,
      }),
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/api/sessions/${sessionId}`, { method: 'DELETE' });
  }

  async startSession(sessionId: string): Promise<{ status: string }> {
    return this.request(`/api/sessions/${sessionId}/start`, { method: 'POST' });
  }

  async interruptSession(sessionId: string): Promise<{ status: string }> {
    return this.request(`/api/sessions/${sessionId}/interrupt`, { method: 'POST' });
  }

  async getSessionBuffer(sessionId: string): Promise<{ buffer: string | null }> {
    return this.request(`/api/sessions/${sessionId}/buffer`);
  }
}

export const api = new ApiService();
