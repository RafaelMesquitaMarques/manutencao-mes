import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Factory, Mail, AlertCircle, CheckCircle } from 'lucide-react';
import { forgotPassword } from '../api/auth';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await forgotPassword(email);
      setSent(true);
    } catch {
      setError('Something went wrong. Please try again.');
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
              <p className="text-gray-600 text-[11px] mt-1 leading-none">Reset your password</p>
            </div>
          </div>

          {sent ? (
            <div className="text-center py-4">
              <CheckCircle size={40} className="text-green-400 mx-auto mb-3" />
              <p className="text-white font-semibold mb-1">Check your email</p>
              <p className="text-gray-500 text-sm mb-5">
                If an account with that email exists, a reset link has been sent.
              </p>
              <Link to="/login" className="btn-primary w-full justify-center py-2.5 text-sm inline-flex items-center">
                Back to Login
              </Link>
            </div>
          ) : (
            <>
              <div className="mb-6">
                <h2 className="text-white text-xl font-semibold">Forgot password?</h2>
                <p className="text-gray-500 text-sm mt-1">
                  Enter your email and we'll send a reset link.
                </p>
              </div>

              {error && (
                <div className="mb-5 flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
                  <AlertCircle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="label">Email address</label>
                  <div className="relative">
                    <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="admin@foliot.com"
                      className="input-field pl-9"
                      required
                      disabled={loading}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading || !email}
                  className="btn-primary w-full justify-center py-2.5 mt-1 text-sm"
                >
                  {loading ? (
                    <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  ) : (
                    'Send reset link'
                  )}
                </button>
              </form>

              <p className="text-center mt-5">
                <Link to="/login" className="text-blue-400 text-sm hover:text-blue-300 transition-colors">
                  Back to Login
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
