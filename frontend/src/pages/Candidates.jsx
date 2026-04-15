import { useEffect, useMemo, useState } from 'react'
import { candidates } from '../api'

const PIPELINE_STAGES = ['applied', 'shortlisted', 'assessment_sent', 'assessment_in_progress', 'assessment_passed', 'assessment_failed', 'interview_scheduled', 'interview_completed', 'rejected', 'hired']

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

  const filteredRows = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return rows
    return rows.filter((c) =>
      (c.full_name || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.phone_number || '').toLowerCase().includes(q) ||
      (c.skills || []).join(' ').toLowerCase().includes(q) ||
      (c.location || '').toLowerCase().includes(q)
    )
  }, [rows, search])

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
    try {
      const detail = await candidates.get(token, candidate.id)
      setSelectedCandidate(detail)
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
          <div className="modal-card">
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
                <div className="table-avatar" style={{ width: 44, height: 44, minWidth: 44, fontSize: '1.1rem', borderRadius: '50%' }}>
                  {(selectedCandidate.full_name || '?').trim()[0].toUpperCase()}
                </div>
                <div>
                  <div className="modal-title">{formatValue(selectedCandidate.full_name)}</div>
                  <div className="modal-subtitle" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatValue(selectedCandidate.email)}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onViewResume(selectedCandidate.id)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>
                  View PDF
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={onCloseModal}>✕</button>
              </div>
            </div>

            <div className="detail-grid">
              <div className="detail-item">
                <div className="detail-label">Phone</div>
                <div className="detail-value">{formatValue(selectedCandidate.phone_number)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Location</div>
                <div className="detail-value">{formatValue(selectedCandidate.location)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Years of experience</div>
                <div className="detail-value">{formatValue(selectedCandidate.years_experience)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Certifications</div>
                <div className="detail-value">{formatValue(selectedCandidate.certifications)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">College</div>
                <div className="detail-value">{formatValue(selectedCandidate.college_details)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">School</div>
                <div className="detail-value">{formatValue(selectedCandidate.school_details)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Skills</div>
                <div className="detail-value">{formatValue(selectedCandidate.skills)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Projects</div>
                <div className="detail-value">{formatValue(selectedCandidate.projects)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Work experience</div>
                <div className="detail-value">{formatValue(selectedCandidate.work_experience)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Extra-curricular</div>
                <div className="detail-value">{formatValue(selectedCandidate.extra_curricular_activities)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Links</div>
                <div className="detail-value">{formatValue(selectedCandidate.website_links)}</div>
              </div>
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
                              <option key={stage} value={stage}>{stage}</option>
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
