import { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Navbar from './Navbar'
import Home from './pages/Home'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Dashboard from './pages/Dashboard'
import Candidates from './pages/Candidates'
import Hire from './pages/Hire'

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  // Check for existing token on mount
  useEffect(() => {
    const token = localStorage.getItem('token')
    if (token) {
      // For now, just set a basic user object if token exists
      setUser({ email: 'user' })
    }
    setLoading(false)
  }, [])

  const isAuthenticated = Boolean(user)

  const handleLogin = (payload) => {
    setUser({ email: payload.email })
  }

  const handleSignup = (payload) => {
    setUser({ email: payload.email, name: payload.name })
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    setUser(null)
  }

  const requireAuth = (element) => {
    if (!isAuthenticated) {
      return <Navigate to="/login" replace />
    }
    return element
  }

  if (loading) {
    return <div className="app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading...</div>
  }

  return (
    <div className="app-shell">
      <Navbar isAuthenticated={isAuthenticated} onLogout={handleLogout} />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login onLogin={handleLogin} />} />
        <Route path="/signup" element={<Signup onSignup={handleSignup} />} />
        <Route path="/dashboard" element={requireAuth(<Dashboard />)} />
        <Route path="/candidates" element={requireAuth(<Candidates />)} />
        <Route path="/hire" element={requireAuth(<Hire />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <footer className="footer">SmartHire · Built for modern recruiting teams</footer>
    </div>
  )
}

export default App
