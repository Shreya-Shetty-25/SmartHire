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
  return label
}

function severityIcon(sev) {
  const s = String(sev || 'low').toLowerCase()
  if (s === 'high') return '🔴'
  if (s === 'medium') return '🟡'
  return '🟢'
}

function proctorLabel(eventType) {
  const map = {
    'camera_analysis': 'Webcam Integrity Check',
    'audio_check': 'Audio Check',
    'no_face_detected': 'Face Not Visible',
    'multiple_faces_detected': 'Multiple Faces in Frame',
    'suspicious_eye_movement': 'Eyes Looked Away from Screen',
    'suspicious_head_movement': 'Head Turned Away from Screen',
    'suspicious_object_detected': 'Phone / Device Detected in Frame',
    'audio_anomaly_detected': 'Unusual Background Audio',
    'voice_activity_detected': 'Speaking Detected During Exam',
    'speech_detected': 'Speech / Conversation Detected',
    'speech_recognition': 'Speech Transcript Captured',
    'tab_switched': 'Switched Away from Exam Tab',
    'window_blur': 'Exam Window Lost Focus',
    'fullscreen_exited': 'Exited Fullscreen Mode',
    'devtools_detected': 'Browser Developer Tools Opened',
    'shortcut_burst_detected': 'Rapid Keyboard Shortcuts Used',
    'network_offline': 'Internet Connection Lost',
    'exam_started': 'Exam Started',
    'exam_submitted': 'Exam Submitted',
    'exam_scored': 'Exam Scored',
    'face_id_verification': 'Face vs ID Photo Match',
    'multiple_tabs_detected': 'Multiple Exam Tabs Opened',
    'call_interview_hr_prompt': 'Interviewer Prompt',
    'call_interview_candidate_response': 'Candidate Response',
    'call_interview_call_initiated': 'Call Initiated',
    'call_interview_completed': 'Call Completed',
    'call_interview_email_scheduled': 'Interview Scheduled',
    'call_interview_call_failed': 'Call Failed',
  }
  return map[eventType] || (eventType || 'event').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function proctorDesc(eventType) {
  const map = {
    'camera_analysis': 'Periodic webcam frame analyzed for faces, objects, and gaze direction',
    'no_face_detected': 'Candidate\'s face was not visible in the camera feed',
    'multiple_faces_detected': 'More than one person was detected in the webcam',
    'suspicious_eye_movement': 'Candidate\'s gaze moved away from the exam screen repeatedly',
    'suspicious_head_movement': 'Candidate\'s head turned significantly away from the screen',
    'suspicious_object_detected': 'A phone, second device, or prohibited object was spotted on camera',
    'audio_anomaly_detected': 'Unusual audio pattern detected — possible external help',
    'voice_activity_detected': 'Microphone picked up speaking during a silent exam section',
    'speech_detected': 'Actual words / conversation detected through microphone',
    'speech_recognition': 'Transcript of detected speech was captured',
    'tab_switched': 'Candidate navigated away from the exam browser tab',
    'window_blur': 'The exam window lost focus (e.g., switched to another app)',
    'fullscreen_exited': 'Candidate exited the required fullscreen mode',
    'devtools_detected': 'Browser developer tools were opened during the exam',
    'shortcut_burst_detected': 'Rapid keyboard shortcuts suggesting copy-paste or search',
    'network_offline': 'Candidate\'s internet connection dropped during the exam',
    'face_id_verification': 'Comparison between live face and uploaded ID photo',
    'multiple_tabs_detected': 'Multiple exam tabs were detected open simultaneously',
    'exam_started': 'The candidate started their assessment',
    'exam_submitted': 'The candidate submitted their answers',
    'exam_scored': 'The exam was auto-graded',
  }
  return map[eventType] || null
}

function severityTag(sev) {
  const s = String(sev || 'low').toLowerCase()
  if (s === 'high') return { label: 'High', bg: '#fef2f2', color: '#dc2626', border: '#fca5a5' }
  if (s === 'medium') return { label: 'Medium', bg: '#fffbeb', color: '#d97706', border: '#fcd34d' }
  return { label: 'Low', bg: '#f0fdf4', color: '#16a34a', border: '#86efac' }
}

function AssessmentDetails() {
  const PASS_THRESHOLD = 60
  const [sessions, setSessions] = useState([])
  const [search, setSearch] = useState('')
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

  const filteredSessions = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return sessions
    return sessions.filter((s) =>
      (s.candidate_name || '').toLowerCase().includes(q) ||
      (s.candidate_email || '').toLowerCase().includes(q) ||
      (s.session_code || '').toLowerCase().includes(q) ||
      (s.assessment_type || '').toLowerCase().includes(q) ||
      (s.status || '').toLowerCase().includes(q)
    )
  }, [sessions, search])

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
          <p className="page-subtitle">Review candidate assessment results, proctoring insights and AI conclusions.</p>
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
              <div className="card-title">Candidate Assessments</div>
              <div className="card-subtitle">{filteredSessions.length} of {sessions.length} candidates</div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={loadList} disabled={loadingList}>
              {loadingList ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          <div className="search-bar">
            <span className="search-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </span>
            <input className="input" placeholder="Search by name, email, code, or status…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          {filteredSessions.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">{search ? 'No matching candidates' : 'No assessments found'}</div>
              <div className="empty-state-desc">{search ? 'Try a different search term.' : 'Assessment results will appear here after candidates take exams.'}</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table" aria-label="Assessment sessions table">
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Score</th>
                    <th>Status</th>
                    <th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSessions.map((row) => (
                    <tr key={row.session_code} onClick={() => openDetail(row.session_code)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{row.candidate_name || '—'}</div>
                        <div className="muted">{row.candidate_email}</div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 650 }}>{fmtScore(row)}</div>
                      </td>
                      <td>
                        <span className={`badge-soft ${row.status === 'submitted' && row.passed ? 'badge-green' : row.status === 'submitted' ? 'badge-red' : ''}`}>
                          {row.status || '—'}
                        </span>
                      </td>
                      <td><span className="chip">{row.assessment_type || 'onscreen'}</span></td>
                    </tr>
                  ))}
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
                    <div className="muted" style={{ marginTop: 10 }}>
                      Analysis: {detail.ai_summary.model.includes('rule_based') ? 'Automated rule-based assessment' : `AI-powered (${detail.ai_summary.model})`}
                    </div>
                  ) : null}
                </div>

                <div className="dashboard-grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 14 }}>
                  <div className="card" style={{ padding: 14, background: 'var(--bg-soft)' }}>
                    <div className="card-title">✅ Compliant Activity</div>
                    <div className="muted" style={{ marginTop: 6 }}>Normal exam behavior and completed checks.</div>
                    <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                      {(detail.green_signals || []).length === 0 ? (
                        <div className="muted">No activity recorded yet.</div>
                      ) : (
                        (detail.green_signals || []).slice(0, 12).map((s, idx) => {
                          const st = severityTag(s.severity)
                          return (
                            <div key={`${s.event_type}-${idx}`} className="signal-card signal-green" style={{ padding: '10px 12px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{proctorLabel(s.event_type) || formatSignal(s)}</div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {s.count > 1 ? <span className="badge-soft" style={{ fontSize: '0.72rem' }}>{s.count}×</span> : null}
                                  <span style={{ fontSize: '0.68rem', padding: '1px 6px', borderRadius: 6, background: st.bg, color: st.color, border: `1px solid ${st.border}`, fontWeight: 600 }}>{st.label}</span>
                                </div>
                              </div>
                              {proctorDesc(s.event_type) ? <div className="muted" style={{ fontSize: '0.76rem', marginTop: 3 }}>{proctorDesc(s.event_type)}</div> : null}
                              {Array.isArray(s.details) && s.details.length > 0 ? (
                                <ul style={{ margin: '4px 0 0', paddingLeft: '1rem', fontSize: '0.76rem', color: '#4b5563', display: 'grid', gap: 1 }}>
                                  {s.details.map((d, di) => <li key={di}>{d}</li>)}
                                </ul>
                              ) : null}
                              <div className="muted" style={{ fontSize: '0.72rem', marginTop: 2 }}>{s.last_at ? formatDate(s.last_at) : ''}</div>
                            </div>
                          )
                        })
                      )}
                    </div>
                  </div>

                  <div className="card" style={{ padding: 14, background: 'var(--bg-soft)' }}>
                    <div className="card-title">⚠️ Flagged Activity</div>
                    <div className="muted" style={{ marginTop: 6 }}>Policy violations and suspicious behavior detected.</div>
                    <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                      {(detail.red_signals || []).length === 0 ? (
                        <div className="muted">No suspicious activity detected.</div>
                      ) : (
                        (detail.red_signals || []).slice(0, 12).map((s, idx) => {
                          const st = severityTag(s.severity)
                          return (
                            <div key={`${s.event_type}-${idx}`} className="signal-card signal-red" style={{ padding: '10px 12px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{proctorLabel(s.event_type) || formatSignal(s)}</div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span className="badge-soft badge-red" style={{ fontSize: '0.72rem' }}>{s.count || 1}×</span>
                                  <span style={{ fontSize: '0.68rem', padding: '1px 6px', borderRadius: 6, background: st.bg, color: st.color, border: `1px solid ${st.border}`, fontWeight: 600 }}>{st.label}</span>
                                </div>
                              </div>
                              {proctorDesc(s.event_type) ? <div style={{ fontSize: '0.76rem', marginTop: 3, color: '#6b7280' }}>{proctorDesc(s.event_type)}</div> : null}
                              {Array.isArray(s.details) && s.details.length > 0 ? (
                                <ul style={{ margin: '4px 0 0', paddingLeft: '1rem', fontSize: '0.76rem', color: '#dc2626', display: 'grid', gap: 1 }}>
                                  {s.details.map((d, di) => <li key={di}>{d}</li>)}
                                </ul>
                              ) : null}
                              <div className="muted" style={{ fontSize: '0.72rem', marginTop: 2 }}>{s.last_at ? formatDate(s.last_at) : ''}</div>
                            </div>
                          )
                        })
                      )}
                    </div>
                  </div>
                </div>

                <div className="card" style={{ padding: 14, background: 'var(--bg-soft)', marginTop: 14 }}>
                  <div className="card-title">Proctoring Summary</div>
                  <div className="chip-row" style={{ marginTop: 8 }}>
                    <span className="chip" style={{ background: '#f0fdf4', borderColor: '#86efac', color: '#166534' }}>🟢 Low: {severity.low || 0}</span>
                    <span className="chip" style={{ background: '#fffbeb', borderColor: '#fcd34d', color: '#92400e' }}>🟡 Medium: {severity.medium || 0}</span>
                    <span className="chip" style={{ background: '#fef2f2', borderColor: '#fca5a5', color: '#991b1b' }}>🔴 High: {severity.high || 0}</span>
                  </div>
                </div>

                <div className="card" style={{ padding: 14, background: 'var(--bg-soft)', marginTop: 14 }}>
                  <div className="card-title">Call Interview Logs</div>
                  <div className="muted" style={{ marginTop: 6 }}>Shows call scheduling, call lifecycle, and transcript-turn logs.</div>
                  <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                    {(detail.call_interview_logs || []).length === 0 ? (
                      <div className="muted">No call interview logs yet.</div>
                    ) : (
                      (detail.call_interview_logs || []).slice(-20).reverse().map((item, idx) => {
                        const p = item.payload || {}
                        const isTranscript = item.type === 'call_interview_hr_prompt' || item.type === 'call_interview_candidate_response'
                        return (
                          <div key={`${String(item.type || 'log')}-${idx}`} className="signal-card signal-call">
                            <div style={{ fontWeight: 650 }}>{String(item.type || 'log').replace(/_/g, ' ')}</div>
                            <div className="muted">{item.timestamp ? formatDate(item.timestamp) : '—'} · {item.source || 'unknown'}{p.hr_turn ? ` · Turn ${p.hr_turn}` : ''}</div>
                            {isTranscript ? (
                              <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
                                {p.candidate_speech ? (
                                  <div style={{ padding: '6px 10px', borderRadius: 6, background: 'var(--bg-card, #f4f4f5)' }}>
                                    <span style={{ fontWeight: 600, color: 'var(--accent, #2563eb)' }}>Candidate: </span>
                                    <span>{p.candidate_speech}</span>
                                  </div>
                                ) : null}
                                {p.interviewer_text ? (
                                  <div style={{ padding: '6px 10px', borderRadius: 6, background: 'var(--bg-card, #f4f4f5)' }}>
                                    <span style={{ fontWeight: 600, color: 'var(--text-heading, #1e293b)' }}>Interviewer: </span>
                                    <span>{p.interviewer_text}</span>
                                  </div>
                                ) : null}
                              </div>
                            ) : (
                              <div className="muted" style={{ marginTop: 6 }}>{shortJson(p, 300)}</div>
                            )}
                          </div>
                        )
                      })
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
