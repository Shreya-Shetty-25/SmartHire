import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { dashboard, realtime } from '../api'
import { assessmentApi } from '../assessmentApi'

function formatLiveTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString()
}

function Dashboard() {
  const navigate = useNavigate()
  const token = localStorage.getItem('token')
  const [stats, setStats] = useState(null)
  const [assessmentStats, setAssessmentStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [coreLiveState, setCoreLiveState] = useState('connecting')
  const [assessmentLiveState, setAssessmentLiveState] = useState('connecting')
  const [lastRealtimeAt, setLastRealtimeAt] = useState('')
  const refreshTimerRef = useRef(null)

  async function loadDashboardData({ silent = false } = {}) {
    if (!token) return
    if (!silent) setLoading(true)
    try {
      const [main, assessment] = await Promise.allSettled([
        dashboard.stats(token),
        assessmentApi.getStats(),
      ])
      if (main.status === 'fulfilled') setStats(main.value)
      if (assessment.status === 'fulfilled') setAssessmentStats(assessment.value)
      if (main.status !== 'fulfilled' && assessment.status !== 'fulfilled') {
        throw new Error('Failed to refresh dashboard data')
      }
      if (!silent) setError(null)
    } catch (err) {
      setError(err?.message || 'Failed to load dashboard')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    if (!token) return
    ;(async () => {
      await loadDashboardData()
    })()
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (!token) return

    const scheduleRefresh = () => {
      if (refreshTimerRef.current) return
      refreshTimerRef.current = setTimeout(async () => {
        refreshTimerRef.current = null
        await loadDashboardData({ silent: true })
      }, 700)
    }

    const coreUrl = realtime.streamUrl(token, { eventTypes: ['dashboard_counters_updated'] })
    const assessmentUrl = assessmentApi.adminRealtimeStreamUrl({
      token,
      eventTypes: ['dashboard_counters_updated', 'exam_status_updated', 'call_status_updated'],
    })

    const coreStream = coreUrl ? new EventSource(coreUrl) : null
    const assessmentStream = assessmentUrl ? new EventSource(assessmentUrl) : null

    if (coreStream) {
      coreStream.addEventListener('open', () => setCoreLiveState('live'))
      coreStream.addEventListener('dashboard_counters_updated', (event) => {
        try {
          const payload = JSON.parse(event?.data || '{}')
          setStats((prev) => ({ ...(prev || {}), ...payload }))
        } catch {
          // noop
        }
        setLastRealtimeAt(new Date().toISOString())
        scheduleRefresh()
      })
      coreStream.onerror = () => setCoreLiveState('reconnecting')
    }

    if (assessmentStream) {
      assessmentStream.addEventListener('open', () => setAssessmentLiveState('live'))
      assessmentStream.addEventListener('dashboard_counters_updated', (event) => {
        try {
          const payload = JSON.parse(event?.data || '{}')
          setAssessmentStats((prev) => ({ ...(prev || {}), ...payload }))
        } catch {
          // noop
        }
        setLastRealtimeAt(new Date().toISOString())
        scheduleRefresh()
      })
      assessmentStream.addEventListener('exam_status_updated', () => {
        setLastRealtimeAt(new Date().toISOString())
        scheduleRefresh()
      })
      assessmentStream.addEventListener('call_status_updated', () => {
        setLastRealtimeAt(new Date().toISOString())
        scheduleRefresh()
      })
      assessmentStream.onerror = () => setAssessmentLiveState('reconnecting')
    }

    return () => {
      if (coreStream) coreStream.close()
      if (assessmentStream) assessmentStream.close()
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

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
  const activeExams = assessmentStats?.active_exams ?? 0
  const pendingReviews = assessmentStats?.pending_reviews ?? 0
  const interviewsToday = assessmentStats?.interviews_today ?? 0
  const securityStats = assessmentStats?.security_stats || {}
  const highRiskEvents = securityStats?.high_risk_events ?? 0
  const highRiskSessions = securityStats?.sessions_with_high_risk_signals ?? 0
  const identityVerifiedSessions = securityStats?.verified_identity_sessions ?? 0
  const identityPendingSessions = securityStats?.pending_identity_sessions ?? 0
  const identityReuploadRequired = securityStats?.identity_reupload_required ?? 0
  const passRate = totalSubmitted > 0 ? Math.round((totalPassed / totalSubmitted) * 100) : 0
  const pipelineOverview = stats?.pipeline_overview || {}
  const jobAnalytics = Array.isArray(stats?.job_analytics) ? stats.job_analytics : []
  const backgroundJobs = Array.isArray(stats?.background_jobs) ? stats.background_jobs : []

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Dashboard</h1>
            <p className="page-subtitle">Here&rsquo;s your hiring pipeline at a glance.</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            {(coreLiveState === 'live' || assessmentLiveState === 'live') && (
              <span className="live-indicator">
                <span className="live-dot" />
                Live
                {lastRealtimeAt ? ` · ${formatLiveTime(lastRealtimeAt)}` : ''}
              </span>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/hire')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Hire
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/jobs')}>Manage Jobs</button>
          </div>
        </div>

        {/* KPI cards — compact */}
        <div className="kpi-grid" style={{ marginBottom: '1rem', gap: '0.85rem' }}>
          <article className="card kpi-card" style={{ borderLeft: '3px solid #0e7490', padding: '1rem 1.1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div className="kpi-icon-badge kpi-icon-indigo" style={{ width: 36, height: 36, borderRadius: 10 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
              </div>
              <div>
                <p className="card-subtitle" style={{ margin: 0 }}>Total Jobs</p>
                <p className="card-value" style={{ fontSize: '1.5rem' }}>{totalJobs}</p>
              </div>
            </div>
          </article>

          <article className="card kpi-card" style={{ borderLeft: '3px solid #0891b2', padding: '1rem 1.1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div className="kpi-icon-badge kpi-icon-purple" style={{ width: 36, height: 36, borderRadius: 10 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              </div>
              <div>
                <p className="card-subtitle" style={{ margin: 0 }}>Candidates</p>
                <p className="card-value" style={{ fontSize: '1.5rem' }}>{totalCandidates}</p>
              </div>
            </div>
            <div style={{ marginTop: '0.4rem' }}>
              <span className="badge-soft badge-purple">{totalRanked} ranked</span>
            </div>
          </article>

          <article className="card kpi-card" style={{ borderLeft: '3px solid #06b6d4', padding: '1rem 1.1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div className="kpi-icon-badge kpi-icon-cyan" style={{ width: 36, height: 36, borderRadius: 10 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
              </div>
              <div>
                <p className="card-subtitle" style={{ margin: 0 }}>Assessments</p>
                <p className="card-value" style={{ fontSize: '1.5rem' }}>{totalExams}</p>
              </div>
            </div>
            <div style={{ marginTop: '0.4rem', display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
              <span className="badge-soft badge-cyan">{activeExams} active</span>
              <span className="badge-soft">{totalSubmitted} done</span>
              {pendingReviews > 0 && <span className="badge-soft badge-amber">{pendingReviews} pending</span>}
            </div>
          </article>

          <article className="card kpi-card" style={{ borderLeft: `3px solid ${passRate >= 60 ? '#22c55e' : passRate > 0 ? '#f59e0b' : 'var(--border)'}`, padding: '1rem 1.1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div className={`kpi-icon-badge ${passRate >= 60 ? 'kpi-icon-green' : 'kpi-icon-amber'}`} style={{ width: 36, height: 36, borderRadius: 10 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
              <div>
                <p className="card-subtitle" style={{ margin: 0 }}>Pass Rate</p>
                <p className="card-value" style={{ fontSize: '1.5rem', color: passRate >= 60 ? '#16a34a' : passRate > 0 ? '#d97706' : 'var(--text)' }}>{passRate}%</p>
              </div>
            </div>
            <div style={{ marginTop: '0.4rem', display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
              <span className="badge-soft badge-green">{totalPassed} passed</span>
              <span className="badge-soft badge-red">{totalFailed} failed</span>
              {interviewsToday > 0 && <span className="badge-soft">{interviewsToday} interviews</span>}
            </div>
          </article>
        </div>

        <div className="dashboard-grid" style={{ gap: '0.85rem' }}>
          {/* Jobs summary */}
          <article className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Active Roles</h2>
                <p className="card-subtitle">Open positions</p>
              </div>
              <span className="badge-soft">{totalJobs} active</span>
            </div>
            {stats?.jobs_summary?.length ? (
              <>
                <ul className="timeline">
                  {stats.jobs_summary.slice(0, 5).map((j, index) => (
                    <li className="timeline-item" key={`job-${j.id}-${index}`}>
                      <div className="dot" style={{ background: 'var(--accent)' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.title}</div>
                        <div className="muted">{j.candidate_count} candidate{j.candidate_count !== 1 ? 's' : ''}</div>
                      </div>
                    </li>
                  ))}
                </ul>
                {stats.jobs_summary.length > 5 && (
                  <div style={{ textAlign: 'center', paddingBottom: '0.75rem' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => navigate('/jobs')} style={{ fontSize: '0.8rem' }}>View all {stats.jobs_summary.length} roles &rarr;</button>
                  </div>
                )}
              </>
            ) : (
              <div className="empty-state" style={{ padding: '1.5rem 0' }}>
                <div className="empty-state-title">No jobs yet</div>
                <div className="empty-state-desc">Create your first job posting to get started.</div>
              </div>
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
              <>
                <ul className="timeline">
                  {assessmentStats.recent_exams.slice(0, 5).map((e, index) => (
                    <li className="timeline-item" key={`exam-${e.session_code || 'unknown'}-${index}`}>
                      <div className="dot" style={{ background: e.passed ? '#22c55e' : e.status === 'submitted' ? '#ef4444' : 'var(--accent)' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.candidate_name || e.candidate_email}</span>
                          {e.percentage != null && (
                            <span className={`badge-soft ${e.passed ? 'badge-green' : 'badge-red'}`} style={{ flexShrink: 0 }}>
                              {e.percentage}%
                            </span>
                          )}
                        </div>
                        <div className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.job_title || 'General'} · {e.status}</div>
                      </div>
                    </li>
                  ))}
                </ul>
                {assessmentStats.recent_exams.length > 5 && (
                  <div style={{ textAlign: 'center', paddingBottom: '0.75rem' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => navigate('/hire')} style={{ fontSize: '0.8rem' }}>View all {assessmentStats.recent_exams.length} assessments &rarr;</button>
                  </div>
                )}
              </>
            ) : (
              <div className="empty-state" style={{ padding: '1.5rem 0' }}>
                <div className="empty-state-title">No assessments yet</div>
              </div>
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
              <>
                <ul className="timeline">
                  {stats.top_candidates.slice(0, 5).map((c, i) => (
                    <li className="timeline-item" key={`top-${c.candidate_id}-${c.job_title || 'job'}-${i}`}>
                      <div style={{ width: 24, height: 24, borderRadius: '50%', background: i === 0 ? 'linear-gradient(135deg,#fbbf24,#f59e0b)' : i === 1 ? 'linear-gradient(135deg,#94a3b8,#64748b)' : 'linear-gradient(135deg,#cd7c2f,#b45309)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', fontWeight: 800, color: '#fff', flexShrink: 0 }}>{i + 1}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                          <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.full_name || c.email}</span>
                          {c.score != null && <span className="badge-soft" style={{ flexShrink: 0 }}>{c.score} pts</span>}
                        </div>
                        <div className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.job_title}</div>
                      </div>
                    </li>
                  ))}
                </ul>
                {stats.top_candidates.length > 5 && (
                  <div style={{ textAlign: 'center', paddingBottom: '0.75rem' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => navigate('/candidates')} style={{ fontSize: '0.8rem' }}>View all {stats.top_candidates.length} candidates &rarr;</button>
                  </div>
                )}
              </>
            ) : (
              <div className="empty-state" style={{ padding: '1.5rem 0' }}>
                <div className="empty-state-title">No ranked candidates yet</div>
                <div className="empty-state-desc">Use the Hire workflow to rank candidates.</div>
              </div>
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
              <>
                <ul className="timeline">
                  {stats.recent_candidates.slice(0, 5).map((c, index) => (
                    <li className="timeline-item" key={`candidate-${c.id}-${index}`}>
                      <div className="table-avatar" style={{ width: 26, height: 26, fontSize: '0.65rem', flexShrink: 0 }}>
                        {(c.full_name || c.email || '?').charAt(0).toUpperCase()}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.full_name || c.email}</div>
                        <div className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.email}</div>
                      </div>
                    </li>
                  ))}
                </ul>
                {stats.recent_candidates.length > 5 && (
                  <div style={{ textAlign: 'center', paddingBottom: '0.75rem' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => navigate('/candidates')} style={{ fontSize: '0.8rem' }}>View all {stats.recent_candidates.length} candidates &rarr;</button>
                  </div>
                )}
              </>
            ) : (
              <div className="empty-state" style={{ padding: '1.5rem 0' }}>
                <div className="empty-state-title">No candidates yet</div>
              </div>
            )}
          </article>
        </div>

        {/* Pipeline Overview */}
        {Object.keys(pipelineOverview).length > 0 && (
          <article className="card" style={{ marginTop: '0.85rem' }}>
            <div className="card-header" style={{ marginBottom: '0.5rem' }}>
              <div>
                <h2 className="card-title">Pipeline Overview</h2>
                <p className="card-subtitle">Candidates moving through the hiring funnel</p>
              </div>
            </div>
            <div className="pipeline-funnel">
              {Object.entries(pipelineOverview).map(([stage, count]) => {
                const max = Math.max(...Object.values(pipelineOverview))
                const pct = max > 0 ? Math.round((count / max) * 100) : 0
                return (
                  <div key={stage} className="pipeline-stage">
                    <span className="pipeline-stage-label">{stage.replace(/_/g, ' ')}</span>
                    <div className="pipeline-stage-bar"><div className="pipeline-stage-fill" style={{ width: `${pct}%` }} /></div>
                    <span className="pipeline-stage-count">{count}</span>
                  </div>
                )
              })}
            </div>
          </article>
        )}

        <div className="dashboard-grid" style={{ marginTop: '0.85rem', gap: '0.85rem' }}>
          {backgroundJobs.length > 0 && (
            <article className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">Background Jobs</h2>
                  <p className="card-subtitle">Queued embeddings and pipeline work</p>
                </div>
              </div>
              <ul className="timeline">
                {backgroundJobs.map((job) => (
                  <li className="timeline-item" key={job.id}>
                    <div className="dot" style={{ background: job.status === 'completed' ? '#22c55e' : job.status === 'failed' ? '#ef4444' : '#2563eb' }} />
                    <div>
                      <div style={{ fontWeight: 550 }}>{job.name}</div>
                      <div className="muted">{job.status}{job.error ? ` · ${job.error}` : ''}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </article>
          )}

          {jobAnalytics.length > 0 && (
            <article className="card" style={{ gridColumn: backgroundJobs.length > 0 ? 'auto' : '1 / -1' }}>
              <div className="card-header">
                <div>
                  <h2 className="card-title">Per-Job Analytics</h2>
                  <p className="card-subtitle">Funnel conversion and assessment scores</p>
                </div>
              </div>
              <div className="table-wrap">
                <table className="table" aria-label="Per-job analytics">
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Median Score</th>
                      <th>Shortlist → Hire</th>
                      <th>Drop-offs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobAnalytics.map((row) => (
                      <tr key={row.job_id}>
                        <td style={{ fontWeight: 650 }}>{row.job_title || `Job ${row.job_id}`}</td>
                        <td>{row.median_assessment_score != null ? <span className={`badge-soft ${row.median_assessment_score >= 60 ? 'badge-green' : 'badge-red'}`}>{row.median_assessment_score}%</span> : <span className="table-muted">—</span>}</td>
                        <td>{typeof row.shortlist_to_hire_ratio === 'number' ? row.shortlist_to_hire_ratio : <span className="table-muted">—</span>}</td>
                        <td className="table-muted" style={{ maxWidth: 200 }}>
                          {(row.drop_off_reasons || []).map((item) => `${item.reason}: ${item.count}`).join(' · ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          )}
        </div>
      </section>
    </main>
  )
}

export default Dashboard
