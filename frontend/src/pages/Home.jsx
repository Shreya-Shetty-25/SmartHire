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

        {hasStats && (
          <div className="hero-stats">
            {[
              { value: totalJobs, label: 'Active Jobs' },
              { value: totalCandidates, label: 'Candidates' },
              { value: totalExams, label: 'Assessments' },
              { value: `${passRate}%`, label: 'Pass Rate' },
            ].map(({ value, label }) => (
              <div key={label} className="hero-stat">
                <div className="hero-stat-value">{value}</div>
                <div className="hero-stat-label">{label}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="features-section">
        <h2 className="features-title">Everything you need to hire smarter</h2>
        <p className="features-subtitle">End-to-end recruitment tools powered by artificial intelligence</p>

        <div className="features-grid">
          {[
            { color: 'blue', title: 'AI Resume Parsing', desc: 'Upload PDFs and let AI extract skills, experience, education, and contact details automatically.', icon: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></> },
            { color: 'purple', title: 'Smart Job Matching', desc: 'AI-powered matching connects candidates with the most relevant opportunities based on skills and experience.', icon: <><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></> },
            { color: 'green', title: 'LLM-Powered Ranking', desc: 'Rank candidates against job requirements using large language models for intelligent, unbiased scoring.', icon: <><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></> },
            { color: 'amber', title: 'Proctored Assessments', desc: 'AI-monitored exams with face detection, gaze tracking, audio analysis, and anti-cheating measures.', icon: <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></> },
            { color: 'pink', title: 'AI Voice Interviews', desc: 'Automated phone interviews powered by AI voice agents with real-time transcription and analysis.', icon: <><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></> },
            { color: 'cyan', title: 'Analytics Dashboard', desc: 'Real-time hiring metrics, pass rates, top candidates, and assessment insights at a glance.', icon: <><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></> },
          ].map(({ color, title, desc, icon }) => (
            <div key={title} className="feature-card">
              <div className={`feature-icon feature-icon-${color}`}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
              </div>
              <div className="feature-title">{title}</div>
              <div className="feature-desc">{desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA Section */}
      <section className="home-cta-section">
        <div className="home-cta-card">
          <h2 className="home-cta-title">Ready to find your next opportunity?</h2>
          <p className="home-cta-sub">Create your candidate profile, let AI match you with the best roles, and take assessments — all in one place.</p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link to="/signup"><button type="button" className="btn btn-primary btn-lg">Create Free Account</button></Link>
            <Link to="/login"><button type="button" className="btn btn-ghost btn-lg">Sign In</button></Link>
          </div>
        </div>
      </section>
    </main>
  )
}

export default Home
