import { useEffect, useMemo, useRef, useState } from 'react'
import { jobs, chat } from '../api'

function Jobs() {
  const token = useMemo(() => localStorage.getItem('token'), [])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [creating, setCreating] = useState(false)

  // Filters
  const [filterLocation, setFilterLocation] = useState('')
  const [filterExperience, setFilterExperience] = useState('')
  const [filterSkill, setFilterSkill] = useState('')

  // Edit state
  const [editingJobId, setEditingJobId] = useState(null)
  const [saving, setSaving] = useState(false)

  // AI suggestions
  const [aiLoading, setAiLoading] = useState(false)
  const [aiSuggestions, setAiSuggestions] = useState(null)

  const emptyForm = {
    title: '',
    description: '',
    location: '',
    employment_type: 'Full-time',
    education: '',
    years_experience: '',
    skills_required: [],
    additional_skills: [],
  }

  const [form, setForm] = useState({ ...emptyForm })
  const [skillInput, setSkillInput] = useState('')
  const [addSkillInput, setAddSkillInput] = useState('')
  const editDialogRef = useRef(null)

  const loadJobs = async () => {
    if (!token) { setError('Missing token. Please log in again.'); setLoading(false); return }
    setError('')
    setLoading(true)
    try {
      const data = await jobs.list(token)
      setRows(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err?.message || 'Failed to load jobs')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadJobs() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-dismiss messages
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(''), 5000)
    return () => clearTimeout(t)
  }, [message])

  // Derived filter options
  const allLocations = useMemo(() => {
    const locs = new Set()
    rows.forEach((j) => { if (j.location) locs.add(j.location) })
    return [...locs].sort()
  }, [rows])

  const allSkills = useMemo(() => {
    const s = new Set()
    rows.forEach((j) => { (j.skills_required || []).forEach((sk) => s.add(sk)) })
    return [...s].sort()
  }, [rows])

  const filteredRows = useMemo(() => {
    let result = rows
    const q = search.toLowerCase().trim()
    if (q) {
      result = result.filter((j) =>
        (j.title || '').toLowerCase().includes(q) ||
        (j.description || '').toLowerCase().includes(q)
      )
    }
    if (filterLocation) {
      result = result.filter((j) => (j.location || '').toLowerCase() === filterLocation.toLowerCase())
    }
    if (filterExperience) {
      const exp = Number(filterExperience)
      result = result.filter((j) => {
        const jExp = j.years_experience ?? 0
        if (exp === 0) return jExp === 0
        if (exp === 1) return jExp >= 1 && jExp <= 2
        if (exp === 3) return jExp >= 3 && jExp <= 5
        if (exp === 5) return jExp > 5
        return true
      })
    }
    if (filterSkill) {
      result = result.filter((j) =>
        (j.skills_required || []).some((s) => s.toLowerCase() === filterSkill.toLowerCase())
      )
    }
    return result
  }, [rows, search, filterLocation, filterExperience, filterSkill])

  const buildPayload = () => ({
    title: form.title.trim(),
    description: form.description.trim(),
    location: form.location.trim() || null,
    employment_type: form.employment_type.trim() || null,
    education: form.education.trim() || null,
    years_experience: form.years_experience ? Number(form.years_experience) : null,
    skills_required: form.skills_required,
    additional_skills: form.additional_skills,
  })

  const onCreateJob = async (e) => {
    e.preventDefault()
    if (!form.title.trim() || !form.description.trim()) {
      setError('Title and description are required.')
      return
    }
    setCreating(true)
    setError('')
    try {
      const created = await jobs.create(token, buildPayload())
      setRows((prev) => [created, ...prev])
      setForm({ ...emptyForm })
      setSkillInput('')
      setAddSkillInput('')
      setShowForm(false)
      setAiSuggestions(null)
      setMessage('Job created successfully.')
    } catch (err) {
      setError(err?.message || 'Failed to create job')
    } finally {
      setCreating(false)
    }
  }

  const openEditJob = (job) => {
    setEditingJobId(job.id)
    setForm({
      title: job.title || '',
      description: job.description || '',
      location: job.location || '',
      employment_type: job.employment_type || 'Full-time',
      education: job.education || '',
      years_experience: job.years_experience != null ? String(job.years_experience) : '',
      skills_required: job.skills_required || [],
      additional_skills: job.additional_skills || [],
    })
    setSkillInput('')
    setAddSkillInput('')
    setShowForm(false)
    setAiSuggestions(null)
  }

  const onSaveEdit = async (e) => {
    e.preventDefault()
    if (!form.title.trim() || !form.description.trim()) {
      setError('Title and description are required.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const updated = await jobs.update(token, editingJobId, buildPayload())
      setRows((prev) => prev.map((j) => (j.id === editingJobId ? updated : j)))
      setEditingJobId(null)
      setForm({ ...emptyForm })
      setSkillInput('')
      setAddSkillInput('')
      setAiSuggestions(null)
      setMessage('Job updated successfully.')
    } catch (err) {
      setError(err?.message || 'Failed to update job')
    } finally {
      setSaving(false)
    }
  }

  const cancelEdit = () => {
    setEditingJobId(null)
    setForm({ ...emptyForm })
    setSkillInput('')
    setAddSkillInput('')
    setAiSuggestions(null)
  }

  const fetchAiSuggestions = async () => {
    setAiLoading(true)
    setAiSuggestions(null)
    try {
      const res = await chat.jobSuggestions({
        title: form.title.trim(),
        description: form.description.trim(),
        skills_required: form.skills_required,
        additional_skills: form.additional_skills,
        location: form.location.trim() || null,
        employment_type: form.employment_type.trim() || null,
        years_experience: form.years_experience ? Number(form.years_experience) : null,
        education: form.education.trim() || null,
      })
      setAiSuggestions(res)
    } catch (err) {
      setError(err?.message || 'Failed to get AI suggestions. Make sure an AI provider is configured.')
    } finally {
      setAiLoading(false)
    }
  }

  const applySkillSuggestion = (skill) => {
    setForm((prev) => {
      if (prev.skills_required.some((s) => s.toLowerCase() === skill.toLowerCase())) return prev
      return { ...prev, skills_required: [...prev.skills_required, skill] }
    })
  }

  const applyAdditionalSkillSuggestion = (skill) => {
    setForm((prev) => {
      if (prev.additional_skills.some((s) => s.toLowerCase() === skill.toLowerCase())) return prev
      return { ...prev, additional_skills: [...prev.additional_skills, skill] }
    })
  }

  // Add skills by typing and pressing Enter/comma
  const addSkill = (value) => {
    const sk = value.trim().replace(/,$/, '')
    if (!sk) return
    setForm((prev) => {
      if (prev.skills_required.some((s) => s.toLowerCase() === sk.toLowerCase())) return prev
      return { ...prev, skills_required: [...prev.skills_required, sk] }
    })
    setSkillInput('')
  }
  const removeSkill = (skill) => setForm((prev) => ({ ...prev, skills_required: prev.skills_required.filter((s) => s !== skill) }))

  const addAddSkill = (value) => {
    const sk = value.trim().replace(/,$/, '')
    if (!sk) return
    setForm((prev) => {
      if (prev.additional_skills.some((s) => s.toLowerCase() === sk.toLowerCase())) return prev
      return { ...prev, additional_skills: [...prev.additional_skills, sk] }
    })
    setAddSkillInput('')
  }
  const removeAddSkill = (skill) => setForm((prev) => ({ ...prev, additional_skills: prev.additional_skills.filter((s) => s !== skill) }))

  const clearFilters = () => {
    setFilterLocation('')
    setFilterExperience('')
    setFilterSkill('')
    setSearch('')
  }

  const hasFilters = filterLocation || filterExperience || filterSkill || search

  // Open/close edit modal
  useEffect(() => {
    const dlg = editDialogRef.current
    if (!dlg) return
    if (editingJobId !== null) { if (!dlg.open) dlg.showModal() }
    else { if (dlg.open) dlg.close() }
  }, [editingJobId])

  const updateField = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }))

  const isEditing = editingJobId !== null

  const jobForm = (
    <article className="card" style={{ marginBottom: '1.5rem' }}>
      <div className="card-header" style={{ marginBottom: '1rem' }}>
        <div>
          <h2 className="card-title">{isEditing ? 'Edit Job' : 'New Job Posting'}</h2>
          <p className="card-subtitle">{isEditing ? 'Update the job details below.' : 'Fill in the details to create a new job posting.'}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={fetchAiSuggestions} disabled={aiLoading || !form.title.trim()}>
          {aiLoading ? (
            <><span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Getting suggestions…</>
          ) : (
            <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg> AI Suggestions</>
          )}
        </button>
      </div>
      <form onSubmit={isEditing ? onSaveEdit : onCreateJob}>
        <div className="form-grid">
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="job-title">Job title *</label>
            <input id="job-title" className="input" value={form.title} onChange={updateField('title')} placeholder="e.g. Senior Frontend Developer" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="job-location">Location</label>
            <input id="job-location" className="input" value={form.location} onChange={updateField('location')} placeholder="e.g. Remote, New York" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="job-type">Employment type</label>
            <select id="job-type" className="input" value={form.employment_type} onChange={updateField('employment_type')}>
              <option>Full-time</option>
              <option>Part-time</option>
              <option>Contract</option>
              <option>Internship</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="job-exp">Years of experience</label>
            <input id="job-exp" className="input" type="number" min="0" value={form.years_experience} onChange={updateField('years_experience')} placeholder="e.g. 3" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="job-edu">Education</label>
            <input id="job-edu" className="input" value={form.education} onChange={updateField('education')} placeholder="e.g. Bachelor's in CS" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label">Required skills</label>
            <div
              className="input"
              style={{ minHeight: 44, height: 'auto', display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', cursor: 'text', padding: '6px 10px' }}
              onClick={(e) => e.currentTarget.querySelector('input')?.focus()}
            >
              {form.skills_required.map((s) => (
                <span key={s} className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  {s}
                  <button type="button" onClick={() => removeSkill(s)} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: '0 1px', lineHeight: 1, color: 'inherit', opacity: 0.7, fontSize: '0.9rem' }} title="Remove">×</button>
                </span>
              ))}
              <input
                style={{ border: 'none', outline: 'none', background: 'transparent', minWidth: 130, flex: 1, fontSize: '0.88rem' }}
                value={skillInput}
                onChange={(e) => setSkillInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addSkill(skillInput) }
                  if (e.key === 'Backspace' && !skillInput && form.skills_required.length > 0) removeSkill(form.skills_required[form.skills_required.length - 1])
                }}
                onBlur={() => addSkill(skillInput)}
                placeholder={form.skills_required.length === 0 ? 'Type and press Enter to add…' : ''}
              />
            </div>
          </div>
        </div>
        <div className="field" style={{ marginTop: '1rem' }}>
          <label className="label">Nice-to-have skills</label>
          <div
            className="input"
            style={{ minHeight: 44, height: 'auto', display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', cursor: 'text', padding: '6px 10px' }}
            onClick={(e) => e.currentTarget.querySelector('input')?.focus()}
          >
            {form.additional_skills.map((s) => (
              <span key={s} className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, borderStyle: 'dashed' }}>
                {s}
                <button type="button" onClick={() => removeAddSkill(s)} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: '0 1px', lineHeight: 1, color: 'inherit', opacity: 0.7, fontSize: '0.9rem' }} title="Remove">×</button>
              </span>
            ))}
            <input
              style={{ border: 'none', outline: 'none', background: 'transparent', minWidth: 130, flex: 1, fontSize: '0.88rem' }}
              value={addSkillInput}
              onChange={(e) => setAddSkillInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addAddSkill(addSkillInput) }
                if (e.key === 'Backspace' && !addSkillInput && form.additional_skills.length > 0) removeAddSkill(form.additional_skills[form.additional_skills.length - 1])
              }}
              onBlur={() => addAddSkill(addSkillInput)}
              placeholder={form.additional_skills.length === 0 ? 'Type and press Enter to add…' : ''}
            />
          </div>
        </div>
        <div className="field" style={{ marginTop: '0.75rem' }}>
          <label className="label" htmlFor="job-desc">Description *</label>
          <textarea id="job-desc" className="input" rows={4} value={form.description} onChange={updateField('description')} placeholder="Describe the role, responsibilities, and requirements…" />
        </div>

        {/* AI Suggestions Panel */}
        {aiSuggestions && (
          <div className="ai-suggest-panel" style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>
              <strong style={{ fontSize: '0.9rem' }}>AI Suggestions</strong>
            </div>
            {(aiSuggestions.suggested_skills || []).length > 0 && (
              <div style={{ marginBottom: '0.75rem' }}>
                <div className="label" style={{ marginBottom: '0.4rem' }}>Recommended Skills to Add</div>
                <div className="chip-row" style={{ marginTop: 0 }}>
                  {aiSuggestions.suggested_skills.map((skill) => (
                    <button key={skill} type="button" className="chip ai-chip" onClick={() => applySkillSuggestion(skill)} title="Click to add">+ {skill}</button>
                  ))}
                </div>
              </div>
            )}
            {(aiSuggestions.suggested_additional_skills || []).length > 0 && (
              <div style={{ marginBottom: '0.75rem' }}>
                <div className="label" style={{ marginBottom: '0.4rem' }}>Nice-to-Have Skills</div>
                <div className="chip-row" style={{ marginTop: 0 }}>
                  {aiSuggestions.suggested_additional_skills.map((skill) => (
                    <button key={skill} type="button" className="chip ai-chip" onClick={() => applyAdditionalSkillSuggestion(skill)} title="Click to add">+ {skill}</button>
                  ))}
                </div>
              </div>
            )}
            {aiSuggestions.suggested_description && (
              <div style={{ marginBottom: '0.75rem' }}>
                <div className="label" style={{ marginBottom: '0.4rem' }}>Suggested Description Improvement</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.6, padding: '0.5rem 0.75rem', background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                  {aiSuggestions.suggested_description}
                  <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: '0.5rem', fontSize: '0.75rem' }} onClick={() => setForm((p) => ({ ...p, description: aiSuggestions.suggested_description }))}>Use this</button>
                </div>
              </div>
            )}
            {(aiSuggestions.tips || []).length > 0 && (
              <div>
                <div className="label" style={{ marginBottom: '0.4rem' }}>Tips</div>
                <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.83rem', color: 'var(--text-secondary)' }}>
                  {aiSuggestions.tips.map((tip, i) => <li key={i} style={{ marginBottom: '0.25rem' }}>{tip}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
          <button type="submit" className="btn btn-primary" disabled={creating || saving}>
            {(creating || saving) ? <><span className="loading-spinner" />{isEditing ? 'Saving…' : 'Creating…'}</> : isEditing ? 'Save Changes' : 'Create Job'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={isEditing ? cancelEdit : () => setShowForm(false)}>Cancel</button>
        </div>
      </form>
    </article>
  )

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Jobs</h1>
            <p className="page-subtitle">Manage job postings and track candidates per role.</p>
          </div>
          {!isEditing && (
            <button type="button" className="btn btn-primary" onClick={() => { setShowForm(!showForm); setEditingJobId(null); setForm({ ...emptyForm }); setSkillInput(''); setAddSkillInput(''); setAiSuggestions(null) }}>
              {showForm ? 'Cancel' : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  New Job
                </>
              )}
            </button>
          )}
        </div>

        {error && <div className="error-banner">{error}</div>}
        {message && (
          <div className="alert alert-success" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            {message}
          </div>
        )}

        {showForm && !isEditing && jobForm}

        <article className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">All Jobs</h2>
              <p className="card-subtitle">{loading ? 'Loading…' : `${filteredRows.length} of ${rows.length} job${rows.length !== 1 ? 's' : ''}`}</p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={loadJobs} disabled={loading}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Refresh
            </button>
          </div>

          <div className="search-bar">
            <span className="search-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </span>
            <input className="input" placeholder="Search by title or description…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          {/* Filters */}
          <div className="job-filters">
            <select className="input job-filter-select" value={filterLocation} onChange={(e) => setFilterLocation(e.target.value)}>
              <option value="">All Locations</option>
              {allLocations.map((loc) => <option key={loc} value={loc}>{loc}</option>)}
            </select>
            <select className="input job-filter-select" value={filterExperience} onChange={(e) => setFilterExperience(e.target.value)}>
              <option value="">All Experience</option>
              <option value="0">Fresher (0 yrs)</option>
              <option value="1">1-2 years</option>
              <option value="3">3-5 years</option>
              <option value="5">5+ years</option>
            </select>
            <select className="input job-filter-select" value={filterSkill} onChange={(e) => setFilterSkill(e.target.value)}>
              <option value="">All Skills</option>
              {allSkills.map((sk) => <option key={sk} value={sk}>{sk}</option>)}
            </select>
            {hasFilters && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                Clear
              </button>
            )}
          </div>

          {loading ? (
            <div style={{ padding: '2rem 0', textAlign: 'center' }}>
              <span className="loading-spinner" style={{ width: 24, height: 24, borderWidth: 3 }} />
              <p className="muted" style={{ marginTop: '0.75rem' }}>Loading jobs…</p>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
              </div>
              <div className="empty-state-title">No jobs found</div>
              <div className="empty-state-desc">{hasFilters ? 'Try adjusting your filters.' : 'Create your first job posting to get started.'}</div>
              {hasFilters && <button type="button" className="btn btn-ghost" style={{ marginTop: '0.5rem' }} onClick={clearFilters}>Clear Filters</button>}
            </div>
          ) : (
            <div className="job-cards-grid" style={{ marginTop: '0.25rem' }}>
              {filteredRows.map((job) => (
                <div key={job.id} className="job-card" onClick={() => openEditJob(job)} style={{ cursor: 'pointer' }} title="Click to edit">
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.75rem' }}>
                    <h3 className="job-card-title">{job.title || '—'}</h3>
                    <span className="badge-soft" style={{ flexShrink: 0 }}>{job.employment_type || 'Job'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.85rem' }}>
                    {job.location && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                        {job.location}
                      </span>
                    )}
                    {job.years_experience != null && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        {job.years_experience}+ yrs
                      </span>
                    )}
                  </div>
                  {(job.skills_required || []).length > 0 && (
                    <div className="chip-row" style={{ marginTop: 0 }}>
                      {(job.skills_required || []).slice(0, 4).map((s) => <span key={s} className="chip">{s}</span>)}
                      {(job.skills_required || []).length > 4 ? <span className="chip">+{job.skills_required.length - 4}</span> : null}
                    </div>
                  )}
                  <div className="muted" style={{ fontSize: '0.72rem', marginTop: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    Click to edit
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>

      {/* ── Edit Job Modal ── */}
      <dialog
        ref={editDialogRef}
        className="modal-dialog"
        onClick={(e) => { if (e.target === editDialogRef.current) cancelEdit() }}
      >
        <div style={{ width: 'min(700px, calc(100vw - 2rem))', background: 'var(--bg)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', maxHeight: '90vh', overflowY: 'auto' }}>
          {isEditing && jobForm}
        </div>
      </dialog>
    </main>
  )
}

export default Jobs
