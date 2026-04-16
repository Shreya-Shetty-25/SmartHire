import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { assessmentApi } from '../assessmentApi'
import { chat } from '../api'
import ChatWidget from '../ChatWidget'

function fmtDate(value) {
  if (!value) return '—'
  try {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return String(value)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return String(value)
  }
}

function fmtDateTime(value) {
  if (!value) return '—'
  try {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return String(value)
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return String(value)
  }
}

function scoreLabel(row) {
  if (!row || row.score == null || row.total == null) return '—'
  const pct = row.percentage != null ? ` (${Number(row.percentage).toFixed(1)}%)` : ''
  return `${row.score}/${row.total}${pct}`
}

function getStatusConfig(status, passed) {
  const s = String(status || '').toLowerCase()
  if (s === 'submitted' && passed) return { label: 'Passed', cls: 'badge-green' }
  if (s === 'submitted' && !passed) return { label: 'Not Passed', cls: 'badge-red' }
  if (s === 'in_progress') return { label: 'In Progress', cls: 'badge-amber' }
  if (s === 'created') return { label: 'Not Started', cls: '' }
  if (s === 'rejected') return { label: 'Rejected', cls: 'badge-red' }
  return { label: status || '—', cls: '' }
}

function getGreeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

function CandidateHome() {
  const navigate = useNavigate()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const userName = useMemo(() => {
    try {
      const storedName = localStorage.getItem('userName') || ''
      if (storedName.trim()) return storedName.trim()
      const email = localStorage.getItem('userEmail') || ''
      const name = email.split('@')[0] || ''
      return name.charAt(0).toUpperCase() + name.slice(1)
    } catch { return '' }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const data = await assessmentApi.getMyExams({ statusFilter, limit: 100, offset: 0 })
        if (!cancelled) setRows(Array.isArray(data) ? data : [])
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load your exams')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [statusFilter])

  const attemptedCount = rows.length
  const submittedCount = rows.filter((row) => String(row?.status || '').toLowerCase() === 'submitted').length
  const passedCount = rows.filter((row) => Boolean(row?.passed)).length
  const inProgressCount = rows.filter((row) => String(row?.status || '').toLowerCase() === 'in_progress').length
  const avgPct = useMemo(() => {
    const submitted = rows.filter((row) => typeof row?.percentage === 'number')
    if (!submitted.length) return 0
    return submitted.reduce((acc, row) => acc + Number(row.percentage || 0), 0) / submitted.length
  }, [rows])

  const kpis = [
    { label: 'Total Attempts', value: attemptedCount, color: 'kpi-icon-indigo', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/></svg> },
    { label: 'Submitted', value: submittedCount, color: 'kpi-icon-purple', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> },
    { label: 'Passed', value: passedCount, color: 'kpi-icon-green', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> },
    { label: 'Avg Score', value: submittedCount ? `${avgPct.toFixed(1)}%` : '—', color: 'kpi-icon-cyan', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg> },
  ]

  return (
    <>
      <main className="main">
        <div className="dashboard-page">
          {/* Welcome Banner */}
          <div className="ch-welcome">
            <div className="ch-welcome-body">
              <h1 className="ch-welcome-title">
                Heyy{userName ? `, ${userName}` : ''} 👋
              </h1>
              <p className="ch-welcome-sub">
                {inProgressCount > 0
                  ? `You have ${inProgressCount} assessment${inProgressCount > 1 ? 's' : ''} in progress. Continue where you left off.`
                  : submittedCount > 0
                    ? `You've completed ${submittedCount} assessment${submittedCount > 1 ? 's' : ''}. Keep up the great work!`
                    : 'Track your assessments, view scores, and explore career opportunities.'}
              </p>
              <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginTop: '1.25rem' }}>
                <button type="button" className="btn btn-primary" onClick={() => navigate('/careers')}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
                  Browse Careers
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => navigate('/profile')}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  My Profile
                </button>
              </div>
            </div>
            <div className="ch-welcome-art" aria-hidden="true">
              <svg width="130" height="130" viewBox="0 0 130 130" fill="none">
                <circle cx="65" cy="65" r="60" fill="rgba(255,255,255,0.15)" />
                <circle cx="65" cy="65" r="42" fill="rgba(255,255,255,0.1)" />
                <path d="M50 82V72a15 15 0 0 1 30 0v10" stroke="rgba(255,255,255,0.5)" strokeWidth="2.5" strokeLinecap="round" />
                <circle cx="65" cy="54" r="10" stroke="rgba(255,255,255,0.5)" strokeWidth="2.5" />
                <circle cx="100" cy="35" r="4" fill="rgba(34,197,94,0.5)" />
                <circle cx="30" cy="42" r="3" fill="rgba(255,255,255,0.3)" />
                <circle cx="95" cy="85" r="3" fill="rgba(245,158,11,0.5)" />
              </svg>
            </div>
          </div>

          {/* KPI Cards */}
          <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            {kpis.map(({ label, value, color, icon }) => (
              <div key={label} className="kpi-card ch-kpi">
                <div className={`kpi-icon-badge ${color}`} style={{ width: 40, height: 40, borderRadius: 12 }}>{icon}</div>
                <div className="ch-kpi-value">{value}</div>
                <div className="card-subtitle">{label}</div>
              </div>
            ))}
          </div>

          {/* In-progress alert */}
          {inProgressCount > 0 && (
            <div className="alert alert-info" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1rem' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span>You have <strong>{inProgressCount}</strong> assessment{inProgressCount > 1 ? 's' : ''} in progress</span>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setStatusFilter('in_progress')} style={{ marginLeft: 'auto' }}>
                Show
              </button>
            </div>
          )}

          {/* Assessments Card */}
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">My Assessments</div>
                <div className="card-subtitle">{rows.length} assessment{rows.length !== 1 ? 's' : ''}</div>
              </div>
              <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ minWidth: 160, maxWidth: 200 }}>
                <option value="">All statuses</option>
                <option value="created">Not Started</option>
                <option value="in_progress">In Progress</option>
                <option value="submitted">Submitted</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>

            {error && <div className="error-banner">{error}</div>}

            {loading && (
              <div style={{ padding: '3rem 0', textAlign: 'center' }}>
                <span className="loading-spinner" style={{ width: 28, height: 28, borderWidth: 3 }} />
                <p className="muted" style={{ marginTop: '0.75rem' }}>Loading your assessments…</p>
              </div>
            )}

            {!loading && !rows.length && (
              <div className="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: '0.75rem', opacity: 0.5 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                <div className="empty-state-title">No assessments yet</div>
                <div className="empty-state-desc">When you apply for jobs or an assessment is assigned to you, it will appear here.</div>
                <button type="button" className="btn btn-primary" style={{ marginTop: '1rem' }} onClick={() => navigate('/careers')}>
                  Browse Open Positions
                </button>
              </div>
            )}

            {!loading && rows.length > 0 && (
              <div className="ch-assessment-grid">
                {rows.map((row, idx) => {
                  const code = String(row?.session_code || '').trim()
                  const status = String(row?.status || '').toLowerCase()
                  const passed = Boolean(row?.passed)
                  const statusCfg = getStatusConfig(status, passed)
                  const hasScore = row.score != null && row.total != null
                  const pct = Number(row.percentage || 0)

                  return (
                    <div key={code || `row-${idx}`} className={`ch-acard ${status === 'submitted' && passed ? 'ch-acard-pass' : status === 'submitted' ? 'ch-acard-fail' : status === 'in_progress' ? 'ch-acard-progress' : ''}`}>
                      <div className="ch-acard-top">
                        <div className="ch-acard-avatar">{(row.job_title || '?').charAt(0).toUpperCase()}</div>
                        <span className={`badge-soft ${statusCfg.cls}`}>{statusCfg.label}</span>
                      </div>
                      <div className="ch-acard-title">{row.job_title || 'Assessment'}</div>
                      <div className="ch-acard-meta">
                        <code className="ch-ac-code">{code || '—'}</code>
                        <span className="ch-ac-sep">·</span>
                        <span>{row.started_at ? fmtDate(row.started_at) : 'Not started'}</span>
                      </div>
                      {hasScore && (
                        <div className="ch-acard-score">
                          <div className="ch-acard-score-row">
                            <span className="ch-acard-pct">{pct.toFixed(0)}%</span>
                            <span className="ch-acard-fraction">{row.score}/{row.total}</span>
                          </div>
                          <div className="ch-ac-score-bar">
                            <div className={`ch-ac-score-fill ${pct >= 60 ? 'is-pass' : 'is-fail'}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                          </div>
                        </div>
                      )}
                      {code && (status === 'created' || status === 'in_progress') && (
                        <button type="button" className="btn btn-primary btn-sm ch-acard-btn" onClick={() => navigate(`/assessment?code=${encodeURIComponent(code)}`)}>
                          {status === 'in_progress' ? 'Continue' : 'Start Exam'}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </main>
      <ChatWidget
        sendMessage={chat.sendMessage}
        title="Career Assistant"
        greeting="Hi! I'm your SmartHire career assistant. Ask me about open roles, career paths, or skill requirements!"
        placeholder="Ask about careers or skills…"
      />
    </>
  )
}

export default CandidateHome
