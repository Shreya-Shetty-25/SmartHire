import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { auth } from '../api'

function Signup({ onSignup }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
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
    
    setError('')
    setLoading(true)
    
    try {
      await auth.signup(email, password, name)
      // After signup, log them in automatically
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
          <h1 className="auth-title">Create your workspace</h1>
          <p className="auth-subtitle">Set up SmartHire for your hiring team in minutes.</p>

          {error ? <div className="error-text">{error}</div> : null}

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label className="label" htmlFor="name">
                Full name
              </label>
              <input
                id="name"
                type="text"
                className="input"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Alex Recruiter"
              />
            </div>
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
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Create a strong password"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="role">
                Sign up as
              </label>
              <select
                id="role"
                className="input"
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                <option value="candidate">Candidate</option>
                <option value="admin">Admin / Recruiter</option>
              </select>
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '0.8rem' }} disabled={loading}>
              {loading ? 'Creating...' : 'Create workspace'}
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
