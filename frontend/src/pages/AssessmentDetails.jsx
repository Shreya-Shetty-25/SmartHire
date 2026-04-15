import { useEffect, useMemo, useRef, useState } from 'react'
import { assessmentApi } from '../assessmentApi'

const PIPELINE_STAGES = ['applied', 'shortlisted', 'assessment_sent', 'assessment_in_progress', 'assessment_passed', 'assessment_failed', 'interview_scheduled', 'interview_completed', 'rejected', 'hired']

function formatDate(value) {
  if (!value) return '--'
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
      if (Array.isArray(data) && data.length > 0 && !selectedCode) {
        setSelectedCode(data[0].session_code)
      }
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

  async function scheduleCallInterview() {
    if (!selectedCode || loadingAction) return
    setActionMessage('')
    setActionError('')
    setLoadingAction(true)
    try {
      const res = await assessmentApi.adminScheduleCall(selectedCode, {
        thresholdPercentage: PASS_THRESHOLD,
        delaySeconds: 60,
        scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
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
    setScheduledFor(detailView?.interview_scheduled_for ? new Date(detailView.interview_scheduled_for).toISOString().slice(0, 16) : '')
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
          <span className="live-indicator">
            <span className="live-dot" style={{ background: liveState === 'live' ? undefined : '#f59e0b' }} />
            {liveState === 'live' ? 'Live' : liveState} {lastLiveUpdateAt ? `· ${formatDate(lastLiveUpdateAt)}` : ''}
          </span>
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

          {listError ? <div className="alert alert-danger">{listError}</div> : null}
          {listMessage ? <div className="alert alert-success">{listMessage}</div> : null}

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
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSessions.map((row) => {
                    const scorePct = (() => {
                      if (row.percentage != null) return Number(row.percentage)
                      if (row.score != null && row.total != null && Number(row.total) > 0) return (Number(row.score) / Number(row.total)) * 100
                      return null
                    })()
                    const barColor = scorePct == null ? 'var(--text-muted)' : scorePct >= 70 ? '#22c55e' : scorePct >= 50 ? '#f59e0b' : '#ef4444'
                    const rowBg = scorePct == null ? {} : scorePct >= 70 ? { background: 'rgba(34,197,94,0.03)', borderLeft: '3px solid #22c55e' } : scorePct >= 50 ? { background: 'rgba(245,158,11,0.03)', borderLeft: '3px solid #f59e0b' } : { background: 'rgba(239,68,68,0.03)', borderLeft: '3px solid #ef4444' }
                    const initials = (row.candidate_name || '?').trim()[0].toUpperCase()
                    return (
                      <tr
                        key={row.session_code}
                        className={`assessment-row${String(row.session_code || '').trim() === String(selectedCode || '').trim() ? ' is-active' : ''}`}
                        onClick={() => openDetail(row.session_code)}
                        style={{ cursor: 'pointer', ...rowBg }}
                      >
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                            <div className="table-avatar" style={{ flexShrink: 0 }}>{initials}</div>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.candidate_name || '--'}</div>
                              <div className="muted" style={{ fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.candidate_email}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          {scorePct != null ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 80 }}>
                              <div style={{ flex: 1, height: 5, background: 'var(--bg-soft)', borderRadius: 99, overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${Math.min(100,scorePct)}%`, background: barColor, borderRadius: 99 }} />
                              </div>
                              <span style={{ fontWeight: 700, fontSize: '0.83rem', color: barColor, minWidth: 34 }}>{Math.round(scorePct)}%</span>
                            </div>
                          ) : (
                            <span className="muted">{fmtScore(row)}</span>
                          )}
                        </td>
                        <td>
                          <span className={`badge-soft ${row.status === 'submitted' && row.passed ? 'badge-green' : row.status === 'submitted' ? 'badge-red' : ''}`}>
                            {row.status || '--'}
                          </span>
                        </td>
                        <td><span className="chip">{row.assessment_type || 'onscreen'}</span></td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            title="Delete assessment session"
                            aria-label={`Delete assessment session ${row.session_code || ''}`}
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
          <div className="card modal-card">
            <div className="card-header">
              <div>
                <div className="card-title">Detailed Analysis</div>
                <div className="card-subtitle">{selectedCode || '--'}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {detailView ? <span className="badge-soft">{selectedSummary}</span> : null}
                <button type="button" className="btn btn-reject" onClick={rejectCandidate} disabled={loadingAction || !detailView}>
                  {loadingAction ? 'Please wait...' : 'Reject Candidate'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={closeModal}>Close</button>
              </div>
            </div>

            {error ? (
              <div className="muted">{error}</div>
            ) : null}

            {actionError ? <div className="alert alert-danger">{actionError}</div> : null}
            {actionMessage ? <div className="alert alert-success">{actionMessage}</div> : null}

            {loadingDetail ? <div className="muted">Loading details...</div> : null}

            {!loadingDetail && !detailView ? <div className="muted">No session selected.</div> : null}

            {detailView ? (
              <>
                <div className="chip-row" style={{ marginTop: 0 }}>
                  <span className="chip">Assessment type: {detail.assessment_type}</span>
                  <span className="chip">Pipeline: {detail.pipeline_stage || 'untracked'}</span>
                  <span className="chip">Job: {detail.job_title || '--'}</span>
                  <span className="chip">Started: {formatDate(detail.started_at)}</span>
                  <span className="chip">Submitted: {formatDate(detail.submitted_at)}</span>
                  <span className="chip">Call status: {detail.call_status || 'not_scheduled'}</span>
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

                {Number(detail.percentage || 0) >= PASS_THRESHOLD && detail.status !== 'rejected' ? (
                  <div className="actions-row" style={{ marginTop: 12 }}>
                    <input
                      className="input"
                      type="datetime-local"
                      value={scheduledFor}
                      onChange={(e) => setScheduledFor(e.target.value)}
                      style={{ maxWidth: 240 }}
                    />
                    <button type="button" className="btn btn-primary" onClick={scheduleCallInterview} disabled={loadingAction}>
                      {loadingAction ? 'Scheduling...' : 'Schedule Call Interview'}
                    </button>
                    <span className="muted">Set a specific interview time or leave it blank for a near-immediate call.</span>
                  </div>
                ) : null}

                <div className="card" style={{ padding: 14, marginTop: 14, background: 'var(--bg-soft)' }}>
                  <div className="card-title">Recruiter Review</div>
                  <div className="detail-grid" style={{ marginTop: 12 }}>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label className="label">Pipeline stage</label>
                      <select className="input" value={reviewStage} onChange={(e) => setReviewStage(e.target.value)}>
                        {PIPELINE_STAGES.map((stage) => (
                          <option key={stage} value={stage}>{stage}</option>
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

                <div className="dashboard-grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 14 }}>
                  <div className="card" style={{ padding: 14, background: 'var(--bg-soft)' }}>
                    <div className="card-title">Compliant Activity</div>
                    <div className="muted" style={{ marginTop: 6 }}>Normal exam behavior and completed checks.</div>
                    <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                      {(detail.green_signals || []).length === 0 ? (
                        <div className="muted">No activity recorded yet.</div>
                      ) : (
                        (detail.green_signals || []).map((s, idx) => {
                          const st = severityTag(s.severity)
                          return (
                            <div key={`${s.event_type}-${idx}`} className="signal-card signal-green" style={{ padding: '10px 12px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{proctorLabel(s.event_type) || formatSignal(s)}</div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {s.count > 1 ? <span className="badge-soft" style={{ fontSize: '0.72rem' }}>{s.count}x</span> : null}
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

                <div className="card" style={{ padding: 14, background: 'var(--bg-soft)', marginTop: 14 }}>
                  <div className="card-header" style={{ marginBottom: 0 }}>
                    <div>
                      <div className="card-title">Call Interview Logs</div>
                      <div className="muted" style={{ marginTop: 6 }}>Readable lifecycle events, playback, and transcript.</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setShowTranscriptPanel((prev) => !prev)}
                        disabled={!transcriptText}
                        title={showTranscriptPanel ? 'Hide transcript' : 'Show transcript'}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <IconTranscript size={14} />
                          <span>{showTranscriptPanel ? 'Hide Transcript' : 'Show Transcript'}</span>
                        </span>
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={downloadTranscriptFile} disabled={!transcriptText}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <IconDownload size={14} />
                          <span>Download Transcript</span>
                        </span>
                      </button>
                    </div>
                  </div>

                  {showTranscriptPanel ? (
                    <div style={{ marginTop: 10 }}>
                      {transcriptText ? (
                        <div className="signal-card" style={{ padding: 10, background: '#ffffff' }}>
                          {latestRecordingTranscript ? (
                            <div className="muted" style={{ marginBottom: 8, fontSize: '0.78rem' }}>
                              Provider: {latestRecordingTranscript.provider}
                              {latestRecordingTranscript.languageCode ? ` - Language: ${latestRecordingTranscript.languageCode}` : ''}
                              {latestRecordingTranscript.wordCount ? ` - Words: ${latestRecordingTranscript.wordCount}` : ''}
                            </div>
                          ) : null}
                          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '0.79rem', lineHeight: 1.45 }}>{transcriptText}</pre>
                        </div>
                      ) : (
                        <div className="muted">Transcript will appear here once call audio is available.</div>
                      )}
                    </div>
                  ) : null}

                  <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                    {callLogs.length === 0 ? (
                      <div className="muted">No call interview logs yet.</div>
                    ) : (
                      [...callLogs].reverse().map((item, idx) => {
                        const p = item?.payload || {}
                        const recordingFileName = String(p.recording_file_name || '').trim()
                        const recordingFetchUrl = String(p.recording_fetch_url || '').trim()
                        const directRecordingUrl = String(p.recording_url || '').trim()
                        const recordingKey = recordingFileName || String(p.recording_sid || idx)
                        const recordingAudio = recordingAudioByKey[recordingKey]
                        const recordingLoading = Boolean(recordingLoadingByKey[recordingKey])
                        const recordingError = recordingErrorByKey[recordingKey]
                        const canPlayRecording = Boolean(recordingFileName || recordingFetchUrl || directRecordingUrl)
                        const summary = callLogSummary(item)
                        const typeLabel = proctorLabel(String(item?.type || '').trim())
                        const turnValue = p.hr_turn || p.turn
                        return (
                          <div key={`${String(item?.type || 'log')}-${idx}`} className="signal-card signal-call">
                            <div style={{ fontWeight: 650 }}>{typeLabel}</div>
                            <div className="muted">
                              {item?.timestamp ? formatDate(item.timestamp) : '--'} - {item?.source || 'unknown'}{turnValue ? ` - Turn ${turnValue}` : ''}
                            </div>
                            {summary ? <div className="muted" style={{ marginTop: 6 }}>{summary}</div> : null}

                            {canPlayRecording ? (
                              <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => playRecording(item, idx)}
                                    disabled={recordingLoading}
                                  >
                                    {recordingLoading ? 'Loading recording...' : 'Play Recording'}
                                  </button>
                                  {recordingFileName ? <span className="muted">File: {recordingFileName}</span> : null}
                                  {!recordingFileName && directRecordingUrl ? <span className="muted">Source: Twilio recording URL</span> : null}
                                </div>
                                {recordingError ? <div className="muted" style={{ color: '#b91c1c' }}>{recordingError}</div> : null}
                                {recordingAudio ? <audio controls src={recordingAudio} style={{ width: '100%' }} /> : null}
                              </div>
                            ) : null}
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
