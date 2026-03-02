import { Link } from 'react-router-dom'

function Home() {
  return (
    <main className="main">
      <section className="hero">
        <div className="hero-content">
          <div className="hero-badge">
            <span className="hero-badge-dot" />
            <span>Smart recruiting made simple</span>
          </div>
          
          <h1 className="hero-title">
            Hire the right talent, <span>faster.</span>
          </h1>
          
          <p className="hero-subtitle">
            Streamline your hiring process with SmartHire. From job posting to offer letter, all in one place.
          </p>
          
          <div className="hero-actions">
            <Link to="/signup">
              <button type="button" className="btn btn-primary">
                Get started free
              </button>
            </Link>
            <Link to="/login">
              <button type="button" className="btn btn-ghost">
                Sign in
              </button>
            </Link>
          </div>
        </div>

        <div className="hero-illustration">
          <div className="preview-card">
            <div className="preview-header">
              <span className="preview-title">Hiring Overview</span>
              <span className="preview-badge">Live</span>
            </div>
            <div className="stats-row">
              <div className="stat-item">
                <div className="stat-value">24</div>
                <div className="stat-label">Open roles</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">142</div>
                <div className="stat-label">Candidates</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">8</div>
                <div className="stat-label">Interviews</div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}

export default Home
