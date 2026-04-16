import { useEffect, useMemo, useState } from 'react'
import { candidates, insights } from '../api'

const PIPELINE_STAGES = ['applied', 'shortlisted', 'assessment_sent', 'assessment_in_progress', 'assessment_passed', 'assessment_failed', 'interview_scheduled', 'interview_completed', 'rejected', 'hired']

const STAGE_LABELS = {
  applied: 'Applied',
  shortlisted: 'Shortlisted',
  assessment_sent: 'Assessment Sent',
  assessment_in_progress: 'Assessment In Progress',
  assessment_passed: 'Assessment Passed',
  assessment_failed: 'Assessment Failed',
  interview_scheduled: 'Interview Scheduled',
  interview_completed: 'Interview Completed',
  rejected: 'Rejected',
  hired: 'Hired',
}

function stageLabel(s) { return STAGE_LABELS[s] || (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) }

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) {
    return value.length ? value.join(', ') : '—'
  }
  return String(value)
}

function parseFilenameFromContentDisposition(headerValue) {
  if (!headerValue) return null
  const match = /filename\*?=(?:UTF-8''|"?)([^";]+)"?/i.exec(headerValue)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

function Candidates() {
  const token = useMemo(() => localStorage.getItem('token'), [])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  const [selectedCandidate, setSelectedCandidate] = useState(null)
  const [loadingCandidate, setLoadingCandidate] = useState(false)
  const [savingProgressId, setSavingProgressId] = useState('')

  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [jobFilter, setJobFilter] = useState('all')

  // AI Insights
  const [insightSummaries, setInsightSummaries] = useState({})
  const [insightDetail, setInsightDetail] = useState(null)
  const [analyzingId, setAnalyzingId] = useState(null)

  const allJobTitles = useMemo(() => {
    const set = new Set()
    for (const c of rows) {
      for (const j of (c.job_titles || [])) set.add(j)
    }
    return Array.from(set).sort()
  }, [rows])

  const filteredRows = useMemo(() => {
    let list = rows
    if (jobFilter !== 'all') {
      list = list.filter((c) => (c.job_titles || []).includes(jobFilter))
    }
    const q = search.toLowerCase().trim()
    if (!q) return list
    return list.filter((c) =>
      (c.full_name || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.phone_number || '').toLowerCase().includes(q) ||
      (c.skills || []).join(' ').toLowerCase().includes(q) ||
      (c.location || '').toLowerCase().includes(q)
    )
  }, [rows, search, jobFilter])

  const loadCandidates = async () => {
    if (!token) {
      setError('Missing token. Please log in again.')
      setLoading(false)
      return
    }

    setError('')
    setLoading(true)
    try {
      const data = await candidates.list(token)
      setRows(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err?.message || 'Failed to load candidates')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadCandidates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load insight summaries for all candidates once rows are loaded
  useEffect(() => {
    if (!token || rows.length === 0) return
    rows.forEach(async (c) => {
      try {
        const summary = await insights.getSummary(token, c.id)
        setInsightSummaries((prev) => ({ ...prev, [c.id]: summary }))
      } catch {
        // ignore – insights may not be available yet
      }
    })
  }, [rows, token])

  const onAnalyzeInsights = async (candidateId) => {
    if (!token) return
    setAnalyzingId(candidateId)
    try {
      await insights.analyzeAll(token, candidateId)
      const summary = await insights.getSummary(token, candidateId)
      setInsightSummaries((prev) => ({ ...prev, [candidateId]: summary }))
      // If modal is open for this candidate, also load detail
      if (selectedCandidate?.id === candidateId) {
        const [rf, sd, mem] = await Promise.all([
          insights.getRedFlags(token, candidateId),
          insights.getSkillDecay(token, candidateId),
          insights.getCandidateMemory(token, candidateId),
        ])
        setInsightDetail({ redFlags: rf, skillDecay: sd, memory: mem })
      }
    } catch (err) {
      setError(err?.message || 'AI analysis failed')
    } finally {
      setAnalyzingId(null)
    }
  }

  const onUpload = async (event) => {
    event.preventDefault()

    if (!token) {
      setError('Missing token. Please log in again.')
      return
    }

    if (!file) {
      setError('Please choose a PDF file to upload.')
      return
    }

    if (file.type && file.type !== 'application/pdf') {
      setError('Only PDF files are supported.')
      return
    }

    setError('')
    setUploading(true)
    try {
      const created = await candidates.uploadResume(token, file)
      setRows((prev) => {
        const next = Array.isArray(prev) ? [...prev] : []
        const createdId = Number(created?.id || 0)
        const createdEmail = String(created?.email || '').trim().toLowerCase()
        const filtered = next.filter((row) => {
          if (createdId && Number(row?.id || 0) === createdId) return false
          if (createdEmail && String(row?.email || '').trim().toLowerCase() === createdEmail) return false
          return true
        })
        return [created, ...filtered]
      })
      setFile(null)
    } catch (err) {
      setError(err?.message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const onViewResume = async (candidateId) => {
    if (!token) {
      setError('Missing token. Please log in again.')
      return
    }

    setError('')
    try {
      const { blob, contentDisposition } = await candidates.downloadResume(token, candidateId)
      const filename = parseFilenameFromContentDisposition(contentDisposition) || 'resume.pdf'
      const url = URL.createObjectURL(blob)

      const newTab = window.open(url, '_blank', 'noopener,noreferrer')
      if (!newTab) {
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        document.body.appendChild(link)
        link.click()
        link.remove()
      }

      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (err) {
      setError(err?.message || 'Failed to load resume PDF')
    }
  }

  const onOpenCandidate = async (candidate) => {
    if (!token) return
    setLoadingCandidate(true)
    setSelectedCandidate(candidate)
    setInsightDetail(null)
    try {
      const [detail, rf, sd, mem] = await Promise.all([
        candidates.get(token, candidate.id),
        insights.getRedFlags(token, candidate.id).catch(() => null),
        insights.getSkillDecay(token, candidate.id).catch(() => null),
        insights.getCandidateMemory(token, candidate.id).catch(() => null),
      ])
      setSelectedCandidate(detail)
      setInsightDetail({ redFlags: rf, skillDecay: sd, memory: mem })
    } catch (err) {
      setError(err?.message || 'Failed to load candidate details')
    } finally {
      setLoadingCandidate(false)
    }
  }

  const onCloseModal = () => {
    setSelectedCandidate(null)
  }

  const onModalKeyDown = (event) => {
    if (event.key === 'Escape') {
      onCloseModal()
    }
  }

  const onChangeProgressField = (jobId, field, value) => {
    setSelectedCandidate((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        job_progress: (prev.job_progress || []).map((progress) =>
          Number(progress.job_id) === Number(jobId) ? { ...progress, [field]: value } : progress
        ),
      }
    })
  }

  const onSaveProgress = async (progress) => {
    if (!token || !selectedCandidate?.id || !progress?.job_id) return
    setSavingProgressId(String(progress.job_id))
    setError('')
    try {
      const updated = await candidates.updateProgress(token, selectedCandidate.id, progress.job_id, {
        stage: progress.stage,
        recruiter_notes: progress.recruiter_notes || null,
        manual_rank_score: progress.manual_rank_score === '' || progress.manual_rank_score == null ? null : Number(progress.manual_rank_score),
        manual_assessment_score: progress.manual_assessment_score === '' || progress.manual_assessment_score == null ? null : Number(progress.manual_assessment_score),
        append_history_note: progress.recruiter_notes || null,
      })
      setSelectedCandidate((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          job_progress: (prev.job_progress || []).map((item) =>
            Number(item.job_id) === Number(progress.job_id) ? updated : item
          ),
        }
      })
    } catch (err) {
      setError(err?.message || 'Failed to save candidate progress')
    } finally {
      setSavingProgressId('')
    }
  }

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header-row">
          <div>
            <p className="eyebrow">People</p>
            <h1 className="page-title">Candidates</h1>
            <p className="page-subtitle">Upload resumes and review parsed candidate profiles.</p>
          </div>
        </div>

        <article className="card" style={{ marginBottom: '1.25rem' }}>
          <div className="card-header" style={{ marginBottom: 0 }}>
            <div>
              <h2 className="card-title">Upload resume</h2>
              <p className="card-subtitle">PDF only. The backend will parse fields using your selected LLM provider.</p>
            </div>
          </div>

          <form className="form-row" onSubmit={onUpload}>
            <div className="field" style={{ marginBottom: 0, flex: 1 }}>
              <label className="label" htmlFor="resume">Resume PDF</label>
              <input
                id="resume"
                className="input"
                type="file"
                accept="application/pdf"
                onChange={(e) => setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
              />
              {file && <p style={{ marginTop: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{file.name}</p>}
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button type="submit" className="btn btn-primary" disabled={uploading}>
                {uploading ? <><span className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />&nbsp;Uploading…</> : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}><path d="M12 16V4m0 0 4 4m-4-4-4 4"/><path d="M4 20h16"/></svg>Upload</>}
              </button>
            </div>
          </form>

          {error ? <div className="error-banner">{error}</div> : null}
        </article>

        <article className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">All Candidates</h2>
              <p className="card-subtitle">{loading ? 'Loading…' : `${filteredRows.length} of ${rows.length} candidate${rows.length !== 1 ? 's' : ''}`}</p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={loadCandidates} disabled={loading}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Refresh
            </button>
          </div>

          <div className="search-bar">
            <span className="search-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </span>
            <input className="input" placeholder="Search by name, email, skill, or location…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          {allJobTitles.length > 0 && (
            <div style={{ marginBottom: '0.75rem' }}>
              <select className="input" style={{ maxWidth: 260, fontSize: '0.82rem' }} value={jobFilter} onChange={(e) => setJobFilter(e.target.value)}>
                <option value="all">All Job Roles ({rows.length})</option>
                {allJobTitles.map((j) => {
                  const count = rows.filter((c) => (c.job_titles || []).includes(j)).length
                  return <option key={j} value={j}>{j} ({count})</option>
                })}
              </select>
            </div>
          )}

          {loading ? (
            <div style={{ padding: '2rem 0', textAlign: 'center' }}>
              <span className="loading-spinner" style={{ width: 24, height: 24, borderWidth: 3 }} />
              <p className="muted" style={{ marginTop: '0.75rem' }}>Loading candidates…</p>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              </div>
              <div className="empty-state-title">{search ? 'No matching candidates' : 'No candidates yet'}</div>
              <div className="empty-state-desc">{search ? 'Try a different search term.' : 'Upload a resume to add your first candidate.'}</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table" aria-label="Candidates table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Skills</th>
                    <th>AI Insights</th>
                    <th>Location</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((candidate) => {
                    const initials = (candidate.full_name || '?').trim()[0].toUpperCase()
                    return (
                      <tr key={candidate.id} style={{ cursor: 'pointer' }} onClick={() => onOpenCandidate(candidate)}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                            <div className="table-avatar">{initials}</div>
                            <div>
                              <div style={{ fontWeight: 600, lineHeight: 1.3 }}>{formatValue(candidate.full_name)}</div>
                              <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 1 }}>{formatValue(candidate.phone_number)}</div>
                            </div>
                          </div>
                        </td>
                        <td className="table-muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatValue(candidate.email)}</td>
                        <td>
                          <div className="chip-row" style={{ marginTop: 0 }}>
                            {(candidate.skills || []).slice(0, 3).map((s) => <span key={s} className="chip">{s}</span>)}
                            {(candidate.skills || []).length > 3 ? <span className="chip">+{candidate.skills.length - 3}</span> : null}
                          </div>
                        </td>
                        <td>
                          {(() => {
                            const s = insightSummaries[candidate.id]
                            if (!s) return <span className="muted" style={{ fontSize: '0.75rem' }}>—</span>
                            return (
                              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                {s.red_flags?.available && (
                                  <span className="chip" style={{ background: s.red_flags.credibility_score >= 80 ? 'var(--green-bg, #dcfce7)' : s.red_flags.credibility_score >= 50 ? 'var(--yellow-bg, #fef9c3)' : 'var(--red-bg, #fee2e2)', color: s.red_flags.credibility_score >= 80 ? 'var(--green-text, #166534)' : s.red_flags.credibility_score >= 50 ? 'var(--yellow-text, #854d0e)' : 'var(--red-text, #991b1b)', fontWeight: 600, fontSize: '0.72rem' }} title={`Credibility: ${Math.round(s.red_flags.credibility_score)}%`}>
                                    {s.red_flags.flag_count > 0 ? `⚠ ${s.red_flags.flag_count} flag${s.red_flags.flag_count > 1 ? 's' : ''}` : '✓ Clean'}
                                  </span>
                                )}
                                {s.skill_decay?.available && s.skill_decay.stale_count > 0 && (
                                  <span className="chip" style={{ background: 'var(--yellow-bg, #fef9c3)', color: 'var(--yellow-text, #854d0e)', fontWeight: 600, fontSize: '0.72rem' }} title={`Freshness: ${Math.round(s.skill_decay.freshness_score)}%`}>
                                    ⏳ {s.skill_decay.stale_count} stale
                                  </span>
                                )}
                                {s.memory?.is_returning && (
                                  <span className="chip" style={{ background: 'var(--blue-bg, #dbeafe)', color: 'var(--blue-text, #1e40af)', fontWeight: 600, fontSize: '0.72rem' }} title={`${s.memory.previous_cycles} previous cycle(s)`}>
                                    🔄 Returning
                                  </span>
                                )}
                              </div>
                            )
                          })()}
                        </td>
                        <td className="table-muted">{formatValue(candidate.location)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end' }}>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); onViewResume(candidate.id) }}>
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>
                              PDF
                            </button>
                            <button type="button" className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); onOpenCandidate(candidate) }}>Details</button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </section>

      {selectedCandidate ? (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Candidate details"
          tabIndex={-1}
          onKeyDown={onModalKeyDown}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onCloseModal()
          }}
        >
          <div className="modal-card cand-modal">
            {/* ── Hero header ── */}
            <div className="cand-hero">
              <div className="cand-hero-avatar">
                {(selectedCandidate.full_name || '?').trim()[0].toUpperCase()}
              </div>
              <div className="cand-hero-info">
                <h2 className="cand-hero-name">{formatValue(selectedCandidate.full_name)}</h2>
                <p className="cand-hero-email">{formatValue(selectedCandidate.email)}</p>
                <div className="cand-hero-tags">
                  {selectedCandidate.location && selectedCandidate.location !== '—' && (
                    <span className="cand-tag"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>{selectedCandidate.location}</span>
                  )}
                  {selectedCandidate.phone_number && (
                    <span className="cand-tag"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>{formatValue(selectedCandidate.phone_number)}</span>
                  )}
                  <span className="cand-tag"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>{selectedCandidate.years_experience != null ? `${selectedCandidate.years_experience} yr${selectedCandidate.years_experience !== 1 ? 's' : ''} exp` : 'Fresher'}</span>
                </div>
              </div>
              <div className="cand-hero-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onViewResume(selectedCandidate.id)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>
                  View PDF
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={onCloseModal} aria-label="Close">✕</button>
              </div>
            </div>

            {/* ── Section: Education ── */}
            <div className="cand-section">
              <h3 className="cand-section-title">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c0 1.1 2.7 3 6 3s6-1.9 6-3v-5"/></svg>
                Education
              </h3>
              <div className="cand-grid-2">
                <div className="cand-field">
                  <span className="cand-field-label">College</span>
                  <span className="cand-field-value">{formatValue(selectedCandidate.college_details)}</span>
                </div>
                <div className="cand-field">
                  <span className="cand-field-label">School</span>
                  <span className="cand-field-value">{formatValue(selectedCandidate.school_details)}</span>
                </div>
              </div>
            </div>

            {/* ── Section: Skills ── */}
            <div className="cand-section">
              <h3 className="cand-section-title">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                Skills
              </h3>
              <div className="chip-row" style={{ marginTop: 0 }}>
                {(Array.isArray(selectedCandidate.skills) && selectedCandidate.skills.length > 0)
                  ? selectedCandidate.skills.map((s) => <span key={s} className="chip">{s}</span>)
                  : <span className="muted">—</span>
                }
              </div>
            </div>

            {/* ── Section: Certifications ── */}
            <div className="cand-section">
              <h3 className="cand-section-title">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>
                Certifications
              </h3>
              <p className="cand-field-value" style={{ margin: 0 }}>{formatValue(selectedCandidate.certifications)}</p>
            </div>

            {/* ── Section: Experience & Projects ── */}
            <div className="cand-section">
              <h3 className="cand-section-title">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
                Experience &amp; Projects
              </h3>
              <div className="cand-grid-2">
                <div className="cand-field">
                  <span className="cand-field-label">Work Experience</span>
                  <span className="cand-field-value">{formatValue(selectedCandidate.work_experience)}</span>
                </div>
                <div className="cand-field">
                  <span className="cand-field-label">Projects</span>
                  <span className="cand-field-value">{formatValue(selectedCandidate.projects)}</span>
                </div>
              </div>
            </div>

            {/* ── Section: Extra-curricular & Links ── */}
            <div className="cand-section">
              <h3 className="cand-section-title">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                Activities &amp; Links
              </h3>
              <div className="cand-grid-2">
                <div className="cand-field">
                  <span className="cand-field-label">Extra-curricular</span>
                  <span className="cand-field-value">{formatValue(selectedCandidate.extra_curricular_activities)}</span>
                </div>
                <div className="cand-field">
                  <span className="cand-field-label">Links</span>
                  <span className="cand-field-value">{formatValue(selectedCandidate.website_links)}</span>
                </div>
              </div>
            </div>

            {/* ── Section: AI Insights ── */}
            <div className="cand-section">
              <h3 className="cand-section-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/></svg>
                AI Insights
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  style={{ marginLeft: 'auto', fontSize: '0.75rem' }}
                  disabled={analyzingId === selectedCandidate.id}
                  onClick={(e) => { e.stopPropagation(); onAnalyzeInsights(selectedCandidate.id) }}
                >
                  {analyzingId === selectedCandidate.id ? (
                    <><span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />&nbsp;Analyzing…</>
                  ) : (
                    '🔍 Run AI Analysis'
                  )}
                </button>
              </h3>

              {!insightDetail ? (
                <p className="muted">Click "Run AI Analysis" to generate insights for this candidate.</p>
              ) : (
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  {/* Red Flags */}
                  {insightDetail.redFlags?.available && (
                    <div style={{ padding: '0.75rem', borderRadius: 8, background: insightDetail.redFlags.credibility_score >= 80 ? 'var(--green-bg, #dcfce7)' : insightDetail.redFlags.credibility_score >= 50 ? 'var(--yellow-bg, #fef9c3)' : 'var(--red-bg, #fee2e2)' }}>
                      <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: '0.3rem' }}>
                        Resume Credibility: {Math.round(insightDetail.redFlags.credibility_score)}%
                      </div>
                      <p style={{ fontSize: '0.8rem', margin: '0 0 0.4rem 0' }}>{insightDetail.redFlags.summary}</p>
                      {(insightDetail.redFlags.flags || []).length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                          {insightDetail.redFlags.flags.map((f, i) => (
                            <div key={i} style={{ fontSize: '0.78rem', padding: '0.35rem 0.5rem', borderRadius: 6, background: 'rgba(255,255,255,0.6)' }}>
                              <strong style={{ textTransform: 'capitalize' }}>{(f.type || '').replace(/_/g, ' ')}</strong>
                              <span style={{ marginLeft: 6, color: f.severity === 'high' ? '#991b1b' : f.severity === 'medium' ? '#854d0e' : '#166534' }}>
                                [{f.severity}]
                              </span>
                              <span style={{ marginLeft: 6 }}>{f.explanation}</span>
                              {f.excerpt && <div style={{ fontStyle: 'italic', marginTop: 2, color: '#555' }}>"{f.excerpt}"</div>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Skill Decay */}
                  {insightDetail.skillDecay?.available && (
                    <div style={{ padding: '0.75rem', borderRadius: 8, background: 'var(--bg-soft)' }}>
                      <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: '0.3rem' }}>
                        Skill Freshness: {Math.round(insightDetail.skillDecay.overall_freshness_score)}%
                      </div>
                      {(insightDetail.skillDecay.stale_skills || []).length > 0 && (
                        <>
                          <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.2rem' }}>Stale Skills:</div>
                          <div className="chip-row" style={{ marginTop: 0 }}>
                            {insightDetail.skillDecay.stale_skills.map((s, i) => (
                              <span key={i} className="chip" style={{ background: 'var(--yellow-bg, #fef9c3)', color: 'var(--yellow-text, #854d0e)' }} title={`${s.reason || ''} (${s.last_seen_context || ''})`}>
                                ⏳ {s.skill}
                              </span>
                            ))}
                          </div>
                        </>
                      )}
                      {(insightDetail.skillDecay.evergreen_skills || []).length > 0 && (
                        <>
                          <div style={{ fontSize: '0.8rem', fontWeight: 600, marginTop: '0.4rem', marginBottom: '0.2rem' }}>Evergreen Skills:</div>
                          <div className="chip-row" style={{ marginTop: 0 }}>
                            {insightDetail.skillDecay.evergreen_skills.map((s, i) => (
                              <span key={i} className="chip" style={{ background: 'var(--green-bg, #dcfce7)', color: 'var(--green-text, #166534)' }}>✓ {s}</span>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* Candidate Memory */}
                  {insightDetail.memory && insightDetail.memory.total_cycles > 0 && (
                    <div style={{ padding: '0.75rem', borderRadius: 8, background: 'var(--blue-bg, #dbeafe)' }}>
                      <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: '0.3rem', color: 'var(--blue-text, #1e40af)' }}>
                        🔄 Returning Candidate — {insightDetail.memory.total_cycles} previous cycle(s)
                      </div>
                      {insightDetail.memory.memories.map((m, i) => (
                        <div key={i} style={{ fontSize: '0.78rem', padding: '0.35rem 0.5rem', borderRadius: 6, background: 'rgba(255,255,255,0.6)', marginTop: '0.25rem' }}>
                          <strong>Cycle {m.cycle_number}</strong> — {m.outcome}
                          {m.gaps_identified?.length > 0 && <div style={{ marginTop: 2 }}>Gaps: {m.gaps_identified.join('; ')}</div>}
                          {m.strengths_noted?.length > 0 && <div style={{ marginTop: 2 }}>Strengths: {m.strengths_noted.join('; ')}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div style={{ marginTop: '1.25rem' }}>
              <div className="card-header" style={{ padding: 0, marginBottom: '0.75rem' }}>
                <div>
                  <h3 className="card-title">Job Pipeline</h3>
                  <p className="card-subtitle">Recruiter notes and progress for each role this candidate is in.</p>
                </div>
              </div>

              {loadingCandidate ? (
                <div className="muted">Loading candidate workflow…</div>
              ) : !(selectedCandidate.job_progress || []).length ? (
                <div className="muted">This candidate has not been attached to any job pipeline yet.</div>
              ) : (
                <div style={{ display: 'grid', gap: '1rem' }}>
                  {(selectedCandidate.job_progress || []).map((progress) => (
                    <div key={progress.job_id} className="card" style={{ padding: '1rem', background: 'var(--bg-soft)' }}>
                      <div className="card-header" style={{ padding: 0 }}>
                        <div>
                          <div className="card-title">{progress.job_title || `Job ${progress.job_id}`}</div>
                          <div className="card-subtitle">Session: {formatValue(progress.last_assessment_session_code)}</div>
                        </div>
                        <span className="badge-soft">{progress.stage || 'applied'}</span>
                      </div>

                      <div className="detail-grid" style={{ marginTop: '0.75rem' }}>
                        <div className="field" style={{ marginBottom: 0 }}>
                          <label className="label">Stage</label>
                          <select className="input" value={progress.stage || 'applied'} onChange={(e) => onChangeProgressField(progress.job_id, 'stage', e.target.value)}>
                            {PIPELINE_STAGES.map((stage) => (
                              <option key={stage} value={stage}>{stageLabel(stage)}</option>
                            ))}
                          </select>
                        </div>
                        <div className="field" style={{ marginBottom: 0 }}>
                          <label className="label">Manual rank score</label>
                          <input className="input" type="number" min="0" max="100" value={progress.manual_rank_score ?? ''} onChange={(e) => onChangeProgressField(progress.job_id, 'manual_rank_score', e.target.value)} />
                        </div>
                        <div className="field" style={{ marginBottom: 0 }}>
                          <label className="label">Manual assessment score</label>
                          <input className="input" type="number" min="0" max="100" value={progress.manual_assessment_score ?? ''} onChange={(e) => onChangeProgressField(progress.job_id, 'manual_assessment_score', e.target.value)} />
                        </div>
                        <div className="detail-item">
                          <div className="detail-label">Interview status</div>
                          <div className="detail-value">{formatValue(progress.interview_status)}</div>
                        </div>
                        <div className="field" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
                          <label className="label">Recruiter notes</label>
                          <textarea className="input" rows={3} value={progress.recruiter_notes || ''} onChange={(e) => onChangeProgressField(progress.job_id, 'recruiter_notes', e.target.value)} />
                        </div>
                      </div>

                      <div className="actions-row" style={{ marginTop: '0.75rem' }}>
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => onSaveProgress(progress)} disabled={savingProgressId === String(progress.job_id)}>
                          {savingProgressId === String(progress.job_id) ? 'Saving…' : 'Save'}
                        </button>
                        <span className="muted">Updated {formatValue(progress.updated_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

export default Candidates
