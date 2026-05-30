import { useState, useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Navbar from './Navbar'
import Home from './pages/Home'
import CandidateHome from './pages/CandidateHome'
import Careers from './pages/Careers'
import Profile from './pages/Profile'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Dashboard from './pages/Dashboard'
import Candidates from './pages/Candidates'
import Hire from './pages/Hire'
import Jobs from './pages/Jobs'
import Assessment from './pages/Assessment'
import AssessmentDetails from './pages/AssessmentDetails'
import Departments from './pages/Departments'
import Requisitions from './pages/Requisitions'
import Refer from './pages/Refer'
import AdminReferrals from './pages/AdminReferrals'
import InterviewSchedule from './pages/InterviewSchedule'
import Offers from './pages/Offers'
import UserManagement from './pages/UserManagement'
import { auth, chat } from './api'
import ChatWidget from './ChatWidget'

function App() {
  const location = useLocation()
  const hideChrome = location.pathname === '/assessment'

  const [user, setUser] = useState(null)
  const [userRole, setUserRole] = useState(null)
  const [userEmail, setUserEmail] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      const token = localStorage.getItem('token')
      if (!token) {
        if (!cancelled) setLoading(false)
        return
      }

      try {
        const me = await auth.me(token)
        if (cancelled) return
        setUser({ email: me.email || 'user', name: me.full_name || '' })
        setUserRole(me.role || 'candidate')
        setUserEmail(me.email || '')
        localStorage.setItem('userRole', me.role || 'candidate')
        localStorage.setItem('userEmail', me.email || '')
        localStorage.setItem('userName', me.full_name || '')
      } catch {
        localStorage.removeItem('token')
        localStorage.removeItem('userRole')
        localStorage.removeItem('userEmail')
        if (!cancelled) {
          setUser(null)
          setUserRole(null)
          setUserEmail('')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void bootstrap()
    return () => { cancelled = true }
  }, [])

  const isAuthenticated = Boolean(user)
  const isStaff = ['admin', 'recruiter', 'hiring_manager', 'interviewer'].includes(userRole)
  const isAdmin = userRole === 'admin'
  const isDashboardPage = location.pathname === '/dashboard'
  const isJobsPage = location.pathname === '/jobs'
  const isCandidatesPage = location.pathname === '/candidates'

  const handleLogin = (payload) => {
    setUser({ email: payload.email })
    const role = payload.role || 'candidate'
    setUserRole(role)
    setUserEmail(payload.email || '')
    localStorage.setItem('userRole', role)
    localStorage.setItem('userEmail', payload.email || '')
    localStorage.setItem('userName', payload.name || payload.full_name || '')
  }

  const handleSignup = (payload) => {
    setUser({ email: payload.email, name: payload.name })
    const role = payload.role || 'candidate'
    setUserRole(role)
    setUserEmail(payload.email || '')
    localStorage.setItem('userRole', role)
    localStorage.setItem('userEmail', payload.email || '')
    localStorage.setItem('userName', payload.name || '')
  }

  const handleLogout = () => {
    void auth.logout().catch(() => null)
    localStorage.removeItem('token')
    localStorage.removeItem('userRole')
    localStorage.removeItem('userEmail')
    localStorage.removeItem('userName')
    setUser(null)
    setUserRole(null)
    setUserEmail('')
  }

  const requireStaff = (element) => {
    if (!isAuthenticated) return <Navigate to="/login" replace />
    if (!isStaff) return <Navigate to="/" replace />
    return element
  }

  const requireAdmin = (element) => {
    if (!isAuthenticated) return <Navigate to="/login" replace />
    if (!isAdmin) return <Navigate to="/" replace />
    return element
  }

  const requireCandidate = (element) => {
    if (!isAuthenticated) return <Navigate to="/login" replace />
    if (isStaff) return <Navigate to="/dashboard" replace />
    return element
  }

  const redirectAuthenticated = (element) => {
    if (!isAuthenticated) return element
    return <Navigate to={isStaff ? '/dashboard' : '/'} replace />
  }

  if (loading) {
    return (
      <div className="app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
          <div className="brand-mark" style={{ width: 48, height: 48, margin: '0 auto 1rem', borderRadius: 14, background: 'linear-gradient(135deg,#0e7490,#0d9488)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
      {!hideChrome ? <Navbar isAuthenticated={isAuthenticated} isAdmin={isAdmin} isStaff={isStaff} userRole={userRole} onLogout={handleLogout} userEmail={userEmail} /> : null}
      <Routes>
        <Route path="/" element={
          !isAuthenticated
            ? <Home />
            : isStaff
              ? <Navigate to="/dashboard" replace />
              : <CandidateHome />
        } />
        <Route path="/assessment" element={<Assessment />} />
        <Route path="/assesment" element={<Navigate to="/assessment" replace />} />
        {/* Careers is public — anyone can browse; auth required to apply */}
        <Route path="/careers" element={<Careers isAuthenticated={isAuthenticated} isStaff={isStaff} />} />
        <Route path="/profile" element={requireCandidate(<Profile />)} />
        <Route path="/assessment-details" element={requireStaff(<AssessmentDetails />)} />
        <Route path="/login" element={redirectAuthenticated(<Login onLogin={handleLogin} />)} />
        <Route path="/signup" element={redirectAuthenticated(<Signup onSignup={handleSignup} />)} />
        <Route path="/dashboard" element={requireAdmin(<Dashboard />)} />
        <Route path="/candidates" element={requireAdmin(<Candidates />)} />
        <Route path="/jobs" element={requireAdmin(<Jobs />)} />
        <Route path="/hire" element={requireAdmin(<Hire />)} />
        <Route path="/departments" element={requireAdmin(<Departments />)} />
        <Route path="/requisitions" element={requireAdmin(<Requisitions />)} />
        <Route path="/referrals" element={requireAdmin(<AdminReferrals />)} />
        <Route path="/refer" element={<Refer />} />
        <Route path="/dashboard" element={requireStaff(<Dashboard />)} />
        <Route path="/candidates" element={requireStaff(<Candidates />)} />
        <Route path="/jobs" element={requireStaff(<Jobs />)} />
        <Route path="/hire" element={requireStaff(<Hire />)} />
        <Route path="/interview-schedule" element={requireStaff(<InterviewSchedule />)} />
        <Route path="/offers" element={isAuthenticated ? <Offers /> : <Navigate to="/login" replace />} />
        <Route path="/user-management" element={requireAdmin(<UserManagement />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {!hideChrome ? (
        <footer className="footer">
          <span style={{ fontWeight: 600 }}>SmartHire</span> · AI-powered recruitment platform
        </footer>
      ) : null}
      {!hideChrome && isAuthenticated && isStaff && isJobsPage && (
        <ChatWidget
          sendMessage={chat.sendJobsMessage}
          title="Jobs Assistant"
          greeting={"Hi! I'm your jobs assistant. I can help you manage job postings only:\n\n- **Read jobs** and summarize openings\n- **Create jobs** from a role description\n- **Edit jobs** by ID or title\n- **Remove jobs** after confirmation\n\nWhat job task should we handle?"}
          placeholder="Ask about jobs, create/edit/remove a posting..."
          onAction={(action) => {
            if (['job_created', 'job_updated', 'job_deleted'].includes(action?.type)) {
              window.dispatchEvent(new CustomEvent('smarthire:refresh-jobs'))
            }
          }}
        />
      )}
      {!hideChrome && isAuthenticated && isStaff && isCandidatesPage && (
        <ChatWidget
          sendMessage={chat.sendCandidatesMessage}
          title="Candidates Assistant"
          greeting={"Hi! I can help you find candidate profiles by name.\n\nJust type a candidate's name, e.g.:\n- **Show Dhruvanshi Dave**\n- **Find John Smith**\n\nWho are you looking for?"}
          placeholder="Type a candidate name to look up…"
        />
      )}
      {!hideChrome && isAuthenticated && isStaff && !isDashboardPage && !isJobsPage && !isCandidatesPage && (
        <ChatWidget
          sendMessage={chat.sendAdminMessage}
          title="Staff Assistant"
          greeting={"Hi! I'm your SmartHire assistant. I can help you:\n\n- **Create job descriptions** — just describe the role\n- **Schedule interview calls** — for candidates who passed assessments\n- **Answer questions** about the platform\n\nWhat would you like to do?"}
          placeholder="Create a job, schedule interviews, or ask anything…"
          onAction={(action) => {
            if (action?.type === 'job_created') {
              window.dispatchEvent(new CustomEvent('smarthire:refresh-jobs'))
            }
          }}
        />
      )}
    </div>
  )
}

export default App
