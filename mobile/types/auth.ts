export interface PairingRequest {
  pairing_id: string;
}

export interface PairingResponse {
  token: string;
}

export interface PinStatusResponse {
  enabled: boolean;
}

export interface PinLoginResponse {
  token: string;
}

export interface AuthCheckResponse {
  valid: boolean;
}
