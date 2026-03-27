import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { auth } from '../api'

function Signup({ onSignup }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [role, setRole] = useState('candidate')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!email || !password || !name) {
      setError('Fill in name, work email, and a password to continue.')
      return
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    setError('')
    setLoading(true)
    try {
      await auth.signup(email, password, name)
      const data = await auth.login(email, password)
      localStorage.setItem('token', data.access_token)
      onSignup({ email, name, role })
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
        <div className="auth-card" aria-label="Sign up form">
          <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: '0.75rem' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" />
              </svg>
            </div>
            <h1 className="auth-title">Create your account</h1>
            <p className="auth-subtitle" style={{ marginBottom: 0 }}>Set up SmartHire for your hiring team in minutes.</p>
          </div>

          {error ? <div className="error-text">{error}</div> : null}

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label className="label" htmlFor="name">Full name</label>
              <input id="name" type="text" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Recruiter" />
            </div>
            <div className="field">
              <label className="label" htmlFor="email">Work email</label>
              <input id="email" type="email" className="input" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
            </div>
            <div className="field">
              <label className="label" htmlFor="password">Password</label>
              <div style={{ position: 'relative' }}>
                <input id="password" type={showPassword ? 'text' : 'password'} className="input" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min. 6 characters" style={{ paddingRight: '2.75rem' }} />
                <button type="button" onClick={() => setShowPassword(!showPassword)} style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: '0.78rem', fontWeight: 550 }}>{showPassword ? 'Hide' : 'Show'}</button>
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="role">Sign up as</label>
              <select id="role" className="input" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="candidate">Candidate</option>
                <option value="admin">Admin / Recruiter</option>
              </select>
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '0.5rem' }} disabled={loading}>
              {loading ? 'Creating account…' : 'Create account'}
            </button>
          </form>

          <div className="auth-footer">
            <span>Already using SmartHire? </span>
            <Link to="/login">Log in</Link>
          </div>
        </div>
      </section>
    </main>
  )
}

export default Signup
