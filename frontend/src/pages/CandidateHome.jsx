import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { assessmentApi, } from '../assessmentApi'
import { chat } from '../api'

function fmtDate(value) {
  if (!value) return '—'
  try {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return String(value)
    return d.toLocaleString()
  } catch {
    return String(value)
  }
}

function scoreLabel(row) {
  if (!row || row.score == null || row.total == null) return '—'
  const pct = row.percentage != null ? ` (${Number(row.percentage).toFixed(1)}%)` : ''
  return `${row.score}/${row.total}${pct}`
}

function ChatBot() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([
    { role: 'bot', content: 'Hi! I\'m your SmartHire career assistant. Ask me about open roles, career paths, or skill requirements!' },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    if (open && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, open])

  async function sendMessage() {
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    const userMsg = { role: 'user', content: text }
    setMessages((prev) => [...prev, userMsg])
    setLoading(true)
    try {
      const history = messages.map((m) => ({ role: m.role === 'bot' ? 'assistant' : 'user', content: m.content }))
      const res = await chat.sendMessage(text, history)
      setMessages((prev) => [...prev, { role: 'bot', content: res?.reply || 'Sorry, I could not get a response.' }])
    } catch {
      setMessages((prev) => [...prev, { role: 'bot', content: 'Sorry, I ran into an error. Please try again.' }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      {open && (
        <div className="chatbot-panel">
          <div className="chatbot-panel-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--gradient-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              </div>
              <span>Career Assistant</span>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} style={{ padding: '0.2rem 0.4rem', fontSize: '1rem', lineHeight: 1 }}>×</button>
          </div>
          <div className="chatbot-messages">
            {messages.map((msg, i) => (
              <div key={`msg-${i}`} className={`chat-bubble ${msg.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-bot'}`}>
                {msg.content}
              </div>
            ))}
            {loading && (
              <div className="chat-bubble chat-bubble-bot" style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                <span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 2, borderTopColor: 'var(--accent)' }} />
                <span style={{ fontSize: '0.82rem' }}>Thinking…</span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="chatbot-input-row">
            <input
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage() } }}
              placeholder="Ask about careers or skills…"
              disabled={loading}
              style={{ flex: 1, borderRadius: 'var(--radius-lg)' }}
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={() => { void sendMessage() }} disabled={loading || !input.trim()} style={{ flexShrink: 0 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
      )}
      <button type="button" className="chatbot-fab" onClick={() => setOpen((prev) => !prev)} title="Career Assistant">
        {open
          ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>}
      </button>
    </>
  )
}

function CandidateHome() {
  const navigate = useNavigate()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

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
  const avgPct = useMemo(() => {
    const submitted = rows.filter((row) => typeof row?.percentage === 'number')
    if (!submitted.length) return 0
    return submitted.reduce((acc, row) => acc + Number(row.percentage || 0), 0) / submitted.length
  }, [rows])

  return (
    <>
    <main className="main">
      <div className="dashboard-page">
        <div className="page-header-row">
          <div>
            <p className="eyebrow">Candidate Portal</p>
            <h1 className="page-title">My Assessments</h1>
            <p className="page-subtitle">Track your attempted exams, scores, and current status.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/careers')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
            Browse Careers
          </button>
        </div>

        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
          {[
            { label: 'Total Attempts', value: attemptedCount, color: 'kpi-icon-indigo', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/></svg> },
            { label: 'Submitted', value: submittedCount, color: 'kpi-icon-purple', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> },
            { label: 'Passed', value: passedCount, color: 'kpi-icon-green', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> },
            { label: 'Avg Score', value: submittedCount ? `${avgPct.toFixed(1)}%` : '—', color: 'kpi-icon-cyan', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg> },
          ].map(({ label, value, color, icon }) => (
            <div key={label} className="kpi-card" style={{ aspectRatio: '1/1', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
              <div className={`kpi-icon-badge ${color}`} style={{ width: 44, height: 44, borderRadius: 12, marginBottom: 'auto' }}>{icon}</div>
              <div>
                <div className="card-value" style={{ fontSize: '2rem', lineHeight: 1.1, marginBottom: '0.35rem' }}>{value}</div>
                <div className="card-subtitle">{label}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Exam Attempts</div>
              <div className="card-subtitle">{rows.length} record(s)</div>
            </div>
            <div style={{ minWidth: 180 }}>
              <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                <option value="created">Created</option>
                <option value="in_progress">In progress</option>
                <option value="submitted">Submitted</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
          </div>

          {error ? <div className="error-banner">{error}</div> : null}
          {loading ? (
            <div style={{ padding: '2rem 0', textAlign: 'center' }}>
              <span className="loading-spinner" style={{ width: 24, height: 24, borderWidth: 3 }} />
              <p className="muted" style={{ marginTop: '0.75rem' }}>Loading your assessments…</p>
            </div>
          ) : null}

          {!loading && !rows.length ? (
            <div className="empty-state">
              <div className="empty-state-title">No assessment attempts yet</div>
              <div className="empty-state-desc">When an exam is assigned to you, it will appear here.</div>
            </div>
          ) : null}

          {!loading && rows.length ? (
            <div className="table-wrap">
              <table className="table" aria-label="My assessment attempts">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Session</th>
                    <th>Status</th>
                    <th>Score</th>
                    <th>Started</th>
                    <th>Submitted</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const code = String(row?.session_code || '').trim()
                    const status = String(row?.status || '').toLowerCase()
                    const passed = Boolean(row?.passed)
                    const rowStyle = status === 'submitted' && passed
                      ? { background: 'rgba(34,197,94,0.04)', borderLeft: '3px solid #22c55e' }
                      : status === 'submitted' && !passed
                        ? { background: 'rgba(239,68,68,0.04)', borderLeft: '3px solid #ef4444' }
                        : {}
                    return (
                      <tr key={code || `row-${idx}`} style={rowStyle}>
                        <td style={{ fontWeight: 600 }}>{row.job_title || '—'}</td>
                        <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '0.82rem' }}>{code || '—'}</td>
                        <td>
                          <span className={`badge-soft ${status === 'submitted' && passed ? 'badge-green' : status === 'submitted' ? 'badge-red' : ''}`}>
                            {row.status || '—'}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600 }}>{scoreLabel(row)}</td>
                        <td>{fmtDate(row.started_at)}</td>
                        <td>{fmtDate(row.submitted_at)}</td>
                        <td>
                          {code ? (
                            <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate(`/assessment?code=${encodeURIComponent(code)}`)}>
                              Open
                            </button>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    </main>
    <ChatBot />
    </>
  )
}

export default CandidateHome
