import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { auth } from '../api'

function Login({ onLogin }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [role, setRole] = useState('candidate')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!email || !password) {
      setError('Please enter your email and password to continue.')
      return
    }
    setError('')
    setLoading(true)
    try {
      const data = await auth.login(email, password)
      localStorage.setItem('token', data.access_token)
      onLogin({ email, role })
      navigate(role === 'admin' ? '/dashboard' : '/assessment')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="main">
      <section className="auth-page">
        <div className="auth-card" aria-label="Login form">
          <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: '0.75rem' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
            <h1 className="auth-title">Welcome back</h1>
            <p className="auth-subtitle" style={{ marginBottom: 0 }}>Log in to access your SmartHire workspace.</p>
          </div>

          {error ? <div className="error-text">{error}</div> : null}

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label className="label" htmlFor="email">Work email</label>
              <input id="email" type="email" className="input" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
            </div>
            <div className="field">
              <label className="label" htmlFor="password">Password</label>
              <div style={{ position: 'relative' }}>
                <input id="password" type={showPassword ? 'text' : 'password'} className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" style={{ paddingRight: '2.75rem' }} />
                <button type="button" onClick={() => setShowPassword(!showPassword)} style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: '0.78rem', fontWeight: 550 }}>{showPassword ? 'Hide' : 'Show'}</button>
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="role">Login as</label>
              <select id="role" className="input" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="candidate">Candidate</option>
                <option value="admin">Admin / Recruiter</option>
              </select>
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '0.5rem' }} disabled={loading}>
              {loading ? 'Signing in…' : 'Continue'}
            </button>
          </form>

          <div className="auth-footer">
            <span>New to SmartHire? </span>
            <Link to="/signup">Create an account</Link>
          </div>
        </div>
      </section>
    </main>
  )
}

export default Login
