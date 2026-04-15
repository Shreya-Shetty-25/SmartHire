import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { auth } from '../api'

function EyeIcon({ open }) {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  )
}

function Signup({ onSignup }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!email || !password || !name) {
      setError('Please fill in all fields.')
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
      onSignup({ email, name, role: data.role || 'candidate' })
      navigate((data.role || 'candidate') === 'admin' ? '/dashboard' : '/')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="main">
      <section className="auth-page">
        <div className="auth-split">
          {/* Left banner */}
          <div className="auth-split-banner">
            <div className="auth-banner-logo">
              <div className="auth-banner-logo-mark">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                </svg>
              </div>
              SmartHire
            </div>
            <div className="auth-banner-body">
              <p className="auth-banner-title">Start your journey with SmartHire</p>
              <p className="auth-banner-sub">Create your candidate profile, apply for roles, and take AI-proctored assessments all in one place.</p>
              <div className="auth-banner-features">
                <div className="auth-banner-feat"><span className="auth-banner-feat-dot" />AI-matched job recommendations</div>
                <div className="auth-banner-feat"><span className="auth-banner-feat-dot" />Resume autofill from PDF upload</div>
                <div className="auth-banner-feat"><span className="auth-banner-feat-dot" />Track your application status live</div>
                <div className="auth-banner-feat"><span className="auth-banner-feat-dot" />Fair, automated assessment process</div>
              </div>
            </div>
          </div>

          {/* Right form */}
          <div className="auth-form-side">
            <div className="auth-icon-wrap">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>
              </svg>
            </div>
            <h1 className="auth-title">Create an account</h1>
            <p className="auth-subtitle">Join SmartHire as a candidate and start applying today.</p>

            {error ? <div className="error-text">{error}</div> : null}

            <form onSubmit={handleSubmit}>
              <div className="field">
                <label className="label" htmlFor="name">Full name</label>
                <input id="name" type="text" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Johnson" />
              </div>
              <div className="field">
                <label className="label" htmlFor="email">Email address</label>
                <input id="email" type="email" className="input" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <div className="field">
                <label className="label" htmlFor="password">Password</label>
                <div style={{ position: 'relative' }}>
                  <input id="password" type={showPassword ? 'text' : 'password'} className="input" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min. 6 characters" style={{ paddingRight: '2.75rem' }} />
                  <button type="button" className="password-toggle" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                    <EyeIcon open={showPassword} />
                  </button>
                </div>
              </div>
              <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '0.75rem' }} disabled={loading}>
                {loading ? 'Creating account...' : 'Create account'}
              </button>
            </form>

            <div className="auth-footer">
              <span>Already have an account? </span>
              <Link to="/login">Sign in</Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}

export default Signup