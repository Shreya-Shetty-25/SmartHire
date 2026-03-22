import { useEffect, useMemo, useRef, useState } from 'react'
import { assessmentApi } from '../assessmentApi'

function formatDate(value) {
  if (!value) return '—'
  try {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return String(value)
    return d.toLocaleString()
  } catch {
    return String(value)
  }
}

function shortJson(value, max = 220) {
  if (!value) return ''
  try {
    const text = JSON.stringify(value)
    if (text.length <= max) return text
    return `${text.slice(0, max)}…`
  } catch {
    const text = String(value)
    return text.length <= max ? text : `${text.slice(0, max)}…`
  }
}

function severityLabel(severity) {
  const s = String(severity || 'low').toLowerCase()
  if (s === 'high') return 'high'
  if (s === 'medium') return 'medium'
  return 'low'
}

function fmtScore(row) {
  if (!row) return '—'
  const score = row.score
  const total = row.total
  const pct = row.percentage
  const left = score != null && total != null ? `${score}/${total}` : '—'
  const right = pct != null ? `${Number(pct).toFixed(1)}%` : '—'
  return `${left} · ${right}`
}

function formatSignal(signal) {
  if (!signal) return ''
  const label = signal.label || signal.event_type || 'signal'
  const count = signal.count != null ? `×${signal.count}` : ''
  const sev = signal.severity ? `(${severityLabel(signal.severity)})` : ''
  return `${label} ${count} ${sev}`.replace(/\s+/g, ' ').trim()
}

