import { useState, useEffect, useCallback } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { notifications as notifApi } from './api'

function LogoIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function MenuIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  )
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

function Navbar({ isAuthenticated, isAdmin, isStaff, userRole, onLogout, userEmail }) {
  const navigate = useNavigate()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [notifOpen, setNotifOpen] = useState(false)
  const [notifList, setNotifList] = useState([])

  const loadUnread = useCallback(async () => {
    if (!isAuthenticated) return
    try {
      const data = await notifApi.unreadCount()
      setUnreadCount(data?.unread_count || 0)
    } catch { /* silent */ }
  }, [isAuthenticated])

  useEffect(() => {
    loadUnread()
    const interval = setInterval(loadUnread, 30000)
    return () => clearInterval(interval)
  }, [loadUnread])

  const openNotifications = async () => {
    setNotifOpen(v => !v)
    if (!notifOpen) {
      try {
        const data = await notifApi.list({ limit: 10 })
        setNotifList(Array.isArray(data) ? data : [])
        await notifApi.markAllRead()
        setUnreadCount(0)
      } catch { /* silent */ }
    }
  }

  const handleLogout = () => {
    if (typeof onLogout === 'function') onLogout()
    else { localStorage.removeItem('token'); localStorage.removeItem('userRole') }
    navigate('/')
    setMobileOpen(false)
  }

  const closeMobile = () => setMobileOpen(false)

  const navLinks = (
    <>
      {isAuthenticated && isStaff ? (
        <>
          <NavLink to="/dashboard" className="nav-link" onClick={closeMobile}>Dashboard</NavLink>
          <NavLink to="/jobs" className="nav-link" onClick={closeMobile}>Jobs</NavLink>
          <NavLink to="/departments" className="nav-link" onClick={closeMobile}>Departments</NavLink>
          <NavLink to="/requisitions" className="nav-link" onClick={closeMobile}>Requisitions</NavLink>
          <NavLink to="/referrals" className="nav-link" onClick={closeMobile}>Referrals</NavLink>
          <NavLink to="/hire" className="nav-link" onClick={closeMobile}>Hire</NavLink>
          <NavLink to="/candidates" className="nav-link" onClick={closeMobile}>Candidates</NavLink>
          <NavLink to="/assessment-details" className="nav-link" onClick={closeMobile}>Assessments</NavLink>
          <NavLink to="/interview-schedule" className="nav-link" onClick={closeMobile}>Interviews</NavLink>
          <NavLink to="/offers" className="nav-link" onClick={closeMobile}>Offers</NavLink>
          {isAdmin && <NavLink to="/user-management" className="nav-link" onClick={closeMobile}>Users</NavLink>}
        </>
      ) : null}
      {isAuthenticated && !isStaff ? (
        <>
          <NavLink to="/" className="nav-link" onClick={closeMobile}>Home</NavLink>
          <NavLink to="/careers" className="nav-link" onClick={closeMobile}>Careers</NavLink>
          <NavLink to="/profile" className="nav-link" onClick={closeMobile}>Profile</NavLink>
          <NavLink to="/assessment" className="nav-link" onClick={closeMobile}>Take Assessment</NavLink>
          <NavLink to="/refer" className="nav-link" onClick={closeMobile}>Refer a Friend</NavLink>
          <NavLink to="/offers" className="nav-link" onClick={closeMobile}>My Offers</NavLink>
        </>
      ) : null}
      {!isAuthenticated ? (
        <>
          <NavLink to="/" className="nav-link" onClick={closeMobile}>Home</NavLink>
          <NavLink to="/refer" className="nav-link" onClick={closeMobile}>Refer a Friend</NavLink>
          <NavLink to="/careers" className="nav-link" onClick={closeMobile}>Careers</NavLink>
        </>
      ) : null}
    </>
  )

  const initial = userEmail ? userEmail.charAt(0).toUpperCase() : '?'

  const roleLabel = {
    admin: 'Admin',
    recruiter: 'Recruiter',
    hiring_manager: 'Hiring Manager',
    interviewer: 'Interviewer',
    candidate: 'Candidate',
  }[userRole] || ''

  return (
    <header className="navbar">
      <div className="nav-inner">
        <Link to={isAuthenticated && isStaff ? '/dashboard' : '/'} className="brand" aria-label="SmartHire home">
          <div className="brand-mark"><LogoIcon /></div>
          <div className="brand-title">Smart<span className="brand-accent">Hire</span></div>
        </Link>

        <nav className="nav-links" aria-label="Primary">{navLinks}</nav>

        <div className="nav-actions">
          {isAuthenticated ? (
            <>
              {/* Notification Bell */}
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={openNotifications}
                  style={{ position: 'relative', padding: '0.4rem' }}
                  aria-label="Notifications"
                >
                  <BellIcon />
                  {unreadCount > 0 && (
                    <span style={{
                      position: 'absolute', top: 0, right: 0,
                      background: '#e11d48', color: '#fff',
                      borderRadius: '999px', fontSize: '0.65rem',
                      minWidth: '16px', height: '16px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      padding: '0 3px',
                    }}>{unreadCount > 9 ? '9+' : unreadCount}</span>
                  )}
                </button>
                {notifOpen && (
                  <div style={{
                    position: 'absolute', right: 0, top: '110%',
                    width: 320, maxHeight: 400, overflowY: 'auto',
                    background: 'var(--surface)', border: '1px solid var(--border)',
                    borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
                    zIndex: 999, padding: '0.5rem 0',
                  }}>
                    <div style={{ padding: '0.5rem 1rem', fontWeight: 600, borderBottom: '1px solid var(--border)', marginBottom: '0.25rem' }}>
                      Notifications
                    </div>
                    {notifList.length === 0 ? (
                      <div style={{ padding: '1rem', color: 'var(--text-secondary)', textAlign: 'center' }}>No notifications yet</div>
                    ) : notifList.map(n => (
                      <div key={n.id} style={{
                        padding: '0.6rem 1rem',
                        background: n.is_read ? 'transparent' : 'rgba(14,116,144,0.06)',
                        borderBottom: '1px solid var(--border)',
                      }}>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{n.title}</div>
                        <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{n.message}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                          {new Date(n.created_at).toLocaleString()}
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ width: '100%', borderTop: '1px solid var(--border)', borderRadius: 0, marginTop: '0.25rem' }}
                      onClick={() => setNotifOpen(false)}
                    >Close</button>
                  </div>
                )}
              </div>
              <div className="nav-user">
                <div className="nav-avatar">{initial}</div>
                <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                  <span className="nav-user-email">{userEmail || 'User'}</span>
                  {roleLabel && <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{roleLabel}</span>}
                </div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleLogout}>Log out</button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-ghost" onClick={() => navigate('/login')}>Log in</button>
              <button type="button" className="btn btn-primary" onClick={() => navigate('/signup')}>Get started</button>
            </>
          )}
          <button type="button" className="nav-hamburger" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <MenuIcon />
          </button>
        </div>
      </div>

      {mobileOpen ? (
        <div className="nav-mobile-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeMobile() }}>
          <div className="nav-mobile-panel">
            <button className="nav-mobile-close" onClick={closeMobile} aria-label="Close menu">&times;</button>
            {navLinks}
            <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {isAuthenticated ? (
                <button type="button" className="btn btn-ghost" onClick={handleLogout} style={{ width: '100%' }}>Log out</button>
              ) : (
                <>
                  <button type="button" className="btn btn-ghost" onClick={() => { navigate('/login'); closeMobile() }} style={{ width: '100%' }}>Log in</button>
                  <button type="button" className="btn btn-primary" onClick={() => { navigate('/signup'); closeMobile() }} style={{ width: '100%' }}>Get started</button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </header>
  )
}

export default Navbar
