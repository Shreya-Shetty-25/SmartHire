import { useEffect, useMemo, useState } from 'react'
import { hire, jobs } from '../api'

function parseCsvList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) {
    return value.length ? value.join(', ') : '—'
  }
  return String(value)
}

function Hire() {
  const token = useMemo(() => localStorage.getItem('token'), [])

  const [step, setStep] = useState(1)
  const [error, setError] = useState('')

  const [jobsLoading, setJobsLoading] = useState(true)
  const [jobRows, setJobRows] = useState([])
  const [selectedJobId, setSelectedJobId] = useState('')

  const [newJob, setNewJob] = useState({
    title: '',
    description: '',
    education: '',
    years_experience: '',
    skills_required: '',
    additional_skills: '',
    location: '',
    employment_type: '',
  })
  const [creatingJob, setCreatingJob] = useState(false)

  const [sourceMode, setSourceMode] = useState('upload') // upload | dump

  const [uploadFiles, setUploadFiles] = useState([])
  const [uploading, setUploading] = useState(false)

  const [shortlistLoading, setShortlistLoading] = useState(false)
  const [shortlistUpload, setShortlistUpload] = useState([]) // { candidate, score, source }[]
  const [shortlistDump, setShortlistDump] = useState([]) // { candidate, score, source }[]

  const [selectedCandidateIds, setSelectedCandidateIds] = useState([])
  const [ranking, setRanking] = useState(null)
  const [rankingLoading, setRankingLoading] = useState(false)
  const [analysisCandidate, setAnalysisCandidate] = useState(null)

  const combinedShortlist = useMemo(() => {
    const byId = new Map()

    ;(shortlistUpload || []).forEach((row) => {
      const id = row?.candidate?.id
      if (!id) return
      byId.set(id, {
        candidate: row.candidate,
        scoreDump: null,
        scoreUpload: null,
        sources: new Set(['upload']),
      })
    })

    ;(shortlistDump || []).forEach((row) => {
      const id = row?.candidate?.id
      if (!id) return
      const existing = byId.get(id)
      if (existing) {
        existing.candidate = existing.candidate || row.candidate
        existing.scoreDump = typeof row.score === 'number' ? row.score : Number(row.score)
        existing.sources.add('dump')
      } else {
        byId.set(id, {
          candidate: row.candidate,
          scoreDump: typeof row.score === 'number' ? row.score : Number(row.score),
          scoreUpload: null,
          sources: new Set(['dump']),
        })
      }
    })

    const rows = Array.from(byId.values()).map((v) => {
      const score = Number.isFinite(Number(v.scoreDump)) ? Number(v.scoreDump) : null
      const sources = Array.from(v.sources || [])
      sources.sort()
      return {
        candidate: v.candidate,
        score,
        sources,
      }
    })

    rows.sort((a, b) => {
      const as = a.score
      const bs = b.score
      const ah = typeof as === 'number' && Number.isFinite(as)
      const bh = typeof bs === 'number' && Number.isFinite(bs)
      if (ah && bh) return bs - as
      if (bh) return 1
      if (ah) return -1
      return String(a?.candidate?.full_name || '').localeCompare(String(b?.candidate?.full_name || ''))
    })

    return rows
  }, [shortlistUpload, shortlistDump])

  useEffect(() => {
    const allowed = new Set((combinedShortlist || []).map((r) => r.candidate.id))
    setSelectedCandidateIds((prev) => (prev || []).filter((id) => allowed.has(id)))
  }, [combinedShortlist])

  const selectedJob = jobRows.find((j) => String(j.id) === String(selectedJobId)) || null

  const loadJobs = async () => {
    if (!token) return
    setJobsLoading(true)
    setError('')
    try {
      const data = await jobs.list(token)
      setJobRows(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err?.message || 'Failed to load jobs')
    } finally {
      setJobsLoading(false)
    }
  }

  useEffect(() => {
    loadJobs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onCreateJob = async (e) => {
    e.preventDefault()
    if (!token) {
      setError('Missing token. Please log in again.')
      return
    }

    if (!newJob.title.trim() || !newJob.description.trim()) {
      setError('Please enter job title and description.')
      return
    }

    setCreatingJob(true)
    setError('')
    try {
      const payload = {
        title: newJob.title.trim(),
        description: newJob.description.trim(),
        education: newJob.education.trim() || null,
        years_experience:
          newJob.years_experience === '' || newJob.years_experience === null
            ? null
            : Number(newJob.years_experience),
        skills_required: parseCsvList(newJob.skills_required),
        additional_skills: parseCsvList(newJob.additional_skills),
        location: newJob.location.trim() || null,
        employment_type: newJob.employment_type.trim() || null,
      }
      const created = await jobs.create(token, payload)
      setJobRows((prev) => [created, ...(prev || [])])
      setSelectedJobId(String(created.id))
      setNewJob({
        title: '',
        description: '',
        education: '',
        years_experience: '',
        skills_required: '',
        additional_skills: '',
        location: '',
        employment_type: '',
      })
    } catch (err) {
      setError(err?.message || 'Failed to create job')
    } finally {
      setCreatingJob(false)
    }
  }

  const canContinueFromStep1 = Boolean(selectedJobId)
  const canContinueFromStep2 = selectedCandidateIds.length > 0

  const goNext = async () => {
    setError('')

    if (step === 1) {
      setStep(2)
      return
    }

    if (step === 2) {
      if (!selectedJobId) {
        setError('Select a job first.')
        return
      }
      if (!selectedCandidateIds.length) {
        setError('Select at least one candidate to rank.')
        return
      }

      setStep(3)
      // Auto-rank on entering Step 3.
      await onRank()
      return
    }

    setStep(3)
  }

  const goBack = () => {
    setError('')
    setStep((s) => Math.max(1, s - 1))
  }

  const onBulkUpload = async (e) => {
    e.preventDefault()
    if (!token) {
      setError('Missing token. Please log in again.')
      return
    }
    if (!uploadFiles || uploadFiles.length === 0) {
      setError('Please choose one or more PDF files.')
      return
    }

    setUploading(true)
    setError('')
    try {
      const createdOrUpdated = await hire.bulkUploadResumes(token, uploadFiles)
      const results = (createdOrUpdated || []).map((c) => ({ candidate: c, score: null, source: 'upload' }))
      setShortlistUpload((prev) => {
        const byId = new Map()
        ;(prev || []).forEach((r) => {
          if (r?.candidate?.id) byId.set(r.candidate.id, r)
        })
        results.forEach((r) => {
          if (r?.candidate?.id) byId.set(r.candidate.id, r)
        })
        return Array.from(byId.values())
      })
      setSelectedCandidateIds((prev) => {
        const set = new Set(prev || [])
        results.forEach((r) => set.add(r.candidate.id))
        return Array.from(set)
      })
      setRanking(null)
    } catch (err) {
      setError(err?.message || 'Bulk upload failed')
    } finally {
      setUploading(false)
    }
  }

  const onShortlist = async () => {
    if (!token) {
      setError('Missing token. Please log in again.')
      return
    }
    if (!selectedJobId) {
      setError('Select a job first.')
      return
    }

    setShortlistLoading(true)
    setError('')
    try {
      const data = await hire.shortlistFromDump(token, Number(selectedJobId), 5)
      const results = Array.isArray(data?.results) ? data.results : []
      const normalized = results.map((r) => ({ ...r, source: 'dump' }))
      setShortlistDump(normalized)
      setSelectedCandidateIds((prev) => {
        const set = new Set(prev || [])
        normalized.forEach((r) => set.add(r.candidate.id))
        return Array.from(set)
      })
      setRanking(null)
    } catch (err) {
      setError(err?.message || 'Shortlist failed')
    } finally {
      setShortlistLoading(false)
    }
  }

  const toggleCandidate = (candidateId) => {
    setSelectedCandidateIds((prev) => {
      const set = new Set(prev || [])
      if (set.has(candidateId)) set.delete(candidateId)
      else set.add(candidateId)
      return Array.from(set)
    })
  }

  const onRank = async () => {
    if (!token) {
      setError('Missing token. Please log in again.')
      return
    }
    if (!selectedJobId) {
      setError('Select a job first.')
      return
    }
    if (!selectedCandidateIds.length) {
      setError('Select at least one candidate to rank.')
      return
    }

    setRankingLoading(true)
    setError('')
    try {
      const source = shortlistUpload.length && shortlistDump.length ? 'mixed' : shortlistUpload.length ? 'upload' : 'dump'
      const data = await hire.rank(token, {
        job_id: Number(selectedJobId),
        candidate_ids: selectedCandidateIds,
        threshold_score: 70,
        source,
      })
      setRanking(data)
    } catch (err) {
      setError(err?.message || 'Ranking failed')
    } finally {
      setRankingLoading(false)
    }
  }

  const passedCount = Array.isArray(ranking?.results) ? ranking.results.filter((r) => r.passed).length : 0

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header">
          <h1 className="page-title">Hire</h1>
          <p className="page-subtitle">Select a job, bring resumes, and rank candidates.</p>
        </div>

        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <div className="stepper">
            <div className={step === 1 ? 'stepper-item active' : 'stepper-item'}>
              <div className="stepper-badge">1</div>
              <div>
                <div className="stepper-title">Job description</div>
                <div className="stepper-sub">Pick or create</div>
              </div>
            </div>
            <div className={step === 2 ? 'stepper-item active' : 'stepper-item'}>
              <div className="stepper-badge">2</div>
              <div>
                <div className="stepper-title">Resumes</div>
                <div className="stepper-sub">Upload or shortlist</div>
              </div>
            </div>
            <div className={step === 3 ? 'stepper-item active' : 'stepper-item'}>
              <div className="stepper-badge">3</div>
              <div>
                <div className="stepper-title">Rank</div>
                <div className="stepper-sub">LLM analysis</div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={goBack} disabled={step === 1}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={goNext}
              disabled={(step === 1 && !canContinueFromStep1) || (step === 2 && !canContinueFromStep2) || step === 3}
            >
              Next
            </button>
          </div>

          {error ? <div className="error-banner">{error}</div> : null}
        </div>

        {step === 1 ? (
          <>
            <article className="card" style={{ marginBottom: '1.25rem' }}>
              <div className="card-header">
                <div>
                  <h2 className="card-title">Select job description</h2>
                  <p className="card-subtitle">Choose an existing job from your database.</p>
                </div>
                <button type="button" className="btn btn-ghost" onClick={loadJobs} disabled={jobsLoading}>
                  Refresh
                </button>
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <label className="label" htmlFor="jobSelect">
                  Job
                </label>
                <select
                  id="jobSelect"
                  className="input"
                  value={selectedJobId}
                  onChange={(e) => setSelectedJobId(e.target.value)}
                >
                  <option value="">{jobsLoading ? 'Loading…' : 'Select a job…'}</option>
                  {jobRows.map((j) => (
                    <option key={j.id} value={String(j.id)}>
                      {j.title}
                    </option>
                  ))}
                </select>
              </div>

              {selectedJob ? (
                <div style={{ marginTop: '1rem' }}>
                  <div className="detail-item">
                    <div className="detail-label">Description</div>
                    <div className="detail-value">{formatValue(selectedJob.description)}</div>
                  </div>
                </div>
              ) : null}
            </article>

            <article className="card">
              <div className="card-header" style={{ marginBottom: 0 }}>
                <div>
                  <h2 className="card-title">Or create a new job</h2>
                  <p className="card-subtitle">Store it in the database for future hires.</p>
                </div>
              </div>

              <form onSubmit={onCreateJob}>
                <div className="detail-grid" style={{ marginTop: '1rem' }}>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="label" htmlFor="jobTitle">
                      Title / Position
                    </label>
                    <input
                      id="jobTitle"
                      className="input"
                      value={newJob.title}
                      onChange={(e) => setNewJob((p) => ({ ...p, title: e.target.value }))}
                      placeholder="e.g., Backend Engineer"
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="label" htmlFor="jobLocation">
                      Location
                    </label>
                    <input
                      id="jobLocation"
                      className="input"
                      value={newJob.location}
                      onChange={(e) => setNewJob((p) => ({ ...p, location: e.target.value }))}
                      placeholder="e.g., Bengaluru"
                    />
                  </div>

                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="label" htmlFor="jobEmployment">
                      Employment type
                    </label>
                    <input
                      id="jobEmployment"
                      className="input"
                      value={newJob.employment_type}
                      onChange={(e) => setNewJob((p) => ({ ...p, employment_type: e.target.value }))}
                      placeholder="e.g., Full-time"
                    />
                  </div>

                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="label" htmlFor="jobYears">
                      Years of experience
                    </label>
                    <input
                      id="jobYears"
                      className="input"
                      type="number"
                      min="0"
                      value={newJob.years_experience}
                      onChange={(e) => setNewJob((p) => ({ ...p, years_experience: e.target.value }))}
                      placeholder="e.g., 3"
                    />
                  </div>

                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="label" htmlFor="jobEducation">
                      Education
                    </label>
                    <input
                      id="jobEducation"
                      className="input"
                      value={newJob.education}
                      onChange={(e) => setNewJob((p) => ({ ...p, education: e.target.value }))}
                      placeholder="e.g., B.Tech / B.E."
                    />
                  </div>

                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="label" htmlFor="jobSkills">
                      Skills required (comma separated)
                    </label>
                    <input
                      id="jobSkills"
                      className="input"
                      value={newJob.skills_required}
                      onChange={(e) => setNewJob((p) => ({ ...p, skills_required: e.target.value }))}
                      placeholder="e.g., Python, FastAPI, PostgreSQL"
                    />
                  </div>

                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="label" htmlFor="jobAddSkills">
                      Additional skills (comma separated)
                    </label>
                    <input
                      id="jobAddSkills"
                      className="input"
                      value={newJob.additional_skills}
                      onChange={(e) => setNewJob((p) => ({ ...p, additional_skills: e.target.value }))}
                      placeholder="e.g., Docker, AWS"
                    />
                  </div>
                </div>

                <div className="field" style={{ marginTop: '1rem' }}>
                  <label className="label" htmlFor="jobDesc">
                    Description
                  </label>
                  <textarea
                    id="jobDesc"
                    className="input"
                    style={{ minHeight: 140, resize: 'vertical' }}
                    value={newJob.description}
                    onChange={(e) => setNewJob((p) => ({ ...p, description: e.target.value }))}
                    placeholder="Paste the job description here…"
                  />
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="btn btn-primary" disabled={creatingJob}>
                    {creatingJob ? 'Creating…' : 'Create job'}
                  </button>
                </div>
              </form>
            </article>
          </>
        ) : null}

        {step === 2 ? (
          <article className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Bring resumes</h2>
                <p className="card-subtitle">Upload new resumes (saved into Candidates) or shortlist from your existing dump.</p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className={sourceMode === 'upload' ? 'btn btn-primary' : 'btn btn-ghost'}
                onClick={() => {
                  setSourceMode('upload')
                  setRanking(null)
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 16V4m0 0 4 4m-4-4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M4 20h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  Bulk upload
                </span>
              </button>
              <button
                type="button"
                className={sourceMode === 'dump' ? 'btn btn-primary' : 'btn btn-ghost'}
                onClick={() => {
                  setSourceMode('dump')
                  setRanking(null)
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <path d="M20 18v-4m0 4-2-2m2 2 2-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Shortlist from dump
                </span>
              </button>
            </div>

            {sourceMode === 'upload' ? (
              <form className="form-row" onSubmit={onBulkUpload}>
                <div className="field" style={{ marginBottom: 0, flex: 1 }}>
                  <label className="label" htmlFor="resumes">
                    Resume PDFs
                  </label>
                  <input
                    id="resumes"
                    className="input"
                    type="file"
                    accept="application/pdf"
                    multiple
                    onChange={(e) => setUploadFiles(e.target.files ? Array.from(e.target.files) : [])}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <button type="submit" className="btn btn-primary" disabled={uploading}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M12 16V4m0 0 4 4m-4-4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M4 20h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                      {uploading ? 'Uploading…' : 'Upload'}
                    </span>
                  </button>
                </div>
              </form>
            ) : (
              <div style={{ marginTop: '1rem' }}>
                <button type="button" className="btn btn-primary" onClick={onShortlist} disabled={shortlistLoading || !selectedJobId}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z" stroke="currentColor" strokeWidth="2" />
                      <path d="m21 21-4.3-4.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    {shortlistLoading ? 'Finding…' : 'Find relevant candidates'}
                  </span>
                </button>
                <div className="muted" style={{ marginTop: '0.5rem' }}>
                  Uses non-LLM retrieval (BM25) over your existing candidate dump.
                </div>
              </div>
            )}

            {combinedShortlist.length ? (
              <div style={{ marginTop: '1.25rem' }}>
                <div className="card-header" style={{ padding: 0, marginBottom: '0.75rem' }}>
                  <div>
                    <h3 className="card-title">Selected candidates</h3>
                    <p className="card-subtitle">Combined results from bulk uploads + dump shortlist (duplicates removed).</p>
                  </div>
                </div>

                <div className="table-wrap">
                  <table className="table" aria-label="Shortlisted candidates">
                    <thead>
                      <tr>
                        <th style={{ width: 60 }}>Pick</th>
                        <th>Name</th>
                        <th>Email</th>
                        <th>Source</th>
                        <th>Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {combinedShortlist.map((row) => (
                        <tr key={row.candidate.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selectedCandidateIds.includes(row.candidate.id)}
                              onChange={() => toggleCandidate(row.candidate.id)}
                            />
                          </td>
                          <td>{formatValue(row.candidate.full_name)}</td>
                          <td className="table-muted">{formatValue(row.candidate.email)}</td>
                          <td className="table-muted">{formatValue(row.sources)}</td>
                          <td>
                            {(() => {
                              const s = Number(row.score || 0)
                              if (!Number.isFinite(s) || s <= 0) return '—'
                              return Math.round(s <= 1.1 ? s * 100 : s)
                            })()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {error ? <div className="error-banner">{error}</div> : null}
          </article>
        ) : null}

        {step === 3 ? (
          <article className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Rank candidates</h2>
                <p className="card-subtitle">Ranking runs automatically from Step 2. Click a row to see detailed reasoning.</p>
              </div>
            </div>

            <div className="detail-grid" style={{ marginTop: '1rem' }}>
              <div className="detail-item">
                <div className="detail-label">Job</div>
                <div className="detail-value">{selectedJob ? selectedJob.title : '—'}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Candidates selected</div>
                <div className="detail-value">{selectedCandidateIds.length}</div>
              </div>
            </div>

            {rankingLoading ? <div className="muted" style={{ marginTop: '1rem' }}>Ranking…</div> : null}

            {ranking ? (
              <div style={{ marginTop: '1.25rem' }}>
                <div className="card-header" style={{ padding: 0 }}>
                  <div>
                    <h3 className="card-title">Results</h3>
                    <p className="card-subtitle">
                      Run #{ranking.run_id} · {passedCount} passed threshold ({ranking.threshold_score})
                    </p>
                  </div>
                </div>

                <div className="table-wrap">
                  <table className="table" aria-label="Ranking results">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Email</th>
                        <th>Score</th>
                        <th>Status</th>
                        <th>Analysis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ranking.results.map((r) => (
                        <tr
                          key={r.candidate.id}
                          style={{ cursor: 'pointer' }}
                          onClick={() => setAnalysisCandidate(r)}
                        >
                          <td>{formatValue(r.candidate.full_name)}</td>
                          <td className="table-muted">{formatValue(r.candidate.email)}</td>
                          <td>{Math.round(Number(r.score || 0))}</td>
                          <td>{r.passed ? 'Pass' : 'No pass'}</td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={(e) => {
                                e.stopPropagation()
                                setAnalysisCandidate(r)
                              }}
                            >
                              View
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {error ? <div className="error-banner">{error}</div> : null}
          </article>
        ) : null}
      </section>

      {analysisCandidate ? (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Candidate analysis"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setAnalysisCandidate(null)
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setAnalysisCandidate(null)
          }}
        >
          <div className="modal-card">
            <div className="modal-header">
              <div>
                <div className="modal-title">{formatValue(analysisCandidate.candidate.full_name)}</div>
                <div className="modal-subtitle">
                  Score {Math.round(Number(analysisCandidate.score || 0))} · {analysisCandidate.passed ? 'Pass' : 'No pass'}
                </div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAnalysisCandidate(null)}>
                Close
              </button>
            </div>

            <div className="detail-grid" style={{ marginTop: '1rem' }}>
              <div className="detail-item">
                <div className="detail-label">Summary</div>
                <div className="detail-value">{formatValue(analysisCandidate.analysis?.summary)}</div>
              </div>
              {analysisCandidate.analysis?.breakdown ? (
                <>
                  <div className="detail-item">
                    <div className="detail-label">Skills</div>
                    <div className="detail-value">
                      {formatValue(analysisCandidate.analysis?.breakdown?.skills_score)} ·{' '}
                      {formatValue(analysisCandidate.analysis?.breakdown?.skills_notes)}
                    </div>
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Experience</div>
                    <div className="detail-value">
                      {formatValue(analysisCandidate.analysis?.breakdown?.experience_score)} ·{' '}
                      {formatValue(analysisCandidate.analysis?.breakdown?.experience_notes)}
                    </div>
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Education</div>
                    <div className="detail-value">
                      {formatValue(analysisCandidate.analysis?.breakdown?.education_score)} ·{' '}
                      {formatValue(analysisCandidate.analysis?.breakdown?.education_notes)}
                    </div>
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Location</div>
                    <div className="detail-value">
                      {formatValue(analysisCandidate.analysis?.breakdown?.location_score)} ·{' '}
                      {formatValue(analysisCandidate.analysis?.breakdown?.location_notes)}
                    </div>
                  </div>
                </>
              ) : null}
              <div className="detail-item">
                <div className="detail-label">Strengths</div>
                <div className="detail-value">{formatValue(analysisCandidate.analysis?.strengths)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Concerns</div>
                <div className="detail-value">{formatValue(analysisCandidate.analysis?.concerns)}</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

export default Hire
