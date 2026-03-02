import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { auth } from '../api'

function Login({ onLogin }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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
      onLogin({ email })
      navigate('/dashboard')
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
          <h1 className="auth-title">Welcome back</h1>
          <p className="auth-subtitle">Log in to access your SmartHire workspace.</p>

          {error ? <div className="error-text">{error}</div> : null}

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label className="label" htmlFor="email">
                Work email
              </label>
              <input
                id="email"
                type="email"
                className="input"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="input"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
              />
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '0.8rem' }} disabled={loading}>
              {loading ? 'Signing in...' : 'Continue'}
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
