import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { dashboard } from '../api'
import { assessmentApi } from '../assessmentApi'

function Home() {
  const [stats, setStats] = useState(null)
  const [aStats, setAStats] = useState(null)

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) return
    Promise.allSettled([
      dashboard.stats(token),
      assessmentApi.getStats(),
    ]).then(([main, assessment]) => {
      if (main.status === 'fulfilled') setStats(main.value)
      if (assessment.status === 'fulfilled') setAStats(assessment.value)
    })
  }, [])

  const totalJobs = stats?.total_jobs ?? 0
  const totalCandidates = stats?.total_candidates ?? 0
  const totalExams = aStats?.total_exams ?? 0
  const passRate = aStats?.total_submitted > 0 ? Math.round((aStats.total_passed / aStats.total_submitted) * 100) : 0
  const hasStats = stats || aStats

  return (
    <main className="main">
      <section className="hero">
        <div className="hero-content">
          <div className="hero-badge">
            <span className="hero-badge-dot" />
            <span>AI-powered recruiting platform</span>
          </div>

          <h1 className="hero-title">
            Hire the right talent, <span>faster.</span>
          </h1>

          <p className="hero-subtitle">
            From resume parsing to AI-proctored assessments and voice interviews — streamline your entire hiring pipeline in one platform.
          </p>

          <div className="hero-actions">
            <Link to="/signup">
              <button type="button" className="btn btn-primary btn-lg">Get started free</button>
            </Link>
            <Link to="/login">
              <button type="button" className="btn btn-ghost btn-lg">Sign in</button>
            </Link>
          </div>
        </div>

        {hasStats ? (
          <div className="hero-stats">
            <div className="hero-stat">
              <div className="hero-stat-value">{totalJobs}</div>
              <div className="hero-stat-label">Active Jobs</div>
            </div>
            <div className="hero-stat">
              <div className="hero-stat-value">{totalCandidates}</div>
              <div className="hero-stat-label">Candidates</div>
            </div>
            <div className="hero-stat">
              <div className="hero-stat-value">{totalExams}</div>
              <div className="hero-stat-label">Assessments</div>
            </div>
            <div className="hero-stat">
              <div className="hero-stat-value">{passRate}%</div>
              <div className="hero-stat-label">Pass Rate</div>
            </div>
          </div>
        ) : null}
      </section>

      <section className="features-section">
        <h2 className="features-title">Everything you need to hire smarter</h2>
        <p className="features-subtitle">End-to-end recruitment tools powered by artificial intelligence</p>

        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon feature-icon-blue">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            </div>
            <div className="feature-title">AI Resume Parsing</div>
            <div className="feature-desc">Upload PDFs and let AI extract skills, experience, education, and contact details automatically.</div>
          </div>

          <div className="feature-card">
            <div className="feature-icon feature-icon-purple">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </div>
            <div className="feature-title">Job Management</div>
            <div className="feature-desc">Create and manage job postings with required skills, experience levels, and detailed descriptions.</div>
          </div>

          <div className="feature-card">
            <div className="feature-icon feature-icon-green">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            </div>
            <div className="feature-title">LLM-Powered Ranking</div>
            <div className="feature-desc">Rank candidates against job requirements using large language models for intelligent, unbiased scoring.</div>
          </div>

          <div className="feature-card">
            <div className="feature-icon feature-icon-amber">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </div>
            <div className="feature-title">Proctored Assessments</div>
            <div className="feature-desc">AI-monitored exams with face detection, gaze tracking, audio analysis, and anti-cheating measures.</div>
          </div>

          <div className="feature-card">
            <div className="feature-icon feature-icon-pink">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
            </div>
            <div className="feature-title">AI Voice Interviews</div>
            <div className="feature-desc">Automated phone interviews powered by AI voice agents with real-time transcription and analysis.</div>
          </div>

          <div className="feature-card">
            <div className="feature-icon feature-icon-cyan">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            </div>
            <div className="feature-title">Analytics Dashboard</div>
            <div className="feature-desc">Real-time hiring metrics, pass rates, top candidates, and assessment insights at a glance.</div>
          </div>
        </div>
      </section>
    </main>
  )
}

export default Home