function AssessmentDetails() {
  const PASS_THRESHOLD = 60
  const [sessions, setSessions] = useState([])
  const [selectedCode, setSelectedCode] = useState('')
  const [detail, setDetail] = useState(null)
  const [loadingList, setLoadingList] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [loadingAction, setLoadingAction] = useState(false)
  const [error, setError] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const dialogRef = useRef(null)

  const severity = detail?.severity || { low: 0, medium: 0, high: 0 }

  const selectedSummary = useMemo(() => {
    if (!detail) return ''
    const pct = detail.percentage != null ? `${Number(detail.percentage).toFixed(1)}%` : '—'
    const score = detail.score != null && detail.total != null ? `${detail.score}/${detail.total}` : '—'
    return `${score} · ${pct} · ${detail.status || '—'}`
  }, [detail])

  async function loadList() {
    setError('')
    setLoadingList(true)
    try {
      const data = await assessmentApi.adminListExams({
        assessmentType: '',
        candidateEmail: '',
        limit: 50,
        offset: 0,
      })
      setSessions(Array.isArray(data) ? data : [])
      if (Array.isArray(data) && data.length > 0 && !selectedCode) {
        setSelectedCode(data[0].session_code)
      }
    } catch (err) {
      setError(err?.message || 'Failed to load exams')
    } finally {
      setLoadingList(false)
    }
  }

  async function loadDetail(code) {
    if (!code) return
    setError('')
    setLoadingDetail(true)
    try {
      const data = await assessmentApi.adminGetExamDetail(code, { assessmentType: '' })
      setDetail(data)
    } catch (err) {
      setDetail(null)
      setError(err?.message || 'Failed to load exam detail')
    } finally {
      setLoadingDetail(false)
    }
  }

  function openDetail(code) {
    if (code) setSelectedCode(code)
    setModalOpen(true)
  }

  function closeModal() {
    setModalOpen(false)
  }

  async function scheduleCallInterview() {
    if (!selectedCode || loadingAction) return
    setActionMessage('')
    setActionError('')
    setLoadingAction(true)
    try {
      const res = await assessmentApi.adminScheduleCall(selectedCode, {
        thresholdPercentage: PASS_THRESHOLD,
        delaySeconds: 60,
      })
      setActionMessage(res?.message || 'Interview call scheduled.')
      await loadDetail(selectedCode)
      await loadList()
    } catch (err) {
      setActionError(err?.message || 'Failed to schedule interview call')
    } finally {
      setLoadingAction(false)
    }
  }

  async function rejectCandidate() {
    if (!selectedCode || loadingAction) return
    const ok = window.confirm('Reject this candidate now? This will mark the session as rejected.')
    if (!ok) return

    setActionMessage('')
    setActionError('')
    setLoadingAction(true)
    try {
      const res = await assessmentApi.adminRejectCandidate(selectedCode)
      setActionMessage(res?.message || 'Candidate rejected.')
      await loadDetail(selectedCode)
      await loadList()
    } catch (err) {
      setActionError(err?.message || 'Failed to reject candidate')
    } finally {
      setLoadingAction(false)
    }
  }

  useEffect(() => {
    const dlg = dialogRef.current
    if (!dlg) return

    if (modalOpen) {
      try {
        if (!dlg.open) dlg.showModal()
      } catch {
        // ignore
      }
    } else {
      try {
        if (dlg.open) dlg.close()
      } catch {
        // ignore
      }
    }
  }, [modalOpen])

  useEffect(() => {
    loadList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selectedCode) return
    loadDetail(selectedCode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode])

  return (
    <main className="main">
      <div className="page">
        <div className="page-header">
          <h1 className="page-title">Assessment Details</h1>
          <p className="page-subtitle">Click a candidate row to view readable insights and the cached AI conclusion.</p>
        </div>

        {error ? (
          <div className="card">
            <div className="card-title">Error</div>
            <div className="muted" style={{ marginTop: 8 }}>{error}</div>
          </div>
        ) : null}

        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Candidate Sessions</div>
              <div className="card-subtitle">Name · Score · Assessment type</div>
            </div>
            <button type="button" className="btn btn-ghost" onClick={loadList} disabled={loadingList}>
              {loadingList ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {(sessions || []).length === 0 ? (
            <div className="muted">No sessions found.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '10px 8px', fontSize: 12, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>Candidate</th>
                    <th style={{ textAlign: 'left', padding: '10px 8px', fontSize: 12, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>Score</th>
                    <th style={{ textAlign: 'left', padding: '10px 8px', fontSize: 12, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>Assessment type</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((row) => {
                    return (
                      <tr
                        key={row.session_code}
                        onClick={() => openDetail(row.session_code)}
                        style={{
                          cursor: 'pointer',
                        }}
                      >
                        <td style={{ padding: '10px 8px', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ fontWeight: 650 }}>{row.candidate_name}</div>
                          <div className="muted">{row.candidate_email}</div>
                          <div className="muted">{row.session_code}</div>
                        </td>
                        <td style={{ padding: '10px 8px', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ fontWeight: 650 }}>{fmtScore(row)}</div>
                          <div className="muted">{row.status}</div>
                        </td>
                        <td style={{ padding: '10px 8px', borderBottom: '1px solid var(--border)' }}>
                          <span className="chip">{row.assessment_type || 'onscreen'}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <dialog
          ref={dialogRef}
          className="modal-dialog"
          onClose={closeModal}
          onClick={(e) => {
            if (e.target === dialogRef.current) closeModal()
          }}
        >
          <div className="card modal-card">
            <div className="card-header">
              <div>
                <div className="card-title">Detailed Analysis</div>
                <div className="card-subtitle">{selectedCode || '—'}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {detail ? <span className="badge-soft">{selectedSummary}</span> : null}
                <button type="button" className="btn btn-reject" onClick={rejectCandidate} disabled={loadingAction || !detail}>
                  {loadingAction ? 'Please wait…' : 'Reject Candidate'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={closeModal}>Close</button>
              </div>
            </div>

            {error ? (
              <div className="muted">{error}</div>
            ) : null}

            {actionError ? <div className="alert alert-danger">{actionError}</div> : null}
            {actionMessage ? <div className="alert alert-success">{actionMessage}</div> : null}

            {loadingDetail ? <div className="muted">Loading details…</div> : null}

            {!loadingDetail && !detail ? <div className="muted">No session selected.</div> : null}

            {detail ? (
              <>
                <div className="chip-row" style={{ marginTop: 0 }}>
                  <span className="chip">Assessment type: {detail.assessment_type}</span>
                  <span className="chip">Job: {detail.job_title || '—'}</span>
                  <span className="chip">Started: {formatDate(detail.started_at)}</span>
                  <span className="chip">Submitted: {formatDate(detail.submitted_at)}</span>
                  <span className="chip">Call status: {detail.call_status || 'not_scheduled'}</span>
                </div>

                {Number(detail.percentage || 0) >= PASS_THRESHOLD && detail.status !== 'rejected' ? (
                  <div className="actions-row" style={{ marginTop: 12 }}>
                    <button type="button" className="btn btn-primary" onClick={scheduleCallInterview} disabled={loadingAction}>
                      {loadingAction ? 'Scheduling…' : 'Schedule Call Interview'}
                    </button>
                    <span className="muted">Email is sent immediately, and the call starts in about 1 minute.</span>
                  </div>
                ) : null}

                <div className="card ai-panel" style={{ padding: 14, marginTop: 14 }}>
                  <div className="card-title">AI Conclusion</div>
                  <div className="muted" style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    Recommendation:{' '}
                    <span className={`pill pill-${String(detail.ai_summary?.recommendation || 'neutral').toLowerCase()}`}>
                      {detail.ai_summary?.recommendation || '—'}
                    </span>
                    {detail.ai_summary?.risk_level ? <span className="pill pill-risk">Risk: {detail.ai_summary.risk_level}</span> : null}
                  </div>
                  <div style={{ marginTop: 8 }}>{detail.ai_summary?.conclusion || '—'}</div>
                  {Array.isArray(detail.ai_summary?.rationale) ? (
                    <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
                      {detail.ai_summary.rationale.slice(0, 6).map((item, idx) => (
                        <div key={`${shortJson(item)}-${idx}`} className="muted">• {String(item)}</div>
                      ))}
                    </div>
                  ) : null}
                  {detail.ai_summary?.model ? (
                    <div className="muted" style={{ marginTop: 10 }}>Model: {detail.ai_summary.model}</div>
                  ) : null}
                </div>

                <div className="dashboard-grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 14 }}>
                  <div className="card" style={{ padding: 14, background: 'var(--bg-soft)' }}>
                    <div className="card-title">Green Signals</div>
                    <div className="muted" style={{ marginTop: 6 }}>Positive/neutral signals recorded.</div>
                    <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                      {(detail.green_signals || []).length === 0 ? (
                        <div className="muted">No green signals recorded.</div>
                      ) : (
                        (detail.green_signals || []).slice(0, 12).map((s, idx) => (
                          <div key={`${s.event_type}-${idx}`} className="signal-card signal-green">
                            <div style={{ fontWeight: 650 }}>{formatSignal(s)}</div>
                            <div className="muted">{s.last_at ? `Last seen: ${formatDate(s.last_at)}` : ''}</div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="card" style={{ padding: 14, background: 'var(--bg-soft)' }}>
                    <div className="card-title">Red Signals</div>
                    <div className="muted" style={{ marginTop: 6 }}>Potential policy violations / suspicious activity.</div>
                    <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                      {(detail.red_signals || []).length === 0 ? (
                        <div className="muted">No red signals recorded.</div>
                      ) : (
                        (detail.red_signals || []).slice(0, 12).map((s, idx) => (
                          <div key={`${s.event_type}-${idx}`} className="signal-card signal-red">
                            <div style={{ fontWeight: 650 }}>{formatSignal(s)}</div>
                            <div className="muted">{s.last_at ? `Last seen: ${formatDate(s.last_at)}` : ''}</div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div className="card" style={{ padding: 14, background: 'var(--bg-soft)', marginTop: 14 }}>
                  <div className="card-title">Severity Summary</div>
                  <div className="chip-row">
                    <span className="chip">Low: {severity.low || 0}</span>
                    <span className="chip">Medium: {severity.medium || 0}</span>
                    <span className="chip">High: {severity.high || 0}</span>
                  </div>
                </div>

                <div className="card" style={{ padding: 14, background: 'var(--bg-soft)', marginTop: 14 }}>
                  <div className="card-title">Call Interview Logs</div>
                  <div className="muted" style={{ marginTop: 6 }}>Shows call scheduling, call lifecycle, and transcript-turn logs.</div>
                  <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                    {(detail.call_interview_logs || []).length === 0 ? (
                      <div className="muted">No call interview logs yet.</div>
                    ) : (
                      (detail.call_interview_logs || []).slice(-20).reverse().map((item, idx) => (
                        <div key={`${String(item.type || 'log')}-${idx}`} className="signal-card signal-call">
                          <div style={{ fontWeight: 650 }}>{String(item.type || 'log').replace(/_/g, ' ')}</div>
                          <div className="muted">{item.timestamp ? formatDate(item.timestamp) : '—'} · {item.source || 'unknown'}</div>
                          <div className="muted" style={{ marginTop: 6 }}>{shortJson(item.payload, 300)}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </dialog>
      </div>
    </main>
  )
}

export default AssessmentDetails
