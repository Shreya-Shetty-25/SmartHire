import { useState, useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Navbar from './Navbar'
import Home from './pages/Home'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Dashboard from './pages/Dashboard'
import Candidates from './pages/Candidates'
import Hire from './pages/Hire'
import Assessment from './pages/Assessment'

function App() {
  const location = useLocation()
  const hideChrome = location.pathname.startsWith('/assessment')

  const [user, setUser] = useState(null)
  const [userRole, setUserRole] = useState(null) // 'admin' or 'candidate'
  const [loading, setLoading] = useState(true)

  // Check for existing token on mount
  useEffect(() => {
    const token = localStorage.getItem('token')
    const role = localStorage.getItem('userRole') || 'candidate'
    if (token) {
      setUser({ email: 'user' })
      setUserRole(role)
    }
    setLoading(false)
  }, [])

  const isAuthenticated = Boolean(user)
  const isAdmin = userRole === 'admin'

  const handleLogin = (payload) => {
    setUser({ email: payload.email })
    // Determine role: admin users have access to all pages
    // Candidates (default) can only access assessment, login, signup
    const role = payload.role || 'candidate'
    setUserRole(role)
    localStorage.setItem('userRole', role)
  }

  const handleSignup = (payload) => {
    setUser({ email: payload.email, name: payload.name })
    const role = payload.role || 'candidate'
    setUserRole(role)
    localStorage.setItem('userRole', role)
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('userRole')
    setUser(null)
    setUserRole(null)
  }

  const requireAdmin = (element) => {
    if (!isAuthenticated) {
      return <Navigate to="/login" replace />
    }
    if (!isAdmin) {
      return <Navigate to="/assessment" replace />
    }
    return element
  }

  if (loading) {
    return <div className="app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading...</div>
  }

  return (
    <div className="app-shell">
      {!hideChrome ? <Navbar isAuthenticated={isAuthenticated} isAdmin={isAdmin} onLogout={handleLogout} /> : null}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/assessment" element={<Assessment />} />
        <Route path="/assesment" element={<Navigate to="/assessment" replace />} />
        <Route path="/login" element={<Login onLogin={handleLogin} />} />
        <Route path="/signup" element={<Signup onSignup={handleSignup} />} />
        <Route path="/dashboard" element={requireAdmin(<Dashboard />)} />
        <Route path="/candidates" element={requireAdmin(<Candidates />)} />
        <Route path="/hire" element={requireAdmin(<Hire />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {!hideChrome ? <footer className="footer">SmartHire · Built for modern recruiting teams</footer> : null}
    </div>
  )
}

export default App
