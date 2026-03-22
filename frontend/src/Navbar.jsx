import { Link, NavLink, useNavigate } from 'react-router-dom'

function Navbar({ isAuthenticated, isAdmin, onLogout }) {
  const navigate = useNavigate()

  const handleLogout = () => {
    if (typeof onLogout === 'function') {
      onLogout()
    } else {
      localStorage.removeItem('token')
      localStorage.removeItem('userRole')
    }
    navigate('/')
  }

  return (
    <header className="navbar">
      <div className="nav-inner">
        <Link to="/" className="brand" aria-label="SmartHire home">
          <div className="brand-mark">
            <img className="brand-logo-img" src="/logo.png" alt="SmartHire" />
          </div>
          <div>
            <div className="brand-title">
              Smart<span className="brand-accent">Hire</span>
            </div>
          </div>
        </Link>

        <nav className="nav-links" aria-label="Primary">
          <NavLink to="/" className="nav-link">
            Home
          </NavLink>
          {isAuthenticated && isAdmin ? (
            <>
              <NavLink to="/dashboard" className="nav-link">
                Dashboard
              </NavLink>
              <NavLink to="/hire" className="nav-link">
                Hire
              </NavLink>
              <NavLink to="/candidates" className="nav-link">
                Candidates
              </NavLink>
              <NavLink to="/assessment-details" className="nav-link">
                Assessment Details
              </NavLink>
            </>
          ) : null}
          {isAuthenticated ? (
            <NavLink to="/assessment" className="nav-link">
              Assessment
            </NavLink>
          ) : null}
        </nav>

        <div className="nav-actions">
          {!isAuthenticated ? (
            <>
              <button type="button" className="btn btn-ghost" onClick={() => navigate('/login')}>
                Log in
              </button>
              <button type="button" className="btn btn-primary" onClick={() => navigate('/signup')}>
                Sign up
              </button>
            </>
          ) : (
            <>
              {isAdmin ? (
                <button type="button" className="btn btn-ghost" onClick={() => navigate('/dashboard')}>
                  Dashboard
                </button>
              ) : null}
              <button type="button" className="btn btn-primary" onClick={handleLogout}>
                Log out
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  )
}

export default Navbar
