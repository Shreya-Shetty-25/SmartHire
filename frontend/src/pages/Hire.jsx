import { useEffect, useMemo, useRef, useState } from 'react'
import { hire, jobs, realtime } from '../api'

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

function renderBulletList(value) {
  const items = Array.isArray(value) ? value.filter(Boolean).map(String) : []
  if (!items.length) return <span className="muted">—</span>
  return (
    <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: '0.35rem' }}>
      {items.map((item, idx) => (
        <li key={`${idx}-${item}`}>{item}</li>
      ))}
    </ul>
  )
}

function renderScoreWithNotes(score, notes) {
  const s = Number(score)
  const hasScore = Number.isFinite(s)
  return (
    <div style={{ display: 'grid', gap: '0.35rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
        <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{hasScore ? Math.round(s) : '—'}</div>
        <div className="muted">/ 100</div>
      </div>
      <div className="detail-value" style={{ fontSize: '0.9rem' }}>
        {formatValue(notes)}
      </div>
    </div>
  )
}

function candidateKey(candidate) {
  const email = String(candidate?.email || '').trim().toLowerCase()
  if (email) return `email:${email}`
  const id = candidate?.id
  return id ? `id:${id}` : 'unknown'
}

function inviteStatusLabel(status) {
  const s = String(status || '').toLowerCase()
  if (s === 'sent') return 'Sent'
  if (s === 'failed') return 'Failed'
  if (s === 'retrying') return 'Retrying'
  if (s === 'sending') return 'Sending'
  return 'Queued'
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
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef(null)

  const [shortlistLoading, setShortlistLoading] = useState(false)
  const [shortlistUpload, setShortlistUpload] = useState([]) // { candidate, score, source }[]
  const [shortlistDump, setShortlistDump] = useState([]) // { candidate, score, source }[]

  const [selectedCandidateIds, setSelectedCandidateIds] = useState([])
  const [ranking, setRanking] = useState(null)
  const [rankingLoading, setRankingLoading] = useState(false)
  const [analysisCandidate, setAnalysisCandidate] = useState(null)
  const [bulkWorking, setBulkWorking] = useState(false)

  const [sendingTo, setSendingTo] = useState('')
  const [sentEmails, setSentEmails] = useState(() => new Set())
  const [inviteStatusByEmail, setInviteStatusByEmail] = useState({})
  const [inviteEvents, setInviteEvents] = useState([])
  const [inviteLiveState, setInviteLiveState] = useState('connecting')
  const [toast, setToast] = useState('')
  const toastTimeoutRef = useRef(null)

  const showToast = (message) => {
    setToast(message)
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current)
    }
    toastTimeoutRef.current = setTimeout(() => {
      setToast('')
      toastTimeoutRef.current = null
    }, 3500)
  }

  const combinedShortlist = useMemo(() => {
    const byKey = new Map()

    ;(shortlistUpload || []).forEach((row) => {
      const key = candidateKey(row?.candidate)
      if (!row?.candidate) return
      byKey.set(key, {
        key,
        candidate: row.candidate,
        scoreDump: null,
        scoreUpload: null,
        sources: new Set(['upload']),
      })
    })

    ;(shortlistDump || []).forEach((row) => {
      const key = candidateKey(row?.candidate)
      if (!row?.candidate) return
      const existing = byKey.get(key)
      if (existing) {
        existing.candidate = existing.candidate || row.candidate
        const nextScore = typeof row.score === 'number' ? row.score : Number(row.score)
        if (Number.isFinite(nextScore)) {
          const prev = existing.scoreDump
          if (!Number.isFinite(prev) || nextScore > prev) existing.scoreDump = nextScore
        }
        existing.sources.add('dump')
      } else {
        byKey.set(key, {
          key,
          candidate: row.candidate,
          scoreDump: typeof row.score === 'number' ? row.score : Number(row.score),
          scoreUpload: null,
          sources: new Set(['dump']),
        })
      }
    })

    const rows = Array.from(byKey.values()).map((v) => {
      const score = Number.isFinite(Number(v.scoreDump)) ? Number(v.scoreDump) : null
      const sources = Array.from(v.sources || [])
      sources.sort()
      return {
        key: v.key,
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

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!token) return
    const streamUrl = realtime.streamUrl(token, { eventTypes: ['invite_delivery_status'] })
    if (!streamUrl) return

    const stream = new EventSource(streamUrl)
    stream.addEventListener('open', () => setInviteLiveState('live'))
    stream.addEventListener('invite_delivery_status', (event) => {
      let payload = {}
      try {
        payload = JSON.parse(event?.data || '{}')
      } catch {
        payload = {}
      }
      const email = String(payload?.candidate_email || '').trim().toLowerCase()
      if (!email) return

      setInviteStatusByEmail((prev) => ({
        ...(prev || {}),
        [email]: payload,
      }))
      setInviteEvents((prev) => [payload, ...(prev || [])].slice(0, 25))

      if (String(payload?.status || '').toLowerCase() === 'sent') {
        setSentEmails((prev) => {
          const next = new Set(prev || [])
          next.add(email)
          return next
        })
        showToast(`Invite delivered to ${email}.`)
      }
      if (String(payload?.status || '').toLowerCase() === 'failed') {
        showToast(`Invite failed for ${email}. Please retry.`)
      }
    })
    stream.onerror = () => setInviteLiveState('reconnecting')

    return () => {
      stream.close()
      setInviteLiveState('offline')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

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
        const byKey = new Map()
        ;(prev || []).forEach((r) => {
          if (r?.candidate) byKey.set(candidateKey(r.candidate), r)
        })
        results.forEach((r) => {
          if (r?.candidate) byKey.set(candidateKey(r.candidate), r)
        })
        return Array.from(byKey.values())
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
      // Dedupe dump results by email as well.
      const byKey = new Map()
      normalized.forEach((r) => {
        if (!r?.candidate) return
        const key = candidateKey(r.candidate)
        const existing = byKey.get(key)
        if (!existing) {
          byKey.set(key, r)
          return
        }
        const prevScore = Number(existing.score)
        const nextScore = Number(r.score)
        if (!Number.isFinite(prevScore) || (Number.isFinite(nextScore) && nextScore > prevScore)) {
          byKey.set(key, r)
        }
      })
      setShortlistDump(Array.from(byKey.values()))
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

  const onSendTestLink = async (row) => {
    if (!token) {
      setError('Missing token. Please log in again.')
      return
    }

    const email = String(row?.candidate?.email || '').trim()
    if (!email) {
      setError('Selected candidate is missing an email address.')
      return
    }

    const emailKey = email.toLowerCase()
    setSendingTo(email)
    setError('')
    try {
      const result = await hire.sendTestLinkEmail(token, {
        job_id: Number(selectedJobId),
        candidate_email: email,
        candidate_name: row?.candidate?.full_name || null,
        job_title: selectedJob?.title || null,
        test_link: null,
        session_code: null,
      })
      const queuedPayload = {
        candidate_email: emailKey,
        status: 'queued',
        attempt: 0,
        max_attempts: 3,
        session_code: result?.session_code || null,
        updated_at: new Date().toISOString(),
      }
      setInviteStatusByEmail((prev) => ({
        ...(prev || {}),
        [emailKey]: queuedPayload,
      }))
      setInviteEvents((prev) => [queuedPayload, ...(prev || [])].slice(0, 25))
      showToast('Invite queued. Live delivery status will update automatically.')
    } catch (err) {
      setError(err?.message || 'Failed to send test link email')
    } finally {
      setSendingTo('')
    }
  }

  const onBulkAction = async (action) => {
    if (!token || !selectedJobId || !selectedCandidateIds.length) {
      setError('Select a job and at least one candidate first.')
      return
    }

    setBulkWorking(true)
    setError('')
    try {
      if (action === 'export') {
        const { blob, contentDisposition } = await hire.exportPipeline(token, Number(selectedJobId))
        const filenameMatch = /filename="?([^"]+)"?/i.exec(contentDisposition || '')
        const filename = filenameMatch?.[1] || `job-${selectedJobId}-pipeline.csv`
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        document.body.appendChild(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 15000)
        return
      }

      const payload =
        action === 'send_assessment'
          ? { action, candidate_ids: selectedCandidateIds, question_count: 10, duration_minutes: 30, difficulty: 'hard' }
          : { action, candidate_ids: selectedCandidateIds }

      await hire.bulkAction(token, Number(selectedJobId), payload)
      showToast(
        action === 'send_assessment'
          ? 'Assessment invites queued. Delivery status will update live.'
          : `Bulk action '${action}' applied to selected candidates.`
      )
      if (step === 3) {
        await onRank()
      }
    } catch (err) {
      setError(err?.message || 'Bulk action failed')
    } finally {
      setBulkWorking(false)
    }
  }

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header-row">
          <div>
            <p className="eyebrow">Recruitment</p>
            <h1 className="page-title">Hire</h1>
            <p className="page-subtitle">Select a job, bring resumes, and rank candidates with AI.</p>
          </div>
        </div>

        <div className="card" style={{ marginBottom: '1.25rem', padding: '1.25rem 1.5rem' }}>
          <div className="stepper">
            <div className={step === 1 ? 'stepper-item active' : step > 1 ? 'stepper-item completed' : 'stepper-item'} onClick={() => step > 1 && setStep(1)} style={{ cursor: step > 1 ? 'pointer' : 'default' }}>
              <div className="stepper-badge">
                {step > 1 ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> : '1'}
              </div>
              <div>
                <div className="stepper-title">Job Description</div>
                <div className="stepper-sub">Pick or create</div>
              </div>
            </div>
            <div className="stepper-connector" />
            <div className={step === 2 ? 'stepper-item active' : step > 2 ? 'stepper-item completed' : 'stepper-item'} onClick={() => step > 2 && setStep(2)} style={{ cursor: step > 2 ? 'pointer' : 'default' }}>
              <div className="stepper-badge">
                {step > 2 ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> : '2'}
              </div>
              <div>
                <div className="stepper-title">Resumes</div>
                <div className="stepper-sub">Upload or shortlist</div>
              </div>
            </div>
            <div className="stepper-connector" />
            <div className={step === 3 ? 'stepper-item active' : 'stepper-item'}>
              <div className="stepper-badge">3</div>
              <div>
                <div className="stepper-title">Rank</div>
                <div className="stepper-sub">LLM analysis</div>
              </div>
            </div>
          </div>
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

            {error ? <div className="error-banner">{error}</div> : null}

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <button type="button" className="btn btn-primary" onClick={goNext} disabled={!canContinueFromStep1}>
                Next
              </button>
            </div>
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

            <div className="tabs" style={{ marginBottom: '1.25rem' }}>
              <button
                type="button"
                className={sourceMode === 'upload' ? 'tab active' : 'tab'}
                onClick={() => { setSourceMode('upload'); setRanking(null) }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ marginRight: 6 }}>
                  <path d="M12 16V4m0 0 4 4m-4-4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M4 20h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                Upload resumes
              </button>
              <button
                type="button"
                className={sourceMode === 'dump' ? 'tab active' : 'tab'}
                onClick={() => { setSourceMode('dump'); setRanking(null) }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ marginRight: 6 }}>
                  <path d="M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z" stroke="currentColor" strokeWidth="2" />
                  <path d="m21 21-4.3-4.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                Shortlist from database
              </button>
            </div>

            {sourceMode === 'upload' ? (
              <form onSubmit={onBulkUpload}>
                <div
                  className={`drop-zone${dragging ? ' drop-zone-active' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragging(false)
                    const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf')
                    if (files.length) setUploadFiles(files)
                  }}
                  onClick={() => fileInputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click() }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => setUploadFiles(e.target.files ? Array.from(e.target.files) : [])}
                  />
                  <div className="drop-zone-icon">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M12 16V4m0 0 4 4m-4-4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M20 16v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </div>
                  <div className="drop-zone-text">
                    {uploadFiles.length
                      ? <strong>{uploadFiles.length} file{uploadFiles.length > 1 ? 's' : ''} selected</strong>
                      : <><strong>Click to browse</strong> or drag &amp; drop PDF resumes here</>}
                  </div>
                  <div className="drop-zone-hint">Accepts multiple PDF files</div>
                </div>

                {uploadFiles.length > 0 && (
                  <div style={{ marginTop: '0.75rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                    {uploadFiles.map((f, i) => (
                      <span key={i} className="badge-soft" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M14 2v6h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {f.name}
                      </span>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
                  <button type="submit" className="btn btn-primary" disabled={uploading || !uploadFiles.length || shortlistUpload.length > 0}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M12 16V4m0 0 4 4m-4-4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M4 20h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                      {uploading ? 'Uploading…' : shortlistUpload.length > 0 ? 'Already uploaded' : `Upload ${uploadFiles.length || ''} resume${uploadFiles.length !== 1 ? 's' : ''}`}
                    </span>
                  </button>
                </div>
              </form>
            ) : (
              <div style={{ display: 'grid', gap: '1rem' }}>
                <div style={{ padding: '1.5rem', background: 'var(--bg-soft)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', textAlign: 'center' }}>
                  <p style={{ margin: '0 0 1rem', color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
                    Find the best-matching candidates from your existing database using AI-powered embedding similarity.
                  </p>
                  <button type="button" className="btn btn-primary" onClick={onShortlist} disabled={shortlistLoading || !selectedJobId}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z" stroke="currentColor" strokeWidth="2" />
                        <path d="m21 21-4.3-4.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                      {shortlistLoading ? 'Searching…' : 'Find relevant candidates'}
                    </span>
                  </button>
                  {!selectedJobId && <div className="muted" style={{ marginTop: '0.75rem', fontSize: '0.82rem' }}>Select a job in Step 1 first.</div>}
                </div>
              </div>
            )}

            {(shortlistUpload.length || shortlistDump.length) ? (
              <div style={{ marginTop: '1.25rem', display: 'grid', gap: '1rem' }}>
                {shortlistUpload.length ? (
                  <div>
                    <div className="card-header" style={{ padding: 0, marginBottom: '0.5rem' }}>
                      <div>
                        <h3 className="card-title">Bulk upload results</h3>
                        <p className="card-subtitle">Uploaded resumes saved into Candidates.</p>
                      </div>
                    </div>
                    <div className="table-wrap">
                      <table className="table" aria-label="Bulk upload results">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Email</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shortlistUpload.map((row) => (
                            <tr key={candidateKey(row.candidate)}>
                              <td>{formatValue(row.candidate.full_name)}</td>
                              <td className="table-muted">{formatValue(row.candidate.email)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                {shortlistDump.length ? (
                  <div>
                    <div className="card-header" style={{ padding: 0, marginBottom: '0.5rem' }}>
                      <div>
                        <h3 className="card-title">Dump shortlist results</h3>
                        <p className="card-subtitle">Top candidates by cosine similarity for the selected job.</p>
                      </div>
                    </div>
                    <div className="table-wrap">
                      <table className="table" aria-label="Dump shortlist results">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Email</th>
                            <th>Score</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shortlistDump.map((row) => (
                            <tr key={candidateKey(row.candidate)}>
                              <td>{formatValue(row.candidate.full_name)}</td>
                              <td className="table-muted">{formatValue(row.candidate.email)}</td>
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
              </div>
            ) : null}

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
                        <tr key={row.key}>
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

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <button type="button" className="btn btn-ghost" onClick={goBack}>
                Back
              </button>
              <button type="button" className="btn btn-primary" onClick={goNext} disabled={!canContinueFromStep2}>
                Next
              </button>
            </div>
          </article>
        ) : null}

        {step === 3 ? (
          <article className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Rank candidates</h2>
                <p className="card-subtitle">Ranking runs automatically from Step 2. Click a row to see detailed reasoning.</p>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onBulkAction('shortlist')} disabled={bulkWorking || !selectedCandidateIds.length}>Bulk shortlist</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onBulkAction('send_assessment')} disabled={bulkWorking || !selectedCandidateIds.length}>Bulk send assessments</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onBulkAction('reject')} disabled={bulkWorking || !selectedCandidateIds.length}>Bulk reject</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onBulkAction('export')} disabled={bulkWorking || !selectedJobId}>Export CSV</button>
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

            <div className="chip-row" style={{ marginTop: '0.75rem' }}>
              <span className="chip" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: inviteLiveState === 'live' ? '#22c55e' : '#f59e0b', display: 'inline-block' }} />
                Invite stream: {inviteLiveState}
              </span>
              <span className="chip">Tracked: {Object.keys(inviteStatusByEmail || {}).length}</span>
            </div>
            {rankingLoading ? (
              <div style={{ padding: '1.5rem 0', display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                <span className="loading-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
                <span className="muted">Ranking with AI…</span>
              </div>
            ) : null}

            {ranking ? (
              <div style={{ marginTop: '1.25rem' }}>
                <div className="card-header" style={{ padding: 0 }}>
                  <div>
                    <h3 className="card-title">Results</h3>
                  </div>
                </div>

                <div className="table-wrap">
                  <table className="table" aria-label="Ranking results">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Email</th>
                        <th>Score</th>
                        <th>Effective</th>
                        <th>Status</th>
                        <th>Analysis</th>
                        <th>Test</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ranking.results.map((r, idx) => {
                        const score = Math.round(Number(r.score || 0))
                        const rowBg = score >= 70
                          ? 'rgba(34,197,94,0.04)'
                          : score >= 50
                            ? 'rgba(245,158,11,0.04)'
                            : 'rgba(239,68,68,0.04)'
                        const barColor = score >= 70 ? '#22c55e' : score >= 50 ? '#f59e0b' : '#ef4444'
                        return (
                          <tr
                            key={r.candidate.id}
                            style={{ cursor: 'pointer', background: rowBg }}
                            onClick={() => setAnalysisCandidate(r)}
                          >
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                <div style={{ width: 26, height: 26, minWidth: 26, borderRadius: '50%', background: idx === 0 ? 'linear-gradient(135deg,#f59e0b,#d97706)' : idx === 1 ? 'linear-gradient(135deg,#94a3b8,#64748b)' : idx === 2 ? 'linear-gradient(135deg,#cd7f32,#b45309)' : 'var(--bg-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700, color: idx < 3 ? '#fff' : 'var(--text-secondary)' }}>{idx + 1}</div>
                                <div>
                                  <div style={{ fontWeight: 600, lineHeight: 1.3 }}>{formatValue(r.candidate.full_name)}</div>
                                  {Number.isFinite(Number(r.score)) && Number(r.score) > 60 ? <span className="badge-soft" style={{ fontSize: '0.7rem', padding: '1px 6px' }}>★ Recommended</span> : null}
                                </div>
                              </div>
                            </td>
                            <td className="table-muted" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatValue(r.candidate.email)}</td>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <div style={{ flex: 1, height: 6, background: 'var(--bg-soft)', borderRadius: 99, minWidth: 60, overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${score}%`, background: barColor, borderRadius: 99, transition: 'width 0.4s ease' }} />
                                </div>
                                <span style={{ minWidth: 32, fontWeight: 700, fontSize: '0.88rem', color: barColor }}>{score}</span>
                              </div>
                            </td>
                            <td>{r.effective_score != null ? Math.round(Number(r.effective_score || 0)) : '—'}</td>
                            <td><span className={r.passed ? 'badge-green' : 'badge-red'}>{r.passed ? 'Passed' : 'Failed'}</span></td>
                            <td>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={(e) => { e.stopPropagation(); setAnalysisCandidate(r) }}
                              >
                                View
                              </button>
                            </td>
                            <td>
                              {(() => {
                                const email = String(r.candidate.email || '').trim()
                                const emailKey = email.toLowerCase()
                                const live = inviteStatusByEmail?.[emailKey] || null
                                const liveStatus = String(live?.status || '').toLowerCase()
                                const attempt = Number(live?.attempt || 0)
                                const maxAttempts = Number(live?.max_attempts || 0)
                                const alreadySent = emailKey && sentEmails.has(emailKey)
                                if (liveStatus === 'sent' || alreadySent) {
                                  return <span className="badge-soft badge-green">Sent{attempt > 0 ? ` (attempt ${attempt})` : ''}</span>
                                }
                                if (liveStatus === 'failed') {
                                  return (
                                    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                      <span className="badge-soft badge-red">Failed{attempt > 0 ? ` (${attempt}/${maxAttempts || 1})` : ''}</span>
                                      <button type="button" className="btn btn-primary btn-sm" disabled={sendingTo === email} onClick={(e) => { e.stopPropagation(); onSendTestLink(r) }}>Retry</button>
                                    </div>
                                  )
                                }
                                if (liveStatus === 'queued' || liveStatus === 'sending' || liveStatus === 'retrying') {
                                  return <span className="badge-soft">{inviteStatusLabel(liveStatus)}{attempt > 0 ? ` (${attempt}/${maxAttempts || 1})` : ''}</span>
                                }
                                return (
                                  <button type="button" className="btn btn-primary btn-sm" disabled={sendingTo === email} onClick={(e) => { e.stopPropagation(); onSendTestLink(r) }}>
                                    {sendingTo === email ? 'Sending…' : 'Send'}
                                  </button>
                                )
                              })()}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="card" style={{ marginTop: '1rem', padding: '0.9rem' }}>
                  <div className="card-header" style={{ padding: 0 }}>
                    <div>
                      <h3 className="card-title">Live Invite Delivery</h3>
                      <p className="card-subtitle">Queued, retries, sent, and failed updates stream here in real time.</p>
                    </div>
                  </div>
                  {inviteEvents.length ? (
                    <ul className="timeline" style={{ marginTop: '0.7rem' }}>
                      {inviteEvents.slice(0, 10).map((item, idx) => (
                        <li className="timeline-item" key={`${String(item?.candidate_email || 'invite')}-${String(item?.updated_at || idx)}-${idx}`}>
                          <div
                            className="dot"
                            style={{
                              background:
                                String(item?.status || '').toLowerCase() === 'sent'
                                  ? '#22c55e'
                                  : String(item?.status || '').toLowerCase() === 'failed'
                                    ? '#ef4444'
                                    : '#2563eb',
                            }}
                          />
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                              <span>{String(item?.candidate_email || 'candidate')}</span>
                              <span className="badge-soft">
                                {inviteStatusLabel(item?.status)} {item?.attempt ? `(${item.attempt}/${item.max_attempts || 1})` : ''}
                              </span>
                            </div>
                            <div className="muted">
                              {item?.session_code ? `Session ${item.session_code}` : 'Session pending'}{item?.error ? ` · ${item.error}` : ''}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted" style={{ marginTop: '0.7rem' }}>No invite activity yet.</p>
                  )}
                </div>
              </div>
            ) : null}

            {error ? <div className="error-banner">{error}</div> : null}

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <button type="button" className="btn btn-ghost" onClick={goBack}>
                Back
              </button>
            </div>
          </article>
        ) : null}
      </section>

      {toast ? <div className="toast">{toast}</div> : null}

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
                  {formatValue(analysisCandidate.candidate.email)}
                  {' · '}
                  Score {Math.round(Number(analysisCandidate.score || 0))}
                  {' · '}
                  {analysisCandidate.passed ? 'Passed' : 'Failed'}
                </div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAnalysisCandidate(null)}>
                Close
              </button>
            </div>

            <div className="detail-grid" style={{ marginTop: '1rem' }}>
              <div className="detail-item">
                <div className="detail-label">Job</div>
                <div className="detail-value">{formatValue(selectedJob?.title)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Resume</div>
                <div className="detail-value">{formatValue(analysisCandidate.candidate.resume_filename)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Location</div>
                <div className="detail-value">{formatValue(analysisCandidate.candidate.location)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Years of experience</div>
                <div className="detail-value">{formatValue(analysisCandidate.candidate.years_experience)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Candidate skills</div>
                <div className="detail-value">{formatValue(analysisCandidate.candidate.skills)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Certifications</div>
                <div className="detail-value">{formatValue(analysisCandidate.candidate.certifications)}</div>
              </div>
            </div>

            <div style={{ marginTop: '1.25rem' }}>
              <div className="card-header" style={{ padding: 0, marginBottom: '0.75rem' }}>
                <div>
                  <h3 className="card-title">LLM analysis</h3>
                  <p className="card-subtitle">Breakdown + strengths/concerns for this job.</p>
                </div>
              </div>

              <div className="detail-grid">
                <div className="detail-item" style={{ gridColumn: '1 / -1' }}>
                  <div className="detail-label">Summary</div>
                  <div className="detail-value">{formatValue(analysisCandidate.analysis?.summary)}</div>
                </div>

                {analysisCandidate.analysis?.breakdown ? (
                  <>
                    <div className="detail-item">
                      <div className="detail-label">Skills</div>
                      {renderScoreWithNotes(
                        analysisCandidate.analysis?.breakdown?.skills_score,
                        analysisCandidate.analysis?.breakdown?.skills_notes
                      )}
                    </div>
                    <div className="detail-item">
                      <div className="detail-label">Experience</div>
                      {renderScoreWithNotes(
                        analysisCandidate.analysis?.breakdown?.experience_score,
                        analysisCandidate.analysis?.breakdown?.experience_notes
                      )}
                    </div>
                    <div className="detail-item">
                      <div className="detail-label">Education</div>
                      {renderScoreWithNotes(
                        analysisCandidate.analysis?.breakdown?.education_score,
                        analysisCandidate.analysis?.breakdown?.education_notes
                      )}
                    </div>
                    <div className="detail-item">
                      <div className="detail-label">Location</div>
                      {renderScoreWithNotes(
                        analysisCandidate.analysis?.breakdown?.location_score,
                        analysisCandidate.analysis?.breakdown?.location_notes
                      )}
                    </div>
                  </>
                ) : (
                  <div className="detail-item" style={{ gridColumn: '1 / -1' }}>
                    <div className="detail-label">Breakdown</div>
                    <div className="detail-value">—</div>
                  </div>
                )}

                <div className="detail-item">
                  <div className="detail-label">Strengths</div>
                  <div className="detail-value">{renderBulletList(analysisCandidate.analysis?.strengths)}</div>
                </div>
                <div className="detail-item">
                  <div className="detail-label">Concerns</div>
                  <div className="detail-value">{renderBulletList(analysisCandidate.analysis?.concerns)}</div>
                </div>

                {!analysisCandidate.analysis?.summary && !analysisCandidate.analysis?.breakdown ? (
                  <div className="detail-item" style={{ gridColumn: '1 / -1' }}>
                    <div className="detail-label">Raw analysis</div>
                    <div className="detail-value">{formatValue(analysisCandidate.analysis)}</div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

export default Hire
