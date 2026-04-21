import { useEffect, useMemo, useRef, useState } from 'react'
import { assessmentApi } from '../assessmentApi'
import { calls as callsApi } from '../api'

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

function formatDate(value) {
  if (!value) return '--'
  try {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return String(value)
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  } catch {
    return String(value)
  }
}

// IST = UTC + 5:30 (330 min). datetime-local inputs are timezone-unaware,
// so we explicitly shift to/from IST.
function utcToISTInput(isoString) {
  if (!isoString) return ''
  const d = new Date(isoString)
  if (Number.isNaN(d.getTime())) return ''
  const ist = new Date(d.getTime() + 330 * 60 * 1000)
  return ist.toISOString().slice(0, 16)
}

function istInputToISO(value) {
  // Parse a datetime-local value (YYYY-MM-DDTHH:MM) as IST and return UTC ISO
  if (!value) return null
  const [datePart, timePart] = value.split('T')
  if (!datePart || !timePart) return null
  const [year, month, day] = datePart.split('-').map(Number)
  const [hour, minute] = timePart.split(':').map(Number)
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute) - 330 * 60 * 1000)
  return utc.toISOString()
}

function nowISTPlus(minutes = 60) {
  // Current IST time + N minutes, formatted for datetime-local
  const ist = new Date(Date.now() + 330 * 60 * 1000 + minutes * 60 * 1000)
  return ist.toISOString().slice(0, 16)
}

function nowISTMin() {
  // Current IST time (used as min for datetime-local)
  const ist = new Date(Date.now() + 330 * 60 * 1000)
  return ist.toISOString().slice(0, 16)
}

function shortJson(value, max = 220) {
  if (!value) return ''
  try {
    const text = JSON.stringify(value)
    if (text.length <= max) return text
    return `${text.slice(0, max)}...`
  } catch {
    const text = String(value)
    return text.length <= max ? text : `${text.slice(0, max)}...`
  }
}

function severityLabel(severity) {
  const s = String(severity || 'low').toLowerCase()
  if (s === 'high') return 'high'
  if (s === 'medium') return 'medium'
  return 'low'
}

function fmtScore(row) {
  if (!row) return '--'
  const score = row.score
  const total = row.total
  const pct = row.percentage
  const left = score != null && total != null ? `${score}/${total}` : '--'
  const right = pct != null ? `${Number(pct).toFixed(1)}%` : '--'
  return `${left} - ${right}`
}

function formatSignal(signal) {
  if (!signal) return ''
  const label = signal.label || signal.event_type || 'signal'
  return label
}

function severityIcon(sev) {
  const s = String(sev || 'low').toLowerCase()
  if (s === 'high') return 'H'
  if (s === 'medium') return 'M'
  return 'L'
}

