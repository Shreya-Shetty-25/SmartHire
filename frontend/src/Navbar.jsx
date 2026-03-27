import { useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'

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

function Navbar({ isAuthenticated, isAdmin, onLogout, userEmail }) {
  const navigate = useNavigate()
  const [mobileOpen, setMobileOpen] = useState(false)

  const handleLogout = () => {
    if (typeof onLogout === 'function') onLogout()
    else { localStorage.removeItem('token'); localStorage.removeItem('userRole') }
    navigate('/')
    setMobileOpen(false)
  }

  const closeMobile = () => setMobileOpen(false)

  const navLinks = (
    <>
      <NavLink to="/" className="nav-link" onClick={closeMobile}>Home</NavLink>
      {isAuthenticated && isAdmin ? (
        <>
          <NavLink to="/dashboard" className="nav-link" onClick={closeMobile}>Dashboard</NavLink>
          <NavLink to="/jobs" className="nav-link" onClick={closeMobile}>Jobs</NavLink>
          <NavLink to="/hire" className="nav-link" onClick={closeMobile}>Hire</NavLink>
          <NavLink to="/candidates" className="nav-link" onClick={closeMobile}>Candidates</NavLink>
          <NavLink to="/assessment-details" className="nav-link" onClick={closeMobile}>Assessments</NavLink>
        </>
      ) : null}
      {isAuthenticated && !isAdmin ? (
        <NavLink to="/assessment" className="nav-link" onClick={closeMobile}>Take Assessment</NavLink>
      ) : null}
    </>
  )

  const initial = userEmail ? userEmail.charAt(0).toUpperCase() : '?'

  return (
    <header className="navbar">
      <div className="nav-inner">
        <Link to="/" className="brand" aria-label="SmartHire home">
          <div className="brand-mark"><LogoIcon /></div>
          <div className="brand-title">Smart<span className="brand-accent">Hire</span></div>
        </Link>

        <nav className="nav-links" aria-label="Primary">{navLinks}</nav>

        <div className="nav-actions">
          {isAuthenticated ? (
            <>
              <div className="nav-user">
                <div className="nav-avatar">{initial}</div>
                <span className="nav-user-email">{userEmail || 'User'}</span>
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
