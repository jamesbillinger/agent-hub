import { useState } from 'react';
import { useAuthStore } from '../../stores';
import { api } from '../../services/api';

type AuthStep = 'connect' | 'pin' | 'pairing';

export function AuthFlow() {
  const [step, setStep] = useState<AuthStep>('connect');
  const [serverUrl, setServerUrl] = useState('');
  const [pin, setPin] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [pairingId, setPairingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const { setServerUrl: saveServerUrl, setAuthToken, setPinEnabled } = useAuthStore();

  const handleConnect = async () => {
    if (!serverUrl.trim()) return;

    setIsLoading(true);
    setError(null);

    try {
      // For now, just save the URL - in production we'd test the connection
      saveServerUrl(serverUrl.trim());

      // Check if PIN is configured
      const { pin_configured } = await api.checkPinStatus();
      setPinEnabled(pin_configured);

      if (pin_configured) {
        setStep('pin');
      } else {
        // Start pairing flow
        const { pairing_id } = await api.requestPairing();
        setPairingId(pairing_id);
        setStep('pairing');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePinLogin = async () => {
    if (!pin.trim()) return;

    setIsLoading(true);
    setError(null);

    try {
      const { token } = await api.loginWithPin(pin, 'Mobile Web');
      setAuthToken(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid PIN');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePairing = async () => {
    if (!pairingCode.trim() || !pairingId) return;

    setIsLoading(true);
    setError(null);

    try {
      const { token } = await api.completePairing(pairingId, pairingCode, 'Mobile Web');
      setAuthToken(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pairing failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <h1 className="text-2xl font-semibold text-center text-white">
          Connect to Agent Hub
        </h1>

        {step === 'connect' && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <button
                onClick={() => setStep('pin')}
                className="flex-1 py-3 px-4 bg-[#0e639c] text-white rounded-lg font-medium"
              >
                PIN
              </button>
              <button
                onClick={() => setStep('pairing')}
                className="flex-1 py-3 px-4 bg-[#0e639c] text-white rounded-lg font-medium"
              >
                Pairing Code
              </button>
            </div>

            <p className="text-sm text-gray-400 text-center">
              Enter your remote access PIN
            </p>

            <input
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="Server URL or PIN"
              className="w-full px-4 py-3 bg-[#3c3c3c] border border-[#3c3c3c] rounded-lg text-white text-center text-xl tracking-widest placeholder:text-gray-500 focus:outline-none focus:border-[#0e9fd8]"
            />

            <button
              onClick={handleConnect}
              disabled={isLoading || !serverUrl.trim()}
              className="w-full py-3 px-4 bg-[#0e639c] text-white rounded-lg font-medium disabled:opacity-50"
            >
              {isLoading ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        )}

        {step === 'pin' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-400 text-center">
              Enter your remote access PIN
            </p>

            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="PIN"
              className="w-full px-4 py-3 bg-[#3c3c3c] border border-[#3c3c3c] rounded-lg text-white text-center text-xl tracking-widest placeholder:text-gray-500 focus:outline-none focus:border-[#0e9fd8]"
              onKeyDown={(e) => e.key === 'Enter' && handlePinLogin()}
            />

            <button
              onClick={handlePinLogin}
              disabled={isLoading || !pin.trim()}
              className="w-full py-3 px-4 bg-[#0e639c] text-white rounded-lg font-medium disabled:opacity-50"
            >
              {isLoading ? 'Logging in...' : 'Login'}
            </button>

            <button
              onClick={() => setStep('connect')}
              className="w-full py-2 text-gray-400 text-sm"
            >
              Back
            </button>
          </div>
        )}

        {step === 'pairing' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-400 text-center">
              Enter the pairing code shown on your desktop
            </p>

            <input
              type="text"
              value={pairingCode}
              onChange={(e) => setPairingCode(e.target.value)}
              placeholder="Pairing Code"
              className="w-full px-4 py-3 bg-[#3c3c3c] border border-[#3c3c3c] rounded-lg text-white text-center text-xl tracking-widest placeholder:text-gray-500 focus:outline-none focus:border-[#0e9fd8]"
              onKeyDown={(e) => e.key === 'Enter' && handlePairing()}
            />

            <button
              onClick={handlePairing}
              disabled={isLoading || !pairingCode.trim()}
              className="w-full py-3 px-4 bg-[#0e639c] text-white rounded-lg font-medium disabled:opacity-50"
            >
              {isLoading ? 'Pairing...' : 'Pair Device'}
            </button>

            <button
              onClick={() => setStep('connect')}
              className="w-full py-2 text-gray-400 text-sm"
            >
              Back
            </button>
          </div>
        )}

        {error && (
          <p className="text-red-400 text-sm text-center">{error}</p>
        )}
      </div>
    </div>
  );
}
