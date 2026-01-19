export interface PairingRequest {
  pairing_id: string;
}

export interface PairingResponse {
  token: string;
}

export interface PinStatusResponse {
  pin_configured: boolean;
}

export interface PinLoginResponse {
  token: string;
}

export interface AuthCheckResponse {
  valid: boolean;
}
