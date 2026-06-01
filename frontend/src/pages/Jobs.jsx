import { useEffect, useMemo, useRef, useState } from 'react'
import { jobs, chat, departments } from '../api'

function Jobs() {
  const token = null
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

  // Departments
  const [deptList, setDeptList] = useState([])

  // AI JD Generator modal
  const [showJDModal, setShowJDModal] = useState(false)
  const [jdLoading, setJdLoading] = useState(false)
  const [jdForm, setJdForm] = useState({
    role_title: '',
    department: '',
    employment_type: 'Full-time',
    years_experience: '',
    location: '',
    key_responsibilities: '',
    must_have_skills: '',
    salary_min: '',
    salary_max: '',
    salary_currency: 'INR',
  })

  const emptyForm = {
    title: '',
    description: '',
    location: '',
    employment_type: 'Full-time',
    education: '',
    years_experience: '',
    skills_required: [],
    additional_skills: [],
    status: 'active',
    department_id: '',
    salary_min: '',
    salary_max: '',
    salary_currency: 'INR',
    is_template: false,
    template_name: '',
  }

  const [form, setForm] = useState({ ...emptyForm })
  const [skillInput, setSkillInput] = useState('')
  const [addSkillInput, setAddSkillInput] = useState('')
  const editDialogRef = useRef(null)

  const loadJobs = async () => {
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

  useEffect(() => {
    loadJobs()
    departments.list(token).then(d => setDeptList(Array.isArray(d) ? d : [])).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const refresh = () => { void loadJobs() }
    window.addEventListener('smarthire:refresh-jobs', refresh)
    return () => window.removeEventListener('smarthire:refresh-jobs', refresh)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
    status: form.status || 'active',
    department_id: form.department_id ? Number(form.department_id) : null,
    salary_min: form.salary_min ? Number(form.salary_min) : null,
    salary_max: form.salary_max ? Number(form.salary_max) : null,
    salary_currency: form.salary_currency || 'INR',
    is_template: form.is_template || false,
    template_name: form.is_template ? (form.template_name || null) : null,
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
      status: job.status || 'active',
      department_id: job.department_id != null ? String(job.department_id) : '',
      salary_min: job.salary_min != null ? String(job.salary_min) : '',
      salary_max: job.salary_max != null ? String(job.salary_max) : '',
      salary_currency: job.salary_currency || 'INR',
      is_template: job.is_template || false,
      template_name: job.template_name || '',
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

  const openJDModal = () => {
    setJdForm(f => ({ ...f, role_title: form.title || '' }))
    setShowJDModal(true)
  }

  const generateJD = async (e) => {
    e.preventDefault()
    if (!jdForm.role_title.trim()) return
    setJdLoading(true)
    try {
      const result = await jobs.generateJD(token, {
        ...jdForm,
        years_experience: jdForm.years_experience ? Number(jdForm.years_experience) : null,
        salary_min: jdForm.salary_min ? Number(jdForm.salary_min) : null,
        salary_max: jdForm.salary_max ? Number(jdForm.salary_max) : null,
      })
      setForm(prev => ({
        ...prev,
        title: result.title || prev.title,
        description: result.description || prev.description,
        education: result.education || prev.education,
        years_experience: result.years_experience != null ? String(result.years_experience) : prev.years_experience,
        location: result.location || prev.location,
        employment_type: result.employment_type || prev.employment_type,
        skills_required: (result.skills_required || []).length > 0 ? result.skills_required : prev.skills_required,
        additional_skills: (result.additional_skills || []).length > 0 ? result.additional_skills : prev.additional_skills,
        salary_min: result.salary_min != null ? String(result.salary_min) : prev.salary_min,
        salary_max: result.salary_max != null ? String(result.salary_max) : prev.salary_max,
        salary_currency: jdForm.salary_currency || prev.salary_currency,
      }))
      setShowJDModal(false)
      setMessage('JD generated — review and adjust before saving.')
    } catch (err) {
      setError(err?.message || 'AI JD generation failed')
    } finally { setJdLoading(false) }
  }

  const onDeleteJob = async (jobId, jobTitle) => {
    if (!window.confirm(`Delete "${jobTitle}"? This will permanently remove the job and all associated data.`)) return
    setError('')
    try {
      await jobs.delete(token, jobId)
      setRows((prev) => prev.filter((j) => j.id !== jobId))
      setMessage('Job deleted.')
    } catch (err) {
      setError(err?.message || 'Failed to delete job')
    }
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
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={fetchAiSuggestions} disabled={aiLoading || !form.title.trim()}>
          {aiLoading ? (
            <><span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Getting suggestions…</>
          ) : (
            <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg> AI Suggestions</>
          )}
        </button>
        </div>
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
            <label className="label" htmlFor="job-status">Status</label>
            <select id="job-status" className="input" value={form.status} onChange={updateField('status')}>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="job-dept">Department</label>
            <select id="job-dept" className="input" value={form.department_id} onChange={updateField('department_id')}>
              <option value="">No department</option>
              {deptList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="job-sal-currency">Salary Currency</label>
            <select id="job-sal-currency" className="input" value={form.salary_currency} onChange={updateField('salary_currency')}>
              <option>INR</option><option>USD</option><option>GBP</option><option>EUR</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="job-sal-min">Salary Min ({form.salary_currency})</label>
            <input id="job-sal-min" className="input" type="number" min={0} value={form.salary_min} onChange={updateField('salary_min')} placeholder="e.g. 800000" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="job-sal-max">Salary Max ({form.salary_currency})</label>
            <input id="job-sal-max" className="input" type="number" min={0} value={form.salary_max} onChange={updateField('salary_max')} placeholder="e.g. 1400000" />
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

        <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: 'var(--bg-subtle, #f8fafc)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.88rem', fontWeight: 500 }}>
            <input type="checkbox" checked={form.is_template} onChange={e => setForm(p => ({ ...p, is_template: e.target.checked }))} />
            Save as reusable template
          </label>
          {form.is_template && (
            <input className="input" style={{ marginTop: '0.5rem' }} value={form.template_name} onChange={updateField('template_name')} placeholder="Template name (e.g. Senior Backend Engineer Template)" />
          )}
        </div>
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
                      <span className="badge-soft">{job.employment_type || 'Job'}</span>
                      {job.status && job.status !== 'active' && (
                        <span className="badge-soft" style={{ background: job.status === 'closed' ? '#fee2e2' : '#fef9c3', color: job.status === 'closed' ? '#b91c1c' : '#854d0e' }}>
                          {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                        </span>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ padding: '0.2rem 0.4rem', color: '#ef4444', opacity: 0.8 }}
                        title="Delete job"
                        onClick={(e) => { e.stopPropagation(); void onDeleteJob(job.id, job.title) }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                      </button>
                    </div>
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
        <div style={{ width: 'min(700px, calc(100vw - 2rem))', background: 'var(--bg)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', maxHeight: '90vh', overflowY: 'auto', position: 'relative' }}>
          <button
            type="button"
            onClick={cancelEdit}
            title="Close"
            style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', lineHeight: 1, padding: '0.25rem', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-secondary)'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          {isEditing && jobForm}
        </div>
      </dialog>

      {/* ── AI JD Generator Modal ── */}
      {showJDModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }} onClick={e => { if (e.target === e.currentTarget) setShowJDModal(false) }}>
          <div style={{ background: 'var(--bg)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', width: 'min(600px, 100%)', maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ margin: '0 0 0.25rem', fontSize: '1.1rem', fontWeight: 700 }}>✨ Generate JD with AI</h2>
            <p style={{ margin: '0 0 1.25rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Fill in the details — AI will write a full job description and pre-fill the form.</p>
            <form onSubmit={generateJD}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label className="label">Role Title *</label>
                  <input className="input" required value={jdForm.role_title} onChange={e => setJdForm(f => ({ ...f, role_title: e.target.value }))} placeholder="e.g. Senior Data Engineer" />
                </div>
                <div>
                  <label className="label">Department</label>
                  <input className="input" value={jdForm.department} onChange={e => setJdForm(f => ({ ...f, department: e.target.value }))} placeholder="e.g. Engineering" />
                </div>
                <div>
                  <label className="label">Employment Type</label>
                  <select className="input" value={jdForm.employment_type} onChange={e => setJdForm(f => ({ ...f, employment_type: e.target.value }))}>
                    <option>Full-time</option><option>Part-time</option><option>Contract</option><option>Internship</option>
                  </select>
                </div>
                <div>
                  <label className="label">Years of Experience</label>
                  <input className="input" type="number" min={0} value={jdForm.years_experience} onChange={e => setJdForm(f => ({ ...f, years_experience: e.target.value }))} placeholder="e.g. 4" />
                </div>
                <div>
                  <label className="label">Location</label>
                  <input className="input" value={jdForm.location} onChange={e => setJdForm(f => ({ ...f, location: e.target.value }))} placeholder="e.g. Bangalore / Remote" />
                </div>
                <div>
                  <label className="label">Salary Currency</label>
                  <select className="input" value={jdForm.salary_currency} onChange={e => setJdForm(f => ({ ...f, salary_currency: e.target.value }))}>
                    <option>INR</option><option>USD</option><option>GBP</option><option>EUR</option>
                  </select>
                </div>
                <div>
                  <label className="label">Salary Min</label>
                  <input className="input" type="number" min={0} value={jdForm.salary_min} onChange={e => setJdForm(f => ({ ...f, salary_min: e.target.value }))} placeholder="e.g. 1000000" />
                </div>
                <div>
                  <label className="label">Salary Max</label>
                  <input className="input" type="number" min={0} value={jdForm.salary_max} onChange={e => setJdForm(f => ({ ...f, salary_max: e.target.value }))} placeholder="e.g. 1800000" />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label className="label">Key Responsibilities (hint)</label>
                  <textarea className="input" rows={2} value={jdForm.key_responsibilities} onChange={e => setJdForm(f => ({ ...f, key_responsibilities: e.target.value }))} placeholder="e.g. Build data pipelines, own ETL architecture…" />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label className="label">Must-Have Skills (hint)</label>
                  <textarea className="input" rows={2} value={jdForm.must_have_skills} onChange={e => setJdForm(f => ({ ...f, must_have_skills: e.target.value }))} placeholder="e.g. Python, Spark, dbt, Airflow" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
                <button className="btn btn-primary" type="submit" disabled={jdLoading}>
                  {jdLoading ? <><span className="loading-spinner" /> Generating…</> : '✨ Generate JD'}
                </button>
                <button className="btn btn-ghost" type="button" onClick={() => setShowJDModal(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  )
}

export default Jobs