function proctorLabel(eventType) {
  const map = {
    'camera_analysis': 'Webcam Integrity Check',
    'audio_check': 'Audio Check',
    'no_face_detected': 'Face Not Visible',
    'multiple_faces_detected': 'Multiple Faces in Frame',
    'suspicious_face_movement': 'Face Looked Away from Screen',
    'suspicious_eye_movement': 'Face Looked Away from Screen',
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
    'face_id_verification': 'Identity Artifacts Saved',
    'multiple_tabs_detected': 'Multiple Exam Tabs Opened',
    'call_interview_hr_prompt': 'Interviewer Prompt',
    'call_interview_candidate_response': 'Candidate Response',
    'call_interview_call_initiated': 'Call Initiated',
    'call_interview_call_status': 'Call Status Update',
    'call_interview_completed': 'Call Completed',
    'call_interview_email_scheduled': 'Interview Scheduled',
    'call_interview_recording_ready': 'Call Recording Saved',
    'call_interview_transcript_ready': 'Transcript Generated',
    'call_interview_transcript_failed': 'Transcript Generation Failed',
    'call_interview_call_failed': 'Call Failed',
    'call_interview_failed_no_phone': 'Call Failed (No Phone)',
  }
  return map[eventType] || (eventType || 'event').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function proctorDesc(eventType) {
  const map = {
    'camera_analysis': 'Periodic webcam frame analyzed for faces, objects, and gaze direction',
    'no_face_detected': 'Candidate\'s face was not visible in the camera feed',
    'multiple_faces_detected': 'More than one person was detected in the webcam',
    'suspicious_face_movement': 'Candidate repeatedly looked away from the exam screen',
    'suspicious_eye_movement': 'Candidate repeatedly looked away from the exam screen',
    'suspicious_head_movement': 'Candidate\'s head turned significantly away from the screen',
    'suspicious_object_detected': 'A phone, second device, or prohibited object was spotted on camera',
    'audio_anomaly_detected': 'Unusual audio pattern detected - possible external help',
    'voice_activity_detected': 'Microphone picked up speaking during a silent exam section',
    'speech_detected': 'Actual words / conversation detected through microphone',
    'speech_recognition': 'Transcript of detected speech was captured',
    'tab_switched': 'Candidate navigated away from the exam browser tab',
    'window_blur': 'The exam window lost focus (e.g., switched to another app)',
    'fullscreen_exited': 'Candidate exited the required fullscreen mode',
    'devtools_detected': 'Browser developer tools were opened during the exam',
    'shortcut_burst_detected': 'Rapid keyboard shortcuts suggesting copy-paste or search',
    'network_offline': 'Candidate\'s internet connection dropped during the exam',
    'face_id_verification': 'Government ID and live selfie were stored for audit',
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

function IconTranscript({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 4h12v16l-3-2-3 2-3-2-3 2V4z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M9 9h6M9 12h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function IconDownload({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 4v10m0 0l-4-4m4 4l4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 20h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function IconTrash({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M10 11v6m4-6v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M6 7l1 12h10l1-12M9 7V5h6v2" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}

function transcriptPayloadToText(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const text = String(payload.transcript_text || '').trim()
  return text
}

function callLogSummary(item) {
  const type = String(item?.type || '').trim()
  const payload = item?.payload || {}
  if (type === 'call_interview_call_status') {
    return `Status changed to ${String(payload.status || 'unknown').replace(/_/g, ' ')}.`
  }
  if (type === 'call_interview_call_initiated') {
    return 'Interview call was initiated by the system.'
  }
  if (type === 'call_interview_completed') {
    return 'Interview call flow completed.'
  }
  if (type === 'call_interview_email_scheduled') {
    return 'Interview schedule email was sent to candidate.'
  }
  if (type === 'call_interview_recording_ready') {
    if (payload.download_error) return 'Recording callback received, but recording download failed.'
    return 'Recording is available for playback.'
  }
  if (type === 'call_interview_transcript_ready') {
    const wc = Number(payload.word_count || 0)
    return wc > 0 ? `Transcript generated (${wc} words).` : 'Transcript generated from call recording.'
  }
  if (type === 'call_interview_transcript_failed') {
    return 'Transcript generation failed for this call recording.'
  }
  if (type === 'call_interview_candidate_response') {
    return 'Candidate response captured.'
  }
  if (type === 'call_interview_hr_prompt') {
    return 'Interviewer prompt delivered.'
  }
  return ''
}
function getResultLabel(row) {
  const status = String(row.status || '').toLowerCase()
  const pipeline = String(row.pipeline_stage || '').toLowerCase()
  if (pipeline === 'rejected' || status === 'rejected') return 'Rejected'
  if (status === 'submitted' || status === 'scored') {
    return row.passed ? 'Passed' : 'Not Passed'
  }
  return status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || '--'
}

function getResultStyle(row) {
  const label = getResultLabel(row)
  if (label === 'Passed') return { bg: '#dcfce7', color: '#15803d', border: '#86efac' }
  if (label === 'Not Passed') return { bg: '#fef2f2', color: '#dc2626', border: '#fca5a5' }
  if (label === 'Rejected') return { bg: '#f1f5f9', color: '#64748b', border: '#cbd5e1' }
  return { bg: '#f0f9ff', color: '#0369a1', border: '#bae6fd' }
}

function getCallStatusLabel(callStatus) {
  const s = String(callStatus || '').toLowerCase()
  if (!s || s === 'not_scheduled') return 'Not Scheduled'
  if (s === 'scheduled') return 'Scheduled'
  if (s === 'in_progress') return 'In Progress'
  if (s === 'completed') return 'Completed'
  if (s === 'failed' || s === 'failed_no_phone') return 'Failed'
  if (s === 'not_picked') return 'Not Picked Up'
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function getCallStatusStyle(callStatus) {
  const s = String(callStatus || '').toLowerCase()
  if (s === 'completed') return { bg: '#dcfce7', color: '#15803d', border: '#86efac' }
  if (s === 'scheduled') return { bg: '#eff6ff', color: '#2563eb', border: '#bfdbfe' }
  if (s === 'in_progress') return { bg: '#fefce8', color: '#ca8a04', border: '#fde68a' }
  if (s === 'failed' || s === 'failed_no_phone') return { bg: '#fef2f2', color: '#dc2626', border: '#fca5a5' }
  if (s === 'not_picked') return { bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' }
  return { bg: '#f8fafc', color: '#94a3b8', border: '#e2e8f0' }
}

function AssessmentDetails() {
  const PASS_THRESHOLD = 60
  const token = useMemo(() => localStorage.getItem('token') || '', [])
  const [sessions, setSessions] = useState([])
  const [search, setSearch] = useState('')
  const [selectedCode, setSelectedCode] = useState('')
  const [detail, setDetail] = useState(null)
  const [loadingList, setLoadingList] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [loadingAction, setLoadingAction] = useState(false)
  const [error, setError] = useState('')
  const [listMessage, setListMessage] = useState('')
  const [listError, setListError] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [deletingSessionCode, setDeletingSessionCode] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [filterStatus, setFilterStatus] = useState('all')
  const [filterInterview, setFilterInterview] = useState('all')
  const [filterJobRole, setFilterJobRole] = useState('all')
  const [filterResult, setFilterResult] = useState('all')
  const [scheduledFor, setScheduledFor] = useState('')
  const [reviewStage, setReviewStage] = useState('assessment_passed')
  const [reviewNotes, setReviewNotes] = useState('')
  const [manualAssessmentScore, setManualAssessmentScore] = useState('')
  const [liveState, setLiveState] = useState('connecting')
  const [lastLiveUpdateAt, setLastLiveUpdateAt] = useState('')
  const [liveNotice, setLiveNotice] = useState('')
  const [recordingAudioByKey, setRecordingAudioByKey] = useState({})
  const [recordingLoadingByKey, setRecordingLoadingByKey] = useState({})
  const [recordingErrorByKey, setRecordingErrorByKey] = useState({})
  const [dbRecordings, setDbRecordings] = useState([])
  const [dbRecordingsLoading, setDbRecordingsLoading] = useState(false)
  const [callAnalysis, setCallAnalysis] = useState(null)
  const [callAnalysisLoading, setCallAnalysisLoading] = useState(false)
  const [callAnalysisTriggerLoading, setCallAnalysisTriggerLoading] = useState(false)
  const [callNowLoading, setCallNowLoading] = useState(false)
  const [showTranscriptPanel, setShowTranscriptPanel] = useState(true)
  const realtimeRefreshTimerRef = useRef(null)
  const detailRequestIdRef = useRef(0)
  const selectedCodeRef = useRef('')
  const recordingAudioByKeyRef = useRef({})
  const dialogRef = useRef(null)

  const detailMatchesSelection = Boolean(
    detail &&
    selectedCode &&
    String(detail.session_code || '').trim() === String(selectedCode || '').trim()
  )
  const detailView = detailMatchesSelection ? detail : null
  const severity = detailView?.severity || { low: 0, medium: 0, high: 0 }

  const allJobRoles = useMemo(() => {
    const set = new Set()
    for (const s of sessions) {
      if (s.job_title) set.add(s.job_title)
    }
    return Array.from(set).sort()
  }, [sessions])

  const filteredSessions = useMemo(() => {
    let list = sessions
    if (filterJobRole !== 'all') {
      list = list.filter((s) => s.job_title === filterJobRole)
    }
    if (filterStatus !== 'all') {
      if (filterStatus === 'sent') list = list.filter((s) => s.status === 'sent' || s.status === 'in_progress')
      else if (filterStatus === 'done') list = list.filter((s) => s.status === 'submitted' || s.status === 'scored')
    }
    if (filterResult !== 'all') {
      if (filterResult === 'passed') list = list.filter((s) => (s.status === 'submitted' || s.status === 'scored') && s.passed && String(s.pipeline_stage || '').toLowerCase() !== 'rejected' && String(s.status || '').toLowerCase() !== 'rejected')
      else if (filterResult === 'not_passed') list = list.filter((s) => (s.status === 'submitted' || s.status === 'scored') && !s.passed && String(s.pipeline_stage || '').toLowerCase() !== 'rejected' && String(s.status || '').toLowerCase() !== 'rejected')
      else if (filterResult === 'rejected') list = list.filter((s) => String(s.pipeline_stage || '').toLowerCase() === 'rejected' || String(s.status || '').toLowerCase() === 'rejected')
    }
    if (filterInterview !== 'all') {
      if (filterInterview === 'scheduled') list = list.filter((s) => s.call_status === 'scheduled' || s.call_status === 'in_progress')
      else if (filterInterview === 'completed') list = list.filter((s) => s.call_status === 'completed')
      else if (filterInterview === 'not_scheduled') list = list.filter((s) => !s.call_status || s.call_status === 'not_scheduled')
      else if (filterInterview === 'failed') list = list.filter((s) => s.call_status === 'failed')
    }
    const q = search.toLowerCase().trim()
    if (!q) return list
    return list.filter((s) =>
      (s.candidate_name || '').toLowerCase().includes(q) ||
      (s.candidate_email || '').toLowerCase().includes(q) ||
      (s.session_code || '').toLowerCase().includes(q) ||
      (s.assessment_type || '').toLowerCase().includes(q) ||
      (s.status || '').toLowerCase().includes(q)
    )
  }, [sessions, search, filterStatus, filterInterview])

  const selectedSummary = useMemo(() => {
    if (!detailView) return ''
    const pct = detailView.percentage != null ? `${Number(detailView.percentage).toFixed(1)}%` : '--'
    const score = detailView.score != null && detailView.total != null ? `${detailView.score}/${detailView.total}` : '--'
    return `${score} - ${pct} - ${detailView.status || '--'}`
  }, [detailView])

  const callLogs = useMemo(() => (
    Array.isArray(detailView?.call_interview_logs) ? detailView.call_interview_logs : []
  ), [detailView])

  const latestRecordingTranscript = useMemo(() => {
    const transcriptLogs = callLogs
      .filter((item) => String(item?.type || '').trim() === 'call_interview_transcript_ready')
      .slice()
      .reverse()
    for (const item of transcriptLogs) {
      const payload = item?.payload || {}
      const text = transcriptPayloadToText(payload)
      if (!text) continue
      return {
        text,
        provider: String(payload.provider || '').trim() || 'elevenlabs',
        languageCode: String(payload.language_code || '').trim() || '',
        wordCount: Number(payload.word_count || text.split(/\s+/).filter(Boolean).length || 0),
      }
    }
    return null
  }, [callLogs])

  const transcriptText = useMemo(() => {
    if (latestRecordingTranscript?.text) return latestRecordingTranscript.text

    const lines = []
    for (const item of callLogs) {
      const type = String(item?.type || '').trim()
      const payload = item?.payload || {}

      if (type === 'transcript_turn') {
        const ts = item?.timestamp ? formatDate(item.timestamp) : '--'
        const turn = payload?.turn ? ` (Turn ${payload.turn})` : ''
        const candidateSpeech = String(payload?.candidate_speech || '').trim()
        const interviewerText = String(payload?.interviewer || '').trim()
        if (candidateSpeech) lines.push(`[${ts}] Candidate${turn}: ${candidateSpeech}`)
        if (interviewerText) lines.push(`[${ts}] Interviewer${turn}: ${interviewerText}`)
        continue
      }

      if (type !== 'call_interview_hr_prompt' && type !== 'call_interview_candidate_response') continue
      const ts = item?.timestamp ? formatDate(item.timestamp) : '--'
      const turn = payload?.hr_turn ? ` (Turn ${payload.hr_turn})` : ''
      const candidateSpeech = String(payload?.candidate_speech || '').trim()
      const interviewerText = String(payload?.interviewer_text || '').trim()
      if (candidateSpeech) lines.push(`[${ts}] Candidate${turn}: ${candidateSpeech}`)
      if (interviewerText) lines.push(`[${ts}] Interviewer${turn}: ${interviewerText}`)
    }
    return lines.join('\n')
  }, [callLogs, latestRecordingTranscript])

  const screenshotFrames = useMemo(() => {
    const events = Array.isArray(detailView?.events) ? detailView.events : []
    return events
      .filter((event) => {
        if (String(event?.event_type || '').trim() !== 'screenshot_captured') return false
        const img = String(event?.payload?.image_base64 || '').trim()
        return img.startsWith('data:image/')
      })
      .slice(-12)
      .reverse()
      .map((event, idx) => ({
        key: `${event?.created_at || idx}`,
        createdAt: event?.created_at,
        imageBase64: String(event?.payload?.image_base64 || ''),
      }))
  }, [detailView])

  async function loadList({ silent = false } = {}) {
    setError('')
    if (!silent) setLoadingList(true)
    try {
      const data = await assessmentApi.adminListExams({
        assessmentType: '',
        candidateEmail: '',
        limit: 50,
        offset: 0,
      })
      setSessions(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err?.message || 'Failed to load exams')
    } finally {
      if (!silent) setLoadingList(false)
    }
  }

  async function loadDetail(code, { silent = false } = {}) {
    if (!code) return
    const normalizedCode = String(code || '').trim()
    const requestId = silent ? detailRequestIdRef.current : detailRequestIdRef.current + 1
    if (!silent) detailRequestIdRef.current = requestId
    setError('')
    if (!silent) setLoadingDetail(true)
    try {
      const data = await assessmentApi.adminGetExamDetail(normalizedCode, { assessmentType: '' })
      if (!silent && requestId !== detailRequestIdRef.current) return
      if (silent && String(selectedCodeRef.current || '').trim() !== normalizedCode) return
      setDetail(data)
      if (!silent) {
        fetchDbRecordings(normalizedCode)
        fetchCallAnalysis(normalizedCode)
      }
    } catch (err) {
      if (!silent && requestId !== detailRequestIdRef.current) return
      if (silent && String(selectedCodeRef.current || '').trim() !== normalizedCode) return
      setDetail(null)
      setError(err?.message || 'Failed to load exam detail')
    } finally {
      if (!silent && requestId === detailRequestIdRef.current) setLoadingDetail(false)
    }
  }

  function openDetail(code) {
    const nextCode = String(code || '').trim()
    if (!nextCode) return
    if (nextCode !== String(selectedCode || '').trim()) {
      setDetail(null)
      setLoadingDetail(true)
      setActionMessage('')
      setActionError('')
    }
    setSelectedCode(nextCode)
    setModalOpen(true)
  }

  function closeModal() {
    setModalOpen(false)
  }

  function downloadTranscriptFile() {
    if (!transcriptText) return
    const fileName = `transcript-${String(selectedCode || 'session').trim() || 'session'}.txt`
    const blob = new Blob([transcriptText], { type: 'text/plain;charset=utf-8' })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000)
  }

  async function playRecording(logItem, idx) {
    const payload = logItem?.payload || {}
    const fileName = String(payload?.recording_file_name || '').trim()
    const fallbackUrl = String(payload?.recording_fetch_url || '').trim()
    const directRecordingUrl = String(payload?.recording_url || '').trim()
    const key = fileName || String(payload?.recording_sid || idx)
    if (!key || recordingAudioByKeyRef.current[key] || recordingLoadingByKey[key]) return

    setRecordingErrorByKey((prev) => ({ ...(prev || {}), [key]: '' }))
    setRecordingLoadingByKey((prev) => ({ ...(prev || {}), [key]: true }))
    const candidates = []
    if (fileName) {
      candidates.push(`/api/calls/voice/recordings/${encodeURIComponent(fileName)}`)
    }
    if (fallbackUrl) candidates.push(fallbackUrl)
    if (directRecordingUrl) {
      candidates.push(`/api/calls/voice/recordings-proxy?recording_url=${encodeURIComponent(directRecordingUrl)}`)
    }

    let lastError = 'Unable to load recording'
    for (const candidateUrl of candidates) {
      try {
        const response = await fetch(candidateUrl, {
          method: 'GET',
          credentials: 'include',
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : null),
          },
        })
        if (!response.ok) {
          lastError = `Recording fetch failed (${response.status})`
          continue
        }
        const blob = await response.blob()
        if (!blob || !blob.size) {
          lastError = 'Recording file is empty'
          continue
        }
        const objectUrl = URL.createObjectURL(blob)
        const previousUrl = recordingAudioByKeyRef.current[key]
        if (previousUrl) URL.revokeObjectURL(previousUrl)
        setRecordingAudioByKey((prev) => ({ ...(prev || {}), [key]: objectUrl }))
        setRecordingLoadingByKey((prev) => ({ ...(prev || {}), [key]: false }))
        return
      } catch (err) {
        lastError = err?.message || 'Unable to load recording'
      }
    }

    setRecordingErrorByKey((prev) => ({ ...(prev || {}), [key]: lastError }))
    setRecordingLoadingByKey((prev) => ({ ...(prev || {}), [key]: false }))
  }

  async function fetchDbRecordings(sessionCode) {
    if (!sessionCode) return
    setDbRecordingsLoading(true)
    try {
      const resp = await fetch(`/api/calls/voice/db-recordings?session_code=${encodeURIComponent(sessionCode)}`, {
        credentials: 'include',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      })
      if (resp.ok) {
        const data = await resp.json()
        setDbRecordings(Array.isArray(data) ? data : [])
      }
    } catch { /* ignore */ }
    setDbRecordingsLoading(false)
  }

  async function fetchCallAnalysis(sessionCode) {
    if (!sessionCode) return
    setCallAnalysisLoading(true)
    try {
      const data = await callsApi.getAnalysis(sessionCode)
      setCallAnalysis(data)
    } catch (e) {
      if (!String(e?.message || '').includes('404')) {
        console.warn('Call analysis fetch error:', e)
      }
      setCallAnalysis(null)
    }
    setCallAnalysisLoading(false)
  }

  async function triggerCallAnalysis(sessionCode) {
    if (!sessionCode) return
    setCallAnalysisTriggerLoading(true)
    try {
      const result = await callsApi.triggerAnalysis(sessionCode)
      // triggerAnalysis now runs synchronously and returns the analysis
      if (result?.overall_score != null) {
        setCallAnalysis(result)
      } else {
        // fallback: fetch separately
        await fetchCallAnalysis(sessionCode)
      }
    } catch (e) {
      console.warn('Trigger analysis error:', e)
    }
    setCallAnalysisTriggerLoading(false)
  }

  async function playDbRecording(rec) {
    const key = `db-${rec.id}`
    if (recordingAudioByKeyRef.current[key] || recordingLoadingByKey[key]) return
    setRecordingLoadingByKey((prev) => ({ ...prev, [key]: true }))
    setRecordingErrorByKey((prev) => ({ ...prev, [key]: '' }))
    try {
      const resp = await fetch(`/api/calls/voice/db-recordings/${rec.id}`, {
        credentials: 'include',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      })
      if (!resp.ok) throw new Error(`Failed (${resp.status})`)
      const blob = await resp.blob()
      if (!blob?.size) throw new Error('Empty recording')
      const url = URL.createObjectURL(blob)
      const prev = recordingAudioByKeyRef.current[key]
      if (prev) URL.revokeObjectURL(prev)
      recordingAudioByKeyRef.current[key] = url
      setRecordingAudioByKey((p) => ({ ...p, [key]: url }))
    } catch (err) {
      setRecordingErrorByKey((p) => ({ ...p, [key]: err?.message || 'Failed to load' }))
    }
    setRecordingLoadingByKey((p) => ({ ...p, [key]: false }))
  }

  async function deleteDbRecording(rec) {
    if (!window.confirm(`Delete this call recording (${rec.file_name})? This cannot be undone.`)) return
    try {
      const resp = await fetch(`/api/calls/voice/db-recordings/${rec.id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      })
      if (!resp.ok) throw new Error(`Delete failed (${resp.status})`)
      // Clean up audio URL if playing
      const key = `db-${rec.id}`
      const url = recordingAudioByKeyRef.current[key]
      if (url) { URL.revokeObjectURL(url); delete recordingAudioByKeyRef.current[key] }
      setRecordingAudioByKey((p) => { const n = { ...p }; delete n[key]; return n })
      setDbRecordings((prev) => prev.filter((r) => r.id !== rec.id))
    } catch (err) {
      alert(err?.message || 'Failed to delete recording')
    }
  }

  async function deleteAssessmentSession(sessionCode) {
    const code = String(sessionCode || '').trim()
    if (!code || deletingSessionCode) return

    const ok = window.confirm(`Delete assessment session ${code}? This will permanently remove logs and artifacts for this attempt.`)
    if (!ok) return

    setListError('')
    setListMessage('')
    setDeletingSessionCode(code)
    try {
      const res = await assessmentApi.adminDeleteExam(code)
      setSessions((prev) => (prev || []).filter((row) => String(row?.session_code || '').trim() !== code))

      if (String(selectedCode || '').trim() === code) {
        setSelectedCode('')
        setDetail(null)
        setModalOpen(false)
      }

      setListMessage(res?.message || 'Assessment session deleted successfully.')
      await loadList({ silent: true })
    } catch (err) {
      setListError(err?.message || 'Failed to delete assessment session')
    } finally {
      setDeletingSessionCode('')
    }
  }

  async function callNow() {
    if (!selectedCode || callNowLoading) return
    const phone = detail?.candidate_phone
    if (!phone) {
      setActionError('No phone number on file for this candidate. Add it in the Candidates page first.')
      return
    }
    if (!window.confirm(`Place an immediate call to ${phone}?`)) return
    setActionMessage('')
    setActionError('')
    setCallNowLoading(true)
    try {
      const res = await callsApi.placeCall({
        phone_number: phone,
        position: detail?.job_title || 'the role',
        candidate_name: detail?.candidate_name || 'Candidate',
        session_code: selectedCode,
        candidate_email: detail?.candidate_email || '',
      })
      setActionMessage(`Call placed! Status: ${res?.status || 'initiated'}. Call SID: ${res?.call_sid || '—'}`)
      await loadDetail(selectedCode)
    } catch (err) {
      setActionError(err?.message || 'Failed to place call')
    } finally {
      setCallNowLoading(false)
    }
  }

  async function scheduleCallInterview() {
    if (!selectedCode || loadingAction) return
    if (!scheduledFor) {
      setActionError('Please select an interview date and time (IST) before scheduling.')
      return
    }
    const isoTime = istInputToISO(scheduledFor)
    if (!isoTime) {
      setActionError('Invalid date/time. Please select a valid IST date and time.')
      return
    }
    const targetDate = new Date(isoTime)
    const now = new Date()
    if (targetDate <= now) {
      setActionError('Cannot schedule an interview for a past date or time. Please select a future IST time.')
      return
    }
    setActionMessage('')
    setActionError('')
    setLoadingAction(true)
    try {
      const res = await assessmentApi.adminScheduleCall(selectedCode, {
        thresholdPercentage: PASS_THRESHOLD,
        delaySeconds: 60,
        scheduledFor: isoTime,
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

  async function saveReviewUpdate() {
    if (!selectedCode || loadingAction) return
    setActionMessage('')
    setActionError('')
    setLoadingAction(true)
    try {
      const res = await assessmentApi.adminUpdateReview(selectedCode, {
        stage: reviewStage || null,
        recruiter_notes: reviewNotes.trim() || null,
        manual_assessment_score: manualAssessmentScore === '' ? null : Number(manualAssessmentScore),
        append_history_note: reviewNotes.trim() || null,
      })
      setActionMessage(res?.message || 'Assessment review updated.')
      await loadDetail(selectedCode)
      await loadList()
    } catch (err) {
      setActionError(err?.message || 'Failed to update review')
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
    if (!selectedCode) {
      setDetail(null)
      return
    }
    setDetail((prev) => {
      if (!prev) return prev
      return String(prev.session_code || '').trim() === String(selectedCode || '').trim() ? prev : null
    })
    loadDetail(selectedCode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode])

  useEffect(() => {
    selectedCodeRef.current = selectedCode
  }, [selectedCode])

  useEffect(() => {
    if (!token) return
    const streamUrl = assessmentApi.adminRealtimeStreamUrl({
      token,
      eventTypes: ['call_status_updated', 'exam_status_updated', 'exam_email_result_updated'],
    })
    if (!streamUrl) return

    const stream = new EventSource(streamUrl)
    const scheduleSilentRefresh = () => {
      if (realtimeRefreshTimerRef.current) return
      realtimeRefreshTimerRef.current = setTimeout(() => {
        realtimeRefreshTimerRef.current = null
        void loadList({ silent: true })
        const activeCode = selectedCodeRef.current
        if (activeCode) {
          void loadDetail(activeCode, { silent: true })
        }
      }, 500)
    }

    const onRealtimeEvent = (event, label) => {
      let payload = {}
      try {
        payload = JSON.parse(event?.data || '{}')
      } catch {
        payload = {}
      }
      const code = String(payload?.session_code || '').trim()
      const nextCallStatus = payload?.call_status
      const nextStatus = payload?.status

      if (code) {
        setSessions((prev) => (prev || []).map((row) => {
          if (String(row?.session_code || '') !== code) return row
          return {
            ...row,
            ...(nextStatus ? { status: nextStatus } : null),
            ...(typeof payload?.percentage === 'number' ? { percentage: payload.percentage } : null),
            ...(typeof payload?.score === 'number' ? { score: payload.score } : null),
            ...(typeof payload?.passed === 'boolean' ? { passed: payload.passed } : null),
            ...(nextCallStatus ? { call_status: nextCallStatus } : null),
          }
        }))
      }

      if (code && String(selectedCodeRef.current || '') === code) {
        setDetail((prev) => {
          if (!prev || String(prev.session_code || '').trim() !== code) return prev
          return {
            ...prev,
            ...(nextStatus ? { status: nextStatus } : null),
            ...(typeof payload?.percentage === 'number' ? { percentage: payload.percentage } : null),
            ...(typeof payload?.score === 'number' ? { score: payload.score } : null),
            ...(typeof payload?.total === 'number' ? { total: payload.total } : null),
            ...(typeof payload?.passed === 'boolean' ? { passed: payload.passed } : null),
            ...(nextCallStatus ? { call_status: nextCallStatus } : null),
            ...(('email_sent' in payload) ? { email_sent: payload.email_sent } : null),
          }
        })
      }

      setLiveNotice(label)
      setLastLiveUpdateAt(new Date().toISOString())
      scheduleSilentRefresh()
    }

    stream.addEventListener('open', () => setLiveState('live'))
    stream.addEventListener('call_status_updated', (event) => onRealtimeEvent(event, 'Call status updated live'))
    stream.addEventListener('exam_status_updated', (event) => onRealtimeEvent(event, 'Assessment status updated live'))
    stream.addEventListener('exam_email_result_updated', (event) => onRealtimeEvent(event, 'Result email status updated live'))
    stream.onerror = () => setLiveState('reconnecting')

    return () => {
      stream.close()
      if (realtimeRefreshTimerRef.current) {
        clearTimeout(realtimeRefreshTimerRef.current)
        realtimeRefreshTimerRef.current = null
      }
      setLiveState('offline')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    setScheduledFor(detailView?.interview_scheduled_for ? utcToISTInput(detailView.interview_scheduled_for) : nowISTPlus(60))
    setReviewStage(detailView?.pipeline_stage || (detailView?.passed ? 'assessment_passed' : 'assessment_failed'))
    setReviewNotes(detailView?.recruiter_notes || '')
    setManualAssessmentScore(detailView?.manual_assessment_score != null ? String(detailView.manual_assessment_score) : '')
  }, [detailView])

  useEffect(() => {
    recordingAudioByKeyRef.current = recordingAudioByKey || {}
  }, [recordingAudioByKey])

  useEffect(() => {
    return () => {
      const current = recordingAudioByKeyRef.current || {}
      for (const url of Object.values(current)) {
        if (url) URL.revokeObjectURL(url)
      }
    }
  }, [])

  useEffect(() => {
    setRecordingLoadingByKey({})
    setRecordingErrorByKey({})
    setRecordingAudioByKey((prev) => {
      const current = prev || {}
      for (const url of Object.values(current)) {
        if (url) URL.revokeObjectURL(url)
      }
      return {}
    })
  }, [detailView?.session_code])

  return (
    <main className="main">
      <div className="page">
        <div className="page-header-row">
          <div>
            <p className="eyebrow">Admin Panel</p>
            <h1 className="page-title">Assessment Details</h1>
            <p className="page-subtitle">Review candidate assessment results, proctoring insights and AI conclusions.</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            {liveNotice && <span className="muted" style={{ fontSize: '0.75rem' }}>{liveNotice}</span>}
            <span className="live-indicator">
              <span className="live-dot" style={{ background: liveState === 'live' ? undefined : '#f59e0b' }} />
              {liveState === 'live' ? 'Live' : liveState} {lastLiveUpdateAt ? `· ${formatDate(lastLiveUpdateAt)}` : ''}
            </span>
          </div>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Candidate Assessments</div>
              <div className="card-subtitle">{filteredSessions.length} of {sessions.length} candidates</div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={loadList} disabled={loadingList}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              {loadingList ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          <div className="search-bar">
            <span className="search-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </span>
            <input className="input" placeholder="Search by name, email, code, or status..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
            <select className="input" style={{ maxWidth: 200, fontSize: '0.82rem' }} value={filterJobRole} onChange={(e) => setFilterJobRole(e.target.value)}>
              <option value="all">All Job Roles</option>
              {allJobRoles.map((j) => {
                const count = sessions.filter((s) => s.job_title === j).length
                return <option key={j} value={j}>{j} ({count})</option>
              })}
            </select>
            <select className="input" style={{ maxWidth: 180, fontSize: '0.82rem' }} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="all">All Exams</option>
              <option value="sent">Exam Sent / In Progress</option>
              <option value="done">Exam Completed</option>
            </select>
            <select className="input" style={{ maxWidth: 180, fontSize: '0.82rem' }} value={filterResult} onChange={(e) => setFilterResult(e.target.value)}>
              <option value="all">All Results</option>
              <option value="passed">Passed</option>
              <option value="not_passed">Not Passed</option>
              <option value="rejected">Rejected</option>
            </select>
            <select className="input" style={{ maxWidth: 210, fontSize: '0.82rem' }} value={filterInterview} onChange={(e) => setFilterInterview(e.target.value)}>
              <option value="all">All Interview Statuses</option>
              <option value="scheduled">Interview Scheduled</option>
              <option value="in_progress">Interview In Progress</option>
              <option value="completed">Interview Completed</option>
              <option value="failed">Interview Failed</option>
              <option value="not_scheduled">Not Scheduled</option>
            </select>
          </div>

          {listError ? <div className="alert alert-danger">{listError}</div> : null}
          {listMessage ? <div className="alert alert-success">{listMessage}</div> : null}

          {filteredSessions.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">{search ? 'No matching candidates' : 'No assessments found'}</div>
              <div className="empty-state-desc">{search ? 'Try a different search term.' : 'Assessment results will appear here after candidates take exams.'}</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table" aria-label="Assessment sessions table" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
                <thead>
                  <tr style={{ background: '#f1f5f9' }}>
                    <th style={{ background: '#1e293b', color: '#f8fafc', fontWeight: 600, fontSize: '0.78rem', letterSpacing: '0.05em', textTransform: 'uppercase', padding: '10px 14px', borderBottom: '2px solid #334155' }}>Candidate</th>
                    <th style={{ background: '#1e293b', color: '#f8fafc', fontWeight: 600, fontSize: '0.78rem', letterSpacing: '0.05em', textTransform: 'uppercase', padding: '10px 14px', borderBottom: '2px solid #334155' }}>Job Role</th>
                    <th style={{ background: '#1e293b', color: '#f8fafc', fontWeight: 600, fontSize: '0.78rem', letterSpacing: '0.05em', textTransform: 'uppercase', padding: '10px 14px', borderBottom: '2px solid #334155' }}>Score</th>
                    <th style={{ background: '#1e293b', color: '#f8fafc', fontWeight: 600, fontSize: '0.78rem', letterSpacing: '0.05em', textTransform: 'uppercase', padding: '10px 14px', borderBottom: '2px solid #334155' }}>Result</th>
                    <th style={{ background: '#1e293b', color: '#f8fafc', fontWeight: 600, fontSize: '0.78rem', letterSpacing: '0.05em', textTransform: 'uppercase', padding: '10px 14px', borderBottom: '2px solid #334155' }}>Interview</th>
                    <th style={{ background: '#1e293b', color: '#f8fafc', fontWeight: 600, fontSize: '0.78rem', letterSpacing: '0.05em', textTransform: 'uppercase', padding: '10px 14px', borderBottom: '2px solid #334155', textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSessions.map((row, idx) => {
                    const scorePct = (() => {
                      if (row.percentage != null) return Number(row.percentage)
                      if (row.score != null && row.total != null && Number(row.total) > 0) return (Number(row.score) / Number(row.total)) * 100
                      return null
                    })()
                    const barColor = scorePct == null ? '#94a3b8' : scorePct >= 70 ? '#22c55e' : scorePct >= 50 ? '#f59e0b' : '#ef4444'
                    const resultLabel = getResultLabel(row)
                    const resultStyle = getResultStyle(row)
                    const callStyle = getCallStatusStyle(row.call_status)
                    const callLabel = getCallStatusLabel(row.call_status)
                    const isActive = String(row.session_code || '').trim() === String(selectedCode || '').trim()
                    const rowBg = isActive ? '#eff6ff' : idx % 2 === 0 ? '#ffffff' : '#f8fafc'
                    const initials = (row.candidate_name || '?').trim()[0].toUpperCase()
                    return (
                      <tr
                        key={row.session_code}
                        className={`assessment-row${isActive ? ' is-active' : ''}`}
                        onClick={() => openDetail(row.session_code)}
                        style={{ cursor: 'pointer', background: rowBg, borderBottom: '1px solid #e2e8f0', transition: 'background 0.15s' }}
                      >
                        <td style={{ padding: '10px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                            <div className="table-avatar" style={{ flexShrink: 0, background: isActive ? '#2563eb' : '#334155', color: '#fff', fontWeight: 700 }}>{initials}</div>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#0f172a' }}>{row.candidate_name || '--'}</div>
                              <div style={{ fontSize: '0.78rem', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.candidate_email}</div>
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <span style={{ fontSize: '0.82rem', color: '#475569', fontWeight: 500 }}>{row.job_title || '--'}</span>
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          {scorePct != null ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 90 }}>
                              <div style={{ flex: 1, height: 6, background: '#e2e8f0', borderRadius: 99, overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${Math.min(100,scorePct)}%`, background: barColor, borderRadius: 99 }} />
                              </div>
                              <span style={{ fontWeight: 700, fontSize: '0.83rem', color: barColor, minWidth: 36 }}>{Math.round(scorePct)}%</span>
                            </div>
                          ) : (
                            <span style={{ color: '#94a3b8', fontSize: '0.82rem' }}>{fmtScore(row)}</span>
                          )}
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 99, fontSize: '0.78rem', fontWeight: 600, background: resultStyle.bg, color: resultStyle.color, border: `1px solid ${resultStyle.border}` }}>
                            {resultLabel}
                          </span>
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 99, fontSize: '0.78rem', fontWeight: 600, background: callStyle.bg, color: callStyle.color, border: `1px solid ${callStyle.border}` }}>
                              {callLabel}
                            </span>
                            {row.call_attempt_count > 0 && (
                              <span style={{ fontSize: '0.72rem', color: row.call_attempt_count >= 3 ? '#dc2626' : '#64748b' }}>
                                {row.call_attempt_count}/3 attempt{row.call_attempt_count !== 1 ? 's' : ''}{row.call_attempt_count >= 3 ? ' — max reached' : ''}
                              </span>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            title="Delete assessment session"
                            onClick={(e) => { e.stopPropagation(); void deleteAssessmentSession(row.session_code) }}
                            disabled={deletingSessionCode === String(row.session_code || '').trim()}
                            style={{ color: '#b91c1c', borderColor: '#fca5a5' }}
                          >
                            {deletingSessionCode === String(row.session_code || '').trim() ? 'Deleting…' : <IconTrash size={14} />}
                          </button>
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
          <div className="card modal-card" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflowX: 'hidden' }}>
            {/* Modal Header */}
            <div className="ad-modal-hero">
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 className="ad-modal-name">{detailView?.candidate_name || 'Candidate'}</h2>
                <p className="ad-modal-session">Session: {selectedCode || '--'}</p>
                {detailView && (
                  <div className="ad-modal-tags">
                    <span className="cand-tag">{detail.assessment_type || 'onscreen'}</span>
                    <span className="cand-tag">{stageLabel(detail.pipeline_stage) || 'Untracked'}</span>
                    <span className="cand-tag">{detail.job_title || 'No Job'}</span>
                    <span className="cand-tag">Call: {(detail.call_status || 'not_scheduled').replace(/_/g, ' ')}</span>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
                {detailView && <span className="badge-soft" style={{ fontSize: '0.78rem' }}>{selectedSummary}</span>}
                <button type="button" className="btn btn-reject btn-sm" onClick={rejectCandidate} disabled={loadingAction || !detailView}>Reject</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={closeModal}>Close</button>
              </div>
            </div>

            <div style={{ padding: '1.25rem 1.5rem', overflowX: 'hidden' }}>

            {actionError ? <div className="alert alert-danger">{actionError}</div> : null}
            {actionMessage ? <div className="alert alert-success">{actionMessage}</div> : null}

            {loadingDetail ? (
              <div style={{ padding: '2rem 0', textAlign: 'center' }}>
                <span className="loading-spinner" style={{ width: 24, height: 24, borderWidth: 3 }} />
                <p className="muted" style={{ marginTop: '0.5rem' }}>Loading details…</p>
              </div>
            ) : null}

            {!loadingDetail && !detailView ? <div className="muted" style={{ textAlign: 'center', padding: '2rem 0' }}>No session selected.</div> : null}

            {detailView ? (
              <>
                {/* Info chips row */}
                <div className="chip-row" style={{ marginTop: 0 }}>
                  <span className="chip">Started: {formatDate(detail.started_at)}</span>
                  <span className="chip">Submitted: {formatDate(detail.submitted_at)}</span>
                </div>

                {(detail.government_id_image_base64 || detail.live_selfie_image_base64) ? (
                  <div className="card" style={{ padding: 14, marginTop: 14, background: 'var(--bg-soft)' }}>
                    <div className="card-title">Identity Artifacts</div>
                    <div className="chip-row" style={{ marginTop: 8 }}>
                      <span className="chip">Status: {detail.identity_status || 'pending'}</span>
                      <span className="chip">Submitted: {formatDate(detail.identity_submitted_at)}</span>
                    </div>
                    <div style={{ marginTop: 10, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      {detail.government_id_image_base64 ? (
                        <div>
                          <div className="muted" style={{ marginBottom: 6 }}>Government ID</div>
                          <img
                            src={detail.government_id_image_base64}
                            alt="Government ID"
                            style={{ width: 220, maxWidth: '100%', borderRadius: 10, border: '1px solid var(--border)' }}
                          />
                        </div>
                      ) : null}
                      {detail.live_selfie_image_base64 ? (
                        <div>
                          <div className="muted" style={{ marginBottom: 6 }}>Live selfie</div>
                          <img
                            src={detail.live_selfie_image_base64}
                            alt="Live selfie"
                            style={{ width: 220, maxWidth: '100%', borderRadius: 10, border: '1px solid var(--border)' }}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {Number(detail.percentage || 0) >= PASS_THRESHOLD && detail.status !== 'rejected' && detail.pipeline_stage !== 'rejected' ? (
                  <>
                    {(detail.call_attempt_count || 0) >= 3 ? (
                      <div className="alert alert-danger" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong>Max call attempts reached.</strong> This candidate did not pick up after 3 attempts. No further calls can be scheduled.
                      </div>
                    ) : (
                      <div className="actions-row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                        {/* Phone number status */}
                        {detail.candidate_phone ? (
                          <span className="chip" style={{ background: '#f0fdf4', border: '1px solid #86efac', color: '#15803d', fontSize: '0.78rem' }}>
                            📞 {detail.candidate_phone}
                          </span>
                        ) : (
                          <div className="alert alert-danger" style={{ width: '100%', padding: '8px 12px', fontSize: '0.82rem', marginBottom: 4 }}>
                            ⚠️ <strong>No phone number on file.</strong> The call will fail unless the candidate's profile has a phone number. Ask them to update their profile or add it manually in the Candidates page.
                          </div>
                        )}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <label className="label" style={{ fontSize: '0.78rem', marginBottom: 0 }}>
                            Interview Time (IST)
                            {(detail.call_attempt_count || 0) > 0 && (
                              <span style={{ marginLeft: 8, fontSize: '0.72rem', color: '#c2410c', fontWeight: 600 }}>
                                Attempt {(detail.call_attempt_count || 0) + 1} of 3
                              </span>
                            )}
                          </label>
                          <input
                            className="input"
                            type="datetime-local"
                            value={scheduledFor}
                            min={nowISTMin()}
                            onChange={(e) => {
                              const v = e.target.value
                              const iso = istInputToISO(v)
                              if (iso && new Date(iso) <= new Date()) {
                                setActionError('Cannot schedule for a past date or time. Please pick a future IST time.')
                              } else {
                                setActionError('')
                              }
                              setScheduledFor(v)
                            }}
                            style={{ maxWidth: 240 }}
                            required
                          />
                        </div>
                        <button type="button" className="btn btn-primary" onClick={scheduleCallInterview} disabled={loadingAction || !scheduledFor}>
                          {loadingAction ? 'Scheduling...' : 'Schedule Call Interview'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={callNow}
                          disabled={callNowLoading || !detail?.candidate_phone}
                          title={!detail?.candidate_phone ? 'No phone number on file' : 'Place the call immediately right now'}
                          style={{ background: '#f0fdf4', color: '#15803d', borderColor: '#86efac' }}
                        >
                          {callNowLoading ? 'Calling...' : '📞 Call Now'}
                        </button>
                        <span className="muted">Pick a future IST time — the call will be placed at that exact time.</span>
                      </div>
                    )}
                  </>
                ) : null}

                {detail.call_status === 'completed' && detail.pipeline_stage !== 'rejected' && detail.pipeline_stage !== 'hired' ? (
                  <div className="card" style={{ padding: 14, marginTop: 14, background: '#f0fdf4', border: '1px solid #86efac' }}>
                    <div className="card-title" style={{ color: '#15803d' }}>Interview Completed — Decision</div>
                    <p className="muted" style={{ marginTop: 4 }}>The call interview has finished. Select the candidate to move them forward, or reject them.</p>
                    <div className="actions-row" style={{ marginTop: 10 }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={loadingAction}
                        onClick={async () => {
                          if (!window.confirm('Mark this candidate as Selected / Hired?')) return
                          setActionMessage('')
                          setActionError('')
                          setLoadingAction(true)
                          try {
                            const res = await assessmentApi.adminUpdateReview(selectedCode, {
                              stage: 'hired',
                              recruiter_notes: 'Selected after call interview.',
                              manual_assessment_score: null,
                              append_history_note: 'Candidate selected after call interview.',
                            })
                            setActionMessage(res?.message || 'Candidate marked as selected.')
                            await loadDetail(selectedCode)
                            await loadList()
                          } catch (err) {
                            setActionError(err?.message || 'Failed to select candidate')
                          } finally {
                            setLoadingAction(false)
                          }
                        }}
                        style={{ background: '#16a34a', borderColor: '#15803d' }}
                      >
                        ✓ Select Candidate
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={loadingAction}
                        onClick={async () => {
                          if (!window.confirm('Reject this candidate after their interview?')) return
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
                        }}
                        style={{ background: '#fef2f2', color: '#dc2626', borderColor: '#fca5a5' }}
                      >
                        ✗ Reject Candidate
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="card" style={{ padding: 14, marginTop: 14, background: 'var(--bg-soft)' }}>
                  <div className="card-title">Recruiter Review</div>
                  <div className="detail-grid" style={{ marginTop: 12 }}>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label className="label">Pipeline stage</label>
                      <select className="input" value={reviewStage} onChange={(e) => setReviewStage(e.target.value)}>
                        {PIPELINE_STAGES.map((stage) => (
                          <option key={stage} value={stage}>{stageLabel(stage)}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label className="label">Manual assessment score</label>
                      <input className="input" type="number" min="0" max="100" value={manualAssessmentScore} onChange={(e) => setManualAssessmentScore(e.target.value)} placeholder="Optional override" />
                    </div>
                    <div className="field" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
                      <label className="label">Recruiter notes</label>
                      <textarea className="input" rows={3} value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} placeholder="Add your notes, concerns, or follow-up context" />
                    </div>
                  </div>
                  <div className="actions-row" style={{ marginTop: 12 }}>
                    <button type="button" className="btn btn-primary" onClick={saveReviewUpdate} disabled={loadingAction}>
                      {loadingAction ? 'Saving...' : 'Save Review'}
                    </button>
                    {detail.interview_scheduled_for ? <span className="muted">Interview scheduled for {formatDate(detail.interview_scheduled_for)}</span> : null}
                  </div>
                </div>

                <div className="card ai-panel" style={{ padding: 14, marginTop: 14 }}>
                  <div className="card-title">AI Conclusion</div>
                  <div className="muted" style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    Recommendation:{' '}
                    <span className={`pill pill-${String(detail.ai_summary?.recommendation || 'neutral').toLowerCase()}`}>
                      {detail.ai_summary?.recommendation || '--'}
                    </span>
                    {detail.ai_summary?.risk_level ? <span className="pill pill-risk">Risk: {detail.ai_summary.risk_level}</span> : null}
                  </div>
                  <div style={{ marginTop: 8 }}>{detail.ai_summary?.conclusion || '--'}</div>
                  {Array.isArray(detail.ai_summary?.rationale) ? (
                    <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
                      {detail.ai_summary.rationale.slice(0, 6).map((item, idx) => (
                        <div key={`${shortJson(item)}-${idx}`} className="muted">- {String(item)}</div>
                      ))}
                    </div>
                  ) : null}
                  {detail.ai_summary?.model ? (
                    <div className="muted" style={{ marginTop: 10 }}>
                      Analysis: {detail.ai_summary.model.includes('rule_based') ? 'Automated rule-based assessment' : `AI-powered (${detail.ai_summary.model})`}
                    </div>
                  ) : null}
                </div>

                <div style={{ marginTop: 14 }}>
                  <div className="card" style={{ padding: 14, background: 'var(--bg-soft)' }}>
                    <div className="card-title">Flagged Activity</div>
                    <div className="muted" style={{ marginTop: 6 }}>Policy violations and suspicious behavior detected.</div>
                    <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                      {(detail.red_signals || []).length === 0 ? (
                        <div className="muted">No suspicious activity detected.</div>
                      ) : (
                        (detail.red_signals || []).map((s, idx) => {
                          const st = severityTag(s.severity)
                          return (
                            <div key={`${s.event_type}-${idx}`} className="signal-card signal-red" style={{ padding: '10px 12px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{proctorLabel(s.event_type) || formatSignal(s)}</div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span className="badge-soft badge-red" style={{ fontSize: '0.72rem' }}>{s.count || 1}x</span>
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
                    <span className="chip" style={{ background: '#f0fdf4', borderColor: '#86efac', color: '#166534' }}>Low: {severity.low || 0}</span>
                    <span className="chip" style={{ background: '#fffbeb', borderColor: '#fcd34d', color: '#92400e' }}>Medium: {severity.medium || 0}</span>
                    <span className="chip" style={{ background: '#fef2f2', borderColor: '#fca5a5', color: '#991b1b' }}>High: {severity.high || 0}</span>
                  </div>
                </div>

                <div className="card" style={{ padding: 14, background: 'var(--bg-soft)', marginTop: 14 }}>
                  <div className="card-title">Exam Snapshots</div>
                  <div className="muted" style={{ marginTop: 6 }}>Latest webcam snapshots captured during the exam.</div>
                  {screenshotFrames.length === 0 ? (
                    <div className="muted" style={{ marginTop: 10 }}>No snapshots captured yet.</div>
                  ) : (
                    <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
                      {screenshotFrames.map((shot) => (
                        <div key={shot.key} className="signal-card" style={{ padding: 8 }}>
                          <img
                            src={shot.imageBase64}
                            alt="Exam snapshot"
                            style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)' }}
                          />
                          <div className="muted" style={{ marginTop: 6, fontSize: '0.74rem' }}>{formatDate(shot.createdAt)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── Call Recordings (DB-backed) ── */}
                <div className="card" style={{ padding: 14, background: 'var(--bg-soft)', marginTop: 14 }}>
                  <div className="card-header" style={{ marginBottom: 0 }}>
                    <div>
                      <div className="card-title">Call Recordings</div>
                      <div className="muted" style={{ marginTop: 4 }}>Full audio recordings of the AI voice interview stored in database.</div>
                    </div>
                  </div>
                  {dbRecordingsLoading ? (
                    <div className="muted" style={{ marginTop: 10 }}>Loading recordings…</div>
                  ) : dbRecordings.length === 0 ? (
                    <div className="muted" style={{ marginTop: 10 }}>No recordings stored yet. Recordings are saved automatically after the interview call completes.</div>
                  ) : (
                    <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                      {dbRecordings.map((rec) => {
                        const key = `db-${rec.id}`
                        const audioUrl = recordingAudioByKey[key]
                        const isLoading = Boolean(recordingLoadingByKey[key])
                        const err = recordingErrorByKey[key]
                        const duration = rec.duration_seconds != null ? `${Math.floor(rec.duration_seconds / 60)}:${String(rec.duration_seconds % 60).padStart(2, '0')}` : null
                        return (
                          <div key={rec.id} className="ad-recording-bar">
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={() => playDbRecording(rec)}
                              disabled={isLoading || !!audioUrl}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
                            >
                              {isLoading ? (
                                <><span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Loading…</>
                              ) : (
                                <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg> {audioUrl ? 'Playing' : 'Play'}</>
                              )}
                            </button>
                            {audioUrl && <audio controls src={audioUrl} style={{ flex: 1, minWidth: 180 }} />}
                            {duration && !audioUrl && <span className="muted" style={{ fontSize: '0.78rem' }}>Duration: {duration}</span>}
                            {rec.created_at && !audioUrl && <span className="muted" style={{ fontSize: '0.78rem' }}>{formatDate(rec.created_at)}</span>}
                            {err && <span style={{ color: '#b91c1c', fontSize: '0.78rem' }}>{err}</span>}
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => deleteDbRecording(rec)}
                              title="Delete recording"
                              style={{ marginLeft: 'auto', color: '#b91c1c', flexShrink: 0 }}
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* ── Interview Transcript ── */}
                <div className="card" style={{ padding: 14, background: 'var(--bg-soft)', marginTop: 14 }}>
                  <div className="card-header" style={{ marginBottom: 0 }}>
                    <div>
                      <div className="card-title">Interview Transcript</div>
                      <div className="muted" style={{ marginTop: 4 }}>Turn-by-turn conversation between AI interviewer and candidate.</div>
                    </div>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={downloadTranscriptFile} disabled={!transcriptText}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <IconDownload size={14} />
                        <span>Download</span>
                      </span>
                    </button>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    {transcriptText ? (
                      <div className="ad-chat-transcript">
                        {transcriptText.split('\n').filter(Boolean).map((line, i) => {
                          const isInterviewer = line.includes('Interviewer')
                          const isCandidate = line.includes('Candidate')
                          const timestampMatch = line.match(/^\[([^\]]+)\]\s*/)
                          const timestamp = timestampMatch ? timestampMatch[1] : ''
                          const speakerMatch = line.match(/\]\s*(Interviewer|Candidate)\s*(?:\(Turn\s*\d+\))?:\s*/)
                          const msgBody = speakerMatch ? line.slice(line.indexOf(speakerMatch[0]) + speakerMatch[0].length) : line
                          const speaker = speakerMatch ? speakerMatch[1] : ''
                          const turnMatch = line.match(/\(Turn\s*(\d+)\)/)
                          const turn = turnMatch ? turnMatch[1] : ''
                          return (
                            <div key={i} className={`ad-chat-bubble ${isInterviewer ? 'ad-cb-interviewer' : isCandidate ? 'ad-cb-candidate' : 'ad-cb-system'}`}>
                              <div className="ad-cb-header">
                                <span className="ad-cb-speaker">{speaker === 'Interviewer' ? '🤖 Interviewer' : speaker === 'Candidate' ? '👤 Candidate' : 'System'}</span>
                                {turn && <span className="ad-cb-turn">Turn {turn}</span>}
                                {timestamp && <span className="ad-cb-time">{timestamp}</span>}
                              </div>
                              <div className="ad-cb-text">{msgBody || line}</div>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="muted">Transcript will appear here once the interview call is completed.</div>
                    )}
                  </div>
                </div>

                {/* ── AI Interview Analysis ── */}
                <div className="card" style={{ padding: 14, background: 'var(--bg-soft)', marginTop: 14 }}>
                  <div className="card-header" style={{ marginBottom: 8 }}>
                    <div>
                      <div className="card-title">AI Interview Analysis</div>
                      <div className="muted" style={{ marginTop: 4 }}>LLM-generated evaluation of the candidate's interview performance.</div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => triggerCallAnalysis(detail?.session_code)}
                      disabled={callAnalysisTriggerLoading || !transcriptText}
                      title={!transcriptText ? 'Transcript required to run analysis' : 'Re-run analysis'}
                    >
                      {callAnalysisTriggerLoading ? <span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> : '↻'} {callAnalysis ? 'Re-analyse' : 'Run Analysis'}
                    </button>
                  </div>

                  {callAnalysisLoading ? (
                    <div className="muted">Loading analysis…</div>
                  ) : callAnalysis ? (
                    <div style={{ display: 'grid', gap: 12, minWidth: 0, width: '100%' }}>
                      {/* Score row */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: 8 }}>
                        {[
                          { label: 'Overall', value: callAnalysis.overall_score },
                          { label: 'Communication', value: callAnalysis.communication_score },
                          { label: 'Technical', value: callAnalysis.technical_score },
                          { label: 'Confidence', value: callAnalysis.confidence_score },
                        ].map(({ label, value }) => (
                          <div key={label} style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', textAlign: 'center', border: '1px solid var(--border)' }}>
                            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: value >= 70 ? '#16a34a' : value >= 50 ? '#d97706' : '#dc2626' }}>
                              {value != null ? Math.round(value) : '—'}
                            </div>
                            <div className="muted" style={{ fontSize: '0.72rem', marginTop: 2 }}>{label}</div>
                          </div>
                        ))}
                      </div>

                      {/* Recommendation + Sentiment */}
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        {callAnalysis.recommendation && (
                          <span className={`badge-soft ${callAnalysis.recommendation === 'hire' ? 'badge-green' : callAnalysis.recommendation === 'reject' ? 'badge-red' : 'badge-amber'}`} style={{ fontSize: '0.8rem', padding: '3px 10px' }}>
                            {callAnalysis.recommendation === 'hire' ? '✓ Recommend Hire' : callAnalysis.recommendation === 'reject' ? '✗ Do Not Hire' : '~ Consider'}
                          </span>
                        )}
                        {callAnalysis.sentiment && (
                          <span className="badge-soft" style={{ fontSize: '0.8rem', padding: '3px 10px' }}>
                            {callAnalysis.sentiment === 'positive' ? '😊' : callAnalysis.sentiment === 'negative' ? '😟' : '😐'} {callAnalysis.sentiment}
                          </span>
                        )}
                      </div>

                      {/* Summary */}
                      {callAnalysis.summary && (
                        <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)', fontSize: '0.85rem', lineHeight: 1.6 }}>
                          {callAnalysis.summary}
                        </div>
                      )}

                      {/* Strengths + Concerns */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
                        {callAnalysis.key_strengths?.length > 0 && (
                          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 12px' }}>
                            <div style={{ fontWeight: 600, fontSize: '0.8rem', color: '#15803d', marginBottom: 6 }}>Key Strengths</div>
                            <ul style={{ margin: 0, paddingLeft: 16, fontSize: '0.82rem', display: 'grid', gap: 3 }}>
                              {callAnalysis.key_strengths.map((s, i) => <li key={i}>{s}</li>)}
                            </ul>
                          </div>
                        )}
                        {callAnalysis.concerns?.length > 0 && (
                          <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '10px 12px' }}>
                            <div style={{ fontWeight: 600, fontSize: '0.8rem', color: '#c2410c', marginBottom: 6 }}>Concerns</div>
                            <ul style={{ margin: 0, paddingLeft: 16, fontSize: '0.82rem', display: 'grid', gap: 3 }}>
                              {callAnalysis.concerns.map((c, i) => <li key={i}>{c}</li>)}
                            </ul>
                          </div>
                        )}
                      </div>

                      {/* Topics covered */}
                      {callAnalysis.topic_coverage?.length > 0 && (
                        <div>
                          <div className="muted" style={{ fontSize: '0.75rem', marginBottom: 4 }}>Topics Covered</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {callAnalysis.topic_coverage.map((t, i) => (
                              <span key={i} className="badge-soft" style={{ fontSize: '0.75rem' }}>{t}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="muted" style={{ fontSize: '0.85rem' }}>
                      {transcriptText
                        ? 'Analysis not yet generated. Click "Run Analysis" to evaluate this interview.'
                        : 'Analysis will be available once the interview transcript is ready.'}
                    </div>
                  )}
                </div>
              </>
            ) : null}
            </div>
          </div>
        </dialog>
      </div>
    </main>
  )
}

export default AssessmentDetails
