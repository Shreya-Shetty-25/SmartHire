import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { dashboard } from '../api'
import { assessmentApi } from '../assessmentApi'

function Dashboard() {
  const navigate = useNavigate()
  const [stats, setStats] = useState(null)
  const [assessmentStats, setAssessmentStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) return

    let cancelled = false
    async function load() {
      try {
        const [main, assessment] = await Promise.allSettled([
          dashboard.stats(token),
          assessmentApi.getStats(),
        ])
        if (cancelled) return
        if (main.status === 'fulfilled') setStats(main.value)
        if (assessment.status === 'fulfilled') setAssessmentStats(assessment.value)
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <main className="main">
        <section className="dashboard-page">
          <p className="muted" style={{ textAlign: 'center', padding: '4rem 0' }}>Loading dashboard…</p>
        </section>
      </main>
    )
  }

  if (error && !stats && !assessmentStats) {
    return (
      <main className="main">
        <section className="dashboard-page">
          <p style={{ color: '#ef4444', textAlign: 'center', padding: '4rem 0' }}>Failed to load dashboard: {error}</p>
        </section>
      </main>
    )
  }

  const totalJobs = stats?.total_jobs ?? 0
  const totalCandidates = stats?.total_candidates ?? 0
  const totalRanked = stats?.total_ranked ?? 0
  const totalExams = assessmentStats?.total_exams ?? 0
  const totalSubmitted = assessmentStats?.total_submitted ?? 0
  const totalPassed = assessmentStats?.total_passed ?? 0
  const totalFailed = assessmentStats?.total_failed ?? 0
  const avgScore = assessmentStats?.avg_score ?? 0
  const passRate = totalSubmitted > 0 ? Math.round((totalPassed / totalSubmitted) * 100) : 0

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header">
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Welcome back! Here's your hiring overview.</p>
        </div>

        {/* KPI cards */}
        <div className="dashboard-grid" style={{ marginBottom: '1.5rem' }}>
          <article className="card">
            <div className="card-header">
              <div>
                <p className="card-subtitle">Total Jobs</p>
                <p style={{ fontSize: '2rem', fontWeight: 700, lineHeight: 1.2 }}>{totalJobs}</p>
              </div>
              <span className="badge-soft">{totalJobs === 1 ? '1 role' : `${totalJobs} roles`}</span>
            </div>
          </article>

          <article className="card">
            <div className="card-header">
              <div>
                <p className="card-subtitle">Total Candidates</p>
                <p style={{ fontSize: '2rem', fontWeight: 700, lineHeight: 1.2 }}>{totalCandidates}</p>
              </div>
              <span className="badge-soft">{totalRanked} ranked</span>
            </div>
          </article>

          <article className="card">
            <div className="card-header">
              <div>
                <p className="card-subtitle">Assessments</p>
                <p style={{ fontSize: '2rem', fontWeight: 700, lineHeight: 1.2 }}>{totalExams}</p>
              </div>
              <span className="badge-soft">{totalSubmitted} submitted</span>
            </div>
          </article>

          <article className="card">
            <div className="card-header">
              <div>
                <p className="card-subtitle">Pass Rate</p>
                <p style={{ fontSize: '2rem', fontWeight: 700, lineHeight: 1.2 }}>{passRate}%</p>
              </div>
              <span className="badge-soft">{totalPassed} passed · {totalFailed} failed</span>
            </div>
          </article>
        </div>

        <div className="dashboard-grid">
          {/* Jobs summary */}
          <article className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Active Roles</h2>
                <p className="card-subtitle">Your open positions</p>
              </div>
              <span className="badge-soft">{totalJobs} active</span>
            </div>
            {stats?.jobs_summary?.length ? (
              <ul className="timeline">
                {stats.jobs_summary.map((j) => (
                  <li className="timeline-item" key={j.id}>
                    <div className="dot" />
                    <div>
                      <div>{j.title}</div>
                      <div className="muted">{j.candidate_count} candidate{j.candidate_count !== 1 ? 's' : ''}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No jobs created yet.</p>
            )}
          </article>

          {/* Recent exams */}
          <article className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Recent Assessments</h2>
                <p className="card-subtitle">Latest exam sessions</p>
              </div>
              {avgScore > 0 && <span className="badge-soft">Avg {avgScore}%</span>}
            </div>
            {assessmentStats?.recent_exams?.length ? (
              <ul className="timeline">
                {assessmentStats.recent_exams.slice(0, 8).map((e) => (
                  <li className="timeline-item" key={e.session_code}>
                    <div className="dot" style={{ background: e.passed ? '#22c55e' : e.status === 'submitted' ? '#ef4444' : 'var(--accent)' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>{e.candidate_name || e.candidate_email}</span>
                        {e.percentage != null && (
                          <span className="badge-soft" style={e.passed ? { background: 'rgba(34,197,94,0.1)', color: '#16a34a' } : { background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
                            {e.percentage}%
                          </span>
                        )}
                      </div>
                      <div className="muted">{e.job_title || 'General'} · {e.status}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No assessments yet.</p>
            )}
          </article>

          {/* Top candidates */}
          <article className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Top Candidates</h2>
                <p className="card-subtitle">Highest ranked applicants</p>
              </div>
            </div>
            {stats?.top_candidates?.length ? (
              <ul className="timeline">
                {stats.top_candidates.map((c, i) => (
                  <li className="timeline-item" key={c.candidate_id}>
                    <div className="dot" style={{ background: i === 0 ? '#eab308' : i === 1 ? '#94a3b8' : '#cd7c2f' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{c.full_name || c.email}</span>
                        {c.score != null && <span className="badge-soft">{c.score} pts</span>}
                      </div>
                      <div className="muted">{c.job_title} · {c.email}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No ranked candidates yet.</p>
            )}
          </article>

          {/* Recent candidates */}
          <article className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Recent Candidates</h2>
                <p className="card-subtitle">Latest applicants</p>
              </div>
            </div>
            {stats?.recent_candidates?.length ? (
              <ul className="timeline">
                {stats.recent_candidates.map((c) => (
                  <li className="timeline-item" key={c.id}>
                    <div className="dot" />
                    <div>
                      <div>{c.full_name || c.email}</div>
                      <div className="muted">{c.email}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No candidates yet.</p>
            )}
          </article>
        </div>

        {/* Quick actions */}
        <div style={{ marginTop: '1.5rem' }}>
          <div className="chip-row">
            <button className="chip" onClick={() => navigate('/hire')} style={{ cursor: 'pointer' }}>Post new job</button>
            <button className="chip" onClick={() => navigate('/candidates')} style={{ cursor: 'pointer' }}>View candidates</button>
            <button className="chip" onClick={() => navigate('/hire')} style={{ cursor: 'pointer' }}>Rank &amp; shortlist</button>
            <button className="chip" onClick={() => navigate('/assessment')} style={{ cursor: 'pointer' }}>Assessments</button>
          </div>
        </div>
      </section>
    </main>
  )
}

export default Dashboard
