import { useState, useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Navbar from './Navbar'
import Home from './pages/Home'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Dashboard from './pages/Dashboard'
import Candidates from './pages/Candidates'
import Hire from './pages/Hire'
import Jobs from './pages/Jobs'
import Assessment from './pages/Assessment'
import AssessmentDetails from './pages/AssessmentDetails'

function App() {
  const location = useLocation()
  const hideChrome = location.pathname === '/assessment'

  const [user, setUser] = useState(null)
  const [userRole, setUserRole] = useState(null)
  const [userEmail, setUserEmail] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('token')
    const role = localStorage.getItem('userRole') || 'candidate'
    const email = localStorage.getItem('userEmail') || ''
    if (token) {
      setUser({ email: email || 'user' })
      setUserRole(role)
      setUserEmail(email)
    }
    setLoading(false)
  }, [])

  const isAuthenticated = Boolean(user)
  const isAdmin = userRole === 'admin'

  const handleLogin = (payload) => {
    setUser({ email: payload.email })
    const role = payload.role || 'candidate'
    setUserRole(role)
    setUserEmail(payload.email || '')
    localStorage.setItem('userRole', role)
    localStorage.setItem('userEmail', payload.email || '')
  }

  const handleSignup = (payload) => {
    setUser({ email: payload.email, name: payload.name })
    const role = payload.role || 'candidate'
    setUserRole(role)
    setUserEmail(payload.email || '')
    localStorage.setItem('userRole', role)
    localStorage.setItem('userEmail', payload.email || '')
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('userRole')
    localStorage.removeItem('userEmail')
    setUser(null)
    setUserRole(null)
    setUserEmail('')
  }

  const requireAdmin = (element) => {
    if (!isAuthenticated) return <Navigate to="/login" replace />
    if (!isAdmin) return <Navigate to="/assessment" replace />
    return element
  }

  if (loading) {
    return (
      <div className="app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
          <div className="brand-mark" style={{ width: 48, height: 48, margin: '0 auto 1rem', borderRadius: 14, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <p>Loading SmartHire…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      {!hideChrome ? <Navbar isAuthenticated={isAuthenticated} isAdmin={isAdmin} onLogout={handleLogout} userEmail={userEmail} /> : null}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/assessment" element={<Assessment />} />
        <Route path="/assesment" element={<Navigate to="/assessment" replace />} />
        <Route path="/assessment-details" element={requireAdmin(<AssessmentDetails />)} />
        <Route path="/login" element={<Login onLogin={handleLogin} />} />
        <Route path="/signup" element={<Signup onSignup={handleSignup} />} />
        <Route path="/dashboard" element={requireAdmin(<Dashboard />)} />
        <Route path="/candidates" element={requireAdmin(<Candidates />)} />
        <Route path="/jobs" element={requireAdmin(<Jobs />)} />
        <Route path="/hire" element={requireAdmin(<Hire />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {!hideChrome ? (
        <footer className="footer">
          <span style={{ fontWeight: 600 }}>SmartHire</span> · AI-powered recruitment platform
        </footer>
      ) : null}
    </div>
  )
}

export default App
