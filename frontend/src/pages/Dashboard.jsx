function Dashboard() {
  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header">
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Welcome back! Here's your hiring overview.</p>
        </div>

        <div className="dashboard-grid">
          <article className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Active Roles</h2>
                <p className="card-subtitle">Your open positions</p>
              </div>
              <span className="badge-soft">3 active</span>
            </div>
            <ul className="timeline">
              <li className="timeline-item">
                <div className="dot" />
                <div>
                  <div>Frontend Engineer</div>
                  <div className="muted">14 candidates</div>
                </div>
              </li>
              <li className="timeline-item">
                <div className="dot" />
                <div>
                  <div>Product Designer</div>
                  <div className="muted">9 candidates</div>
                </div>
              </li>
              <li className="timeline-item">
                <div className="dot" />
                <div>
                  <div>Data Analyst</div>
                  <div className="muted">7 candidates</div>
                </div>
              </li>
            </ul>
          </article>

          <article className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Quick Actions</h2>
                <p className="card-subtitle">Common tasks</p>
              </div>
            </div>
            <div className="chip-row">
              <span className="chip">Post new job</span>
              <span className="chip">View candidates</span>
              <span className="chip">Schedule interview</span>
              <span className="chip">Reports</span>
            </div>
          </article>
        </div>
      </section>
    </main>
  )
}

export default Dashboard
