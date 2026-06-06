import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Factory, Lock, AlertCircle, CheckCircle } from 'lucide-react';
import { resetPassword } from '../api/auth';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (!token) { setError('Missing reset token. Please use the link from your email.'); return; }
    setError('');
    setLoading(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? 'Failed to reset password. The link may have expired.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0f1a] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="bg-[#0d1421]/90 border border-white/[0.08] rounded-2xl p-8 shadow-2xl">
          <div className="flex items-center gap-3.5 mb-8">
            <div className="w-11 h-11 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-600/30 flex-shrink-0">
              <Factory size={22} className="text-white" />
            </div>
            <div>
              <h1 className="text-white font-bold text-lg leading-none">Foliot MES</h1>
              <p className="text-gray-600 text-[11px] mt-1 leading-none">Set new password</p>
            </div>
          </div>

          {done ? (
            <div className="text-center py-4">
              <CheckCircle size={40} className="text-green-400 mx-auto mb-3" />
              <p className="text-white font-semibold mb-1">Password reset!</p>
              <p className="text-gray-500 text-sm mb-5">Your password has been updated successfully.</p>
              <button onClick={() => navigate('/login')} className="btn-primary w-full justify-center py-2.5 text-sm">
                Go to Login
              </button>
            </div>
          ) : (
            <>
              <div className="mb-6">
                <h2 className="text-white text-xl font-semibold">Set new password</h2>
                <p className="text-gray-500 text-sm mt-1">Choose a strong password for your account.</p>
              </div>

              {error && (
                <div className="mb-5 flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
                  <AlertCircle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="label">New password</label>
                  <div className="relative">
                    <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Min. 8 characters"
                      className="input-field pl-9"
                      required
                      disabled={loading}
                    />
                  </div>
                </div>
                <div>
                  <label className="label">Confirm password</label>
                  <div className="relative">
                    <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="••••••••"
                      className="input-field pl-9"
                      required
                      disabled={loading}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading || !password || !confirmPassword}
                  className="btn-primary w-full justify-center py-2.5 mt-1 text-sm"
                >
                  {loading ? (
                    <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  ) : (
                    'Reset password'
                  )}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
