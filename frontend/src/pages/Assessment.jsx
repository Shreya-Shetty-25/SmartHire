import { useCallback, useEffect, useRef, useState } from 'react'
import { assessmentApi } from '../assessmentApi'

/* ─── helpers ─── */
function fmt(totalSeconds) {
  const s = Math.max(0, Number(totalSeconds || 0))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

const IDENTITY_FLAG_LABELS = {
  government_id_not_uploaded: 'Government ID not uploaded',
  selfie_not_uploaded: 'Live selfie not captured',
  unsupported_government_id_type: 'Use Aadhaar, PAN, Driving License, or Voter ID',
  invalid_image_payload: 'Invalid image payload',
  uploaded_image_not_government_id_like: 'ID image does not look like a government ID',
  id_face_not_detected: 'Face not found in ID image',
  multiple_faces_in_id: 'Multiple faces found in ID image',
  selfie_face_not_detected: 'Face not found in selfie',
  multiple_faces_in_selfie: 'Multiple faces found in selfie',
  id_image_appears_like_selfie: 'Uploaded ID appears to be a selfie',
  low_face_quality: 'Face image quality is too low',
  id_image_resolution_too_low: 'ID image resolution is too low',
  selfie_image_resolution_too_low: 'Selfie resolution is too low',
  id_face_too_small: 'ID face region is too small',
  selfie_face_too_small: 'Selfie face region is too small',
  face_signature_generation_failed: 'Unable to extract face signature',
  face_id_mismatch: 'Selfie did not match ID face',
}
const GOVERNMENT_ID_TYPES = [
  { value: 'aadhaar', label: 'Aadhaar Card' },
  { value: 'pan', label: 'PAN Card' },
  { value: 'driving_license', label: 'Driving License' },
  { value: 'voter_id', label: 'Voter ID' },
]

function readIntervalMs(envName, fallbackMs) {
  const raw = Number(import.meta.env?.[envName])
  if (!Number.isFinite(raw)) return fallbackMs
  const rounded = Math.round(raw)
  return Math.min(60000, Math.max(2000, rounded))
}

const CAMERA_ANALYSIS_INTERVAL_MS = readIntervalMs('VITE_PROCTOR_CAMERA_ANALYSIS_INTERVAL_MS', 5000)
const AUDIO_ANALYSIS_INTERVAL_MS = readIntervalMs('VITE_PROCTOR_AUDIO_ANALYSIS_INTERVAL_MS', 4000)
const CAMERA_SNAPSHOT_INTERVAL_MS = readIntervalMs('VITE_PROCTOR_CAMERA_SNAPSHOT_INTERVAL_MS', 10000)
const CAMERA_SNAPSHOT_MAX_SIDE_PX = 960
const CAMERA_SNAPSHOT_JPEG_QUALITY = 0.45

function identityFlagLabel(flag) {
  return IDENTITY_FLAG_LABELS[flag] || String(flag || '').replaceAll('_', ' ')
}

function buildIdentityMessage(result) {
  const verified = Boolean(result?.verified)
  if (verified) {
    return 'Government ID and live selfie saved. You can proceed to the exam.'
  }

  const guidance = Array.isArray(result?.guidance)
    ? result.guidance.map((item) => String(item?.message || '').trim()).filter(Boolean)
    : []
  if (guidance.length) return guidance[0]

  const blocking = Array.isArray(result?.blocking_flags) ? result.blocking_flags : []
  if (blocking.length) return `Identity save failed: ${blocking.map(identityFlagLabel).join(', ')}.`

  const flags = Array.isArray(result?.flags) ? result.flags : []
  if (flags.length) return `Identity save failed: ${flags.map(identityFlagLabel).join(', ')}.`

  return 'Identity save failed. Please try again.'
}

async function optimizeImageDataUrl(file, { maxSide = 1600, quality = 0.9 } = {}) {
  const original = await fileToDataUrl(file)
  if (typeof document === 'undefined') return original

  return new Promise((resolve) => {
    const image = new Image()
    const objectUrl = URL.createObjectURL(file)
    image.onload = () => {
      try {
        const width = Number(image.naturalWidth || image.width || 0)
        const height = Number(image.naturalHeight || image.height || 0)
        if (!width || !height) {
          resolve(original)
          return
        }

        const scale = Math.min(1, maxSide / Math.max(width, height))
        const targetWidth = Math.max(1, Math.round(width * scale))
        const targetHeight = Math.max(1, Math.round(height * scale))

        const canvas = document.createElement('canvas')
        canvas.width = targetWidth
        canvas.height = targetHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(original)
          return
        }

        ctx.drawImage(image, 0, 0, targetWidth, targetHeight)
        const compressed = canvas.toDataURL('image/jpeg', Math.max(0.55, Math.min(quality, 0.95)))
        resolve(compressed && compressed !== 'data:,' ? compressed : original)
      } catch {
        resolve(original)
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(original)
    }
    image.src = objectUrl
  })
}

const EL = {
  suspicious_face_movement: 'Face movement away from screen',
  suspicious_eye_movement: 'Face movement away from screen',
  suspicious_head_movement: 'Head movement detected',
  suspicious_object_detected: 'Suspicious object detected',
  audio_anomaly_detected: 'Background noise detected',
  voice_activity_detected: 'Voice activity detected',
  speech_detected: 'Speech detected',
  multiple_faces_detected: 'Multiple faces detected',
  no_face_detected: 'Face not visible',
  suspicious_candidate_identity_change: 'Identity mismatch',
  tab_switch_detected: 'Tab switch detected',
  window_blur: 'Window lost focus',
  page_hidden: 'Page hidden',
  focus_lost: 'Focus lost',
  fullscreen_exited: 'Fullscreen exited',
  fullscreen_required_not_entered: 'Fullscreen was not entered',
  camera_stream_ended: 'Camera stream ended',
  mic_stream_ended: 'Microphone stream ended',
  camera_track_muted: 'Camera muted',
  mic_track_muted: 'Microphone muted',
  camera_permission_revoked: 'Camera permission revoked',
  mic_permission_revoked: 'Microphone permission revoked',
  camera_device_changed: 'Camera device changed',
  mic_device_changed: 'Microphone device changed',
  camera_no_video_signal: 'Camera signal lost',
  camera_video_frozen: 'Camera video frozen',
  devtools_suspected: 'Developer tools suspected',
  copy_blocked: 'Copy blocked',
  cut_blocked: 'Cut blocked',
  paste_blocked: 'Paste blocked',
  context_menu_blocked: 'Context menu blocked',
  clipboard_shortcut_blocked: 'Clipboard shortcut blocked',
  devtools_shortcut_blocked: 'DevTools shortcut blocked',
  print_shortcut_blocked: 'Print shortcut blocked',
  save_shortcut_blocked: 'Save shortcut blocked',
  screenshot_blocked: 'Screenshot blocked',
  screen_capture_blocked: 'Screen capture blocked',
  print_screen_blocked: 'Print Screen blocked',
  drag_blocked: 'Drag blocked',
  select_all_blocked: 'Select-all blocked',
  vm_detected: 'Virtual machine detected',
  remote_desktop_detected: 'Remote desktop detected',
  browser_extension_detected: 'Suspicious browser extension',
  clipboard_content_detected: 'External clipboard content',
  typing_anomaly_detected: 'Typing pattern anomaly',
  ip_changed: 'IP address changed mid-exam',
  screenshot_captured: 'Periodic screenshot captured',
  multiple_tabs_detected: 'Multiple exam tabs detected',
  network_offline: 'Internet connection lost',
  face_id_verification: 'Identity details saved',
}
function label(t) { return EL[t] || String(t || '').replaceAll('_', ' ') }

function captureFrameAsDataUrl(videoEl, canvasEl, { maxSide = 0, quality = 0.7 } = {}) {
  const sourceWidth = Number(videoEl?.videoWidth || 0)
  const sourceHeight = Number(videoEl?.videoHeight || 0)
  if (!sourceWidth || !sourceHeight || !canvasEl) return ''

  const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight)) : 1
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const ctx = canvasEl.getContext('2d')
  if (!ctx) return ''

  canvasEl.width = width
  canvasEl.height = height
  ctx.drawImage(videoEl, 0, 0, width, height)
  const safeQuality = Math.max(0.35, Math.min(0.95, Number(quality) || 0.7))
  return canvasEl.toDataURL('image/jpeg', safeQuality)
}

/* ─── tiny SVG icons ─── */
function IcoCheck({ size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none"><path d="M5 10.5L8.5 14L15 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
function IcoShield({ size = 28 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M12 2L4 6v5c0 5.25 3.4 10.15 8 11.4 4.6-1.25 8-6.15 8-11.4V6l-8-4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M8.5 12.5l2.2 2.2 4.8-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
}
function IcoTimer({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none"><circle cx="10" cy="11" r="7" stroke="currentColor" strokeWidth="1.5"/><path d="M10 8v3l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M8 2h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
}
function IcoCamera({ size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.5"/></svg>
}
function IcoMic({ size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><rect x="9" y="1" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.5"/><path d="M5 10a7 7 0 0014 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M12 19v4M8 23h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
}
function IcoSpeaker({ size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M11 5L6 9H2v6h4l5 4V5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
}

/* ═══════════════════════════════════════════════════════ */
/*                  ASSESSMENT COMPONENT                  */
/* ═══════════════════════════════════════════════════════ */
function Assessment() {
  /* ── state ── */
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [violationCounts, setViolationCounts] = useState({})
  const [toast, setToast] = useState('')
  const toastTimeoutRef = useRef(null)

  const [sessionCodeInput, setSessionCodeInput] = useState('')
  const [sessionCode, setSessionCode] = useState('')

  const [cameraOk, setCameraOk] = useState(false)
  const [micOk, setMicOk] = useState(false)
  const [speakerOk, setSpeakerOk] = useState(false)
  const [speakerTestPlayed, setSpeakerTestPlayed] = useState(false)
  const [micLevel, setMicLevel] = useState(0)

  const [starting, setStarting] = useState(false)
  const [exam, setExam] = useState(null)
  const [answers, setAnswers] = useState({})
  const [running, setRunning] = useState(false)
  const [timeLeft, setTimeLeft] = useState(0)
  const [result, setResult] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [terminationReason, setTerminationReason] = useState('')
  const [tabSwitchCount, setTabSwitchCount] = useState(0)
  const [antiCheatFlags, setAntiCheatFlags] = useState([])

  const [currentQ, setCurrentQ] = useState(0)
  const [showConfirmSubmit, setShowConfirmSubmit] = useState(false)
  const [envCheckState, setEnvCheckState] = useState({ checked: false, severity: 'low', flags: [], riskScore: 0 })
  const [governmentIdType, setGovernmentIdType] = useState('aadhaar')
  const [idImageDataUrl, setIdImageDataUrl] = useState('')
  const [idImageName, setIdImageName] = useState('')
  const [capturedSelfie, setCapturedSelfie] = useState('')
  const [capturingSelfie, setCapturingSelfie] = useState(false)
  const [identityCheck, setIdentityCheck] = useState({ loading: false, verified: false, message: '', details: null })
  const [duplicateTabDetected, setDuplicateTabDetected] = useState(false)
  const [networkOnline, setNetworkOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine !== false : true)

  const videoRef = useRef(null)
  const frameCanvasRef = useRef(null)
  const snapshotCanvasRef = useRef(null)
  const cameraStreamRef = useRef(null)
  const micStreamRef = useRef(null)
  const micCtxRef = useRef(null)
  const micIntervalRef = useRef(null)
  const submissionStateRef = useRef({ inFlight: false })

  const vadStateRef = useRef({ speaking: false, aboveMs: 0, lastEventAt: 0, lastSpeechAt: 0 })
  const speechRecRef = useRef(null)
  const speechBufferRef = useRef({ lastText: '', lastSentAt: 0 })

  const tabSwitchCountRef = useRef(0)
  const proctorIntervalIdsRef = useRef([])
  const proctorListenersRef = useRef([])

  const fullscreenStateRef = useRef({ shouldEnforce: false, enteredOnce: false, startAt: 0 })
  const violationStateRef = useRef({})
  const nonBlockingEventRef = useRef({})
  const streamGuardRef = useRef({ cameraDeviceId: null, micDeviceId: null, lastVideoTime: 0, frozenStreak: 0 })
  const typingBioRef = useRef({ keyTimes: [], lastKeyAt: 0, burstCount: 0, avgInterval: null })
  const ipRef = useRef({ initial: null, checked: false })
  const tabCoordRef = useRef({ tabId: `tab-${Math.random().toString(36).slice(2, 10)}`, channel: null, detected: false })
  const examStateRef = useRef({ running: false, result: null })

  const hasCode = Boolean(String(sessionCodeInput || '').trim())
  const precheckPassed = cameraOk && micOk && speakerOk
  const questions = exam?.questions || []
  const totalQ = questions.length
  const answeredCount = Object.keys(answers).filter((k) => answers[k]).length
  const antiCheat = exam?.anti_cheat || {}
  const identityRequired = antiCheat.requires_face_verification !== false
  const envApproved = !envCheckState.checked || envCheckState.severity !== 'high'
  const identityDetails = identityCheck.details || {}
  const identityGuidance = Array.isArray(identityDetails.guidance) ? identityDetails.guidance : []
  const identityFlags = Array.isArray(identityDetails.flags) ? identityDetails.flags : []
  const identityBlockingFlags = Array.isArray(identityDetails.blocking_flags) ? identityDetails.blocking_flags : []
  const canVerifyIdentity = Boolean(governmentIdType && idImageDataUrl && capturedSelfie && !identityCheck.loading && !capturingSelfie)
  const canBeginAssessment = Boolean(
    exam &&
    precheckPassed &&
    !starting &&
    !duplicateTabDetected &&
    networkOnline &&
    envApproved &&
    (!identityRequired || identityCheck.verified)
  )

  /* ── shared helpers ── */
  const showToast = useCallback((message) => {
    const m = String(message || '').trim(); if (!m) return
    setToast(m)
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current)
    toastTimeoutRef.current = setTimeout(() => { setToast(''); toastTimeoutRef.current = null }, 3500)
  }, [])

  const pushFlag = useCallback((text) => {
    const t = String(text || '').trim(); if (!t) return
    setAntiCheatFlags((p) => [t, ...(p || [])].slice(0, 12))
  }, [])

  const finalizeUi = useCallback((msg = '', reason = '') => {
    setRunning(false); setTerminationReason(reason); if (msg) setInfo(msg)
    stopProctoring(); stopPrechecks()
  }, [])

  /* ── submit ── */
  const handleSubmit = useCallback(
    async (auto = false, customMessage = '') => {
      if (!sessionCode || !exam || result || submissionStateRef.current.inFlight) return
      submissionStateRef.current.inFlight = true
      setSubmitting(true); setError(''); setShowConfirmSubmit(false)
      const payload = questions.map((q) => ({ question_id: q.id, answer: answers[q.id] || '' }))

      if (auto) {
        setResult({ auto_submitted: true, status: 'submitted' })
        finalizeUi(customMessage || 'Test submitted. Results will be shared soon.', customMessage)
      }
      try {
        const sub = await assessmentApi.submitExam(sessionCode, payload)
        void assessmentApi.logEvent({ session_code: sessionCode, event_type: 'exam_submitted', severity: 'low', payload: { auto, tab_switch_count: tabSwitchCountRef.current } }).catch(() => {})
        setResult(sub)
        if (!auto) finalizeUi(customMessage || 'Test submitted successfully.', customMessage)
      } catch (err) {
        if (auto) { setResult({ auto_submitted: true, status: 'submitted' }); setError('Auto-submit completed locally but server sync failed.') }
        else setError(err?.message || 'Submit failed')
      } finally { submissionStateRef.current.inFlight = false; setSubmitting(false) }
    },
    [answers, exam, finalizeUi, questions, result, sessionCode],
  )

  /* ── violations ── */
  const recordViolation = useCallback(
    async (eventType, { severity = 'medium', payload = null, maxWarnings = 3, cooldownMs = 6000, immediateClose = false } = {}) => {
      if (!running || result) return
      const type = String(eventType || 'violation')
      const now = Date.now()
      const prev = violationStateRef.current[type] || { count: 0, lastAt: 0 }
      if (cooldownMs && now - (prev.lastAt || 0) < cooldownMs) return
      const nextCount = (prev.count || 0) + 1
      violationStateRef.current[type] = { count: nextCount, lastAt: now }
      setViolationCounts((c) => ({ ...(c || {}), [type]: { count: nextCount, maxWarnings: Number(maxWarnings || 0) } }))
      pushFlag(maxWarnings > 0 ? `${label(type)} (${nextCount}/${maxWarnings})` : label(type))
      try { await assessmentApi.logEvent({ session_code: sessionCode, event_type: type, severity, payload: { count: nextCount, ...(payload || {}) } }) } catch { /* */ }
      if (immediateClose) { void handleSubmit(true, 'Test submitted. Results will be shared soon.'); return }
      if (maxWarnings > 0) {
        if (nextCount < maxWarnings) { showToast(`Warning: ${label(type)} (${nextCount}/${maxWarnings})`); return }
        if (nextCount === maxWarnings) { showToast(`Final warning: ${label(type)} — auto-submitting`); void handleSubmit(true, 'Test submitted. Results will be shared soon.'); return }
      }
      void handleSubmit(true, 'Test submitted. Results will be shared soon.')
    },
    [handleSubmit, pushFlag, result, running, sessionCode, showToast],
  )

  const logNonBlocking = useCallback(
    async (eventType, { severity = 'medium', payload = null, cooldownMs = 12000, maxAlerts = 2 } = {}) => {
      if (!running || result) return
      const type = String(eventType || 'event')
      const now = Date.now()
      const prev = nonBlockingEventRef.current[type] || { lastAt: 0, count: 0 }
      if (cooldownMs && now - (prev.lastAt || 0) < cooldownMs) return
      const nc = (prev.count || 0) + 1
      nonBlockingEventRef.current[type] = { lastAt: now, count: nc }
      pushFlag(label(type))
      try { await assessmentApi.logEvent({ session_code: sessionCode, event_type: type, severity, payload: { count: nc, ...(payload || {}) } }) } catch { /* */ }
      if (nc <= maxAlerts) showToast(`Notice: ${label(type)}`)
    },
    [pushFlag, result, running, sessionCode, showToast],
  )

  const closeNow = useCallback(
    (eventType, payload = null) => {
      if (!running || result) return
      showToast(`Violation: ${label(eventType)} — auto-submitting`)
      void recordViolation(eventType, { severity: 'high', payload, immediateClose: true, maxWarnings: 0, cooldownMs: 0 })
    },
    [recordViolation, result, running, showToast],
  )

  const tabClose = useCallback(
    (eventType, payload = null) => {
      if (!running || result) return
      tabSwitchCountRef.current += 1
      setTabSwitchCount(tabSwitchCountRef.current)
      closeNow(eventType, { tab_switch_count: tabSwitchCountRef.current, ...(payload || {}) })
    },
    [closeNow, result, running],
  )

  /* ── init ── */
  useEffect(() => {
    const qc = new URLSearchParams(window.location.search).get('code')
    if (qc) setSessionCodeInput(String(qc).trim().toUpperCase())
    startPrechecks()
    return () => { stopProctoring(); stopPrechecks(); if (toastTimeoutRef.current) { clearTimeout(toastTimeoutRef.current); toastTimeoutRef.current = null } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    examStateRef.current = { running, result }
  }, [result, running])

  useEffect(() => {
    if (!sessionCode || result) return

    const tabId = tabCoordRef.current.tabId
    const storageKey = `smarthire-assessment-tab:${sessionCode}`
    const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`smarthire-assessment:${sessionCode}`) : null
    tabCoordRef.current.channel = bc
    tabCoordRef.current.detected = false
    setDuplicateTabDetected(false)

    const logDuplicate = (source) => {
      if (tabCoordRef.current.detected) return
      tabCoordRef.current.detected = true
      setDuplicateTabDetected(true)
      pushFlag(label('multiple_tabs_detected'))

      if (examStateRef.current.running && !examStateRef.current.result) {
        showToast('Another tab for this assessment was detected. Auto-submitting now.')
        void assessmentApi.logEvent({
          session_code: sessionCode,
          event_type: 'multiple_tabs_detected',
          severity: 'high',
          payload: { source },
        }).catch(() => {})
        void handleSubmit(true, 'Another exam tab was detected. This assessment was auto-submitted.')
      } else {
        setError('This assessment is already open in another tab. Close the duplicate tab before starting.')
      }
    }

    const processPayload = (payload, source) => {
      if (!payload || payload.sessionCode !== sessionCode || payload.tabId === tabId) return
      if (Date.now() - Number(payload.ts || 0) > 6000) return
      logDuplicate(source)
    }

    const publishHeartbeat = () => {
      const payload = { sessionCode, tabId, ts: Date.now() }
      try { localStorage.setItem(storageKey, JSON.stringify(payload)) } catch { /* */ }
      try { bc?.postMessage(payload) } catch { /* */ }
    }

    const onStorage = (event) => {
      if (event.key !== storageKey || !event.newValue) return
      try { processPayload(JSON.parse(event.newValue), 'storage') } catch { /* */ }
    }
    const onBroadcast = (event) => processPayload(event?.data, 'broadcast')

    window.addEventListener('storage', onStorage)
    bc?.addEventListener?.('message', onBroadcast)
    publishHeartbeat()
    const heartbeatId = setInterval(publishHeartbeat, 2000)
    proctorIntervalIdsRef.current.push(heartbeatId)

    return () => {
      clearInterval(heartbeatId)
      window.removeEventListener('storage', onStorage)
      bc?.removeEventListener?.('message', onBroadcast)
      try { bc?.close?.() } catch { /* */ }
      tabCoordRef.current.channel = null
      try {
        const current = JSON.parse(localStorage.getItem(storageKey) || 'null')
        if (current?.tabId === tabId) localStorage.removeItem(storageKey)
      } catch { /* */ }
    }
  }, [handleSubmit, pushFlag, result, sessionCode, showToast])

  useEffect(() => {
    if (!running || result || !sessionCode) return

    const onOffline = () => {
      setNetworkOnline(false)
      pushFlag(label('network_offline'))
      showToast('Internet connection lost. Keep the tab open until connectivity returns.')
      void assessmentApi.logEvent({
        session_code: sessionCode,
        event_type: 'network_offline',
        severity: 'high',
        payload: { online: false },
      }).catch(() => {})
    }
    const onOnline = () => {
      setNetworkOnline(true)
      showToast('Internet connection restored.')
      void assessmentApi.logEvent({
        session_code: sessionCode,
        event_type: 'network_restored',
        severity: 'low',
        payload: { online: true },
      }).catch(() => {})
    }

    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [pushFlag, result, running, sessionCode, showToast])

  /* ── timer ── */
  useEffect(() => {
    if (!running || timeLeft <= 0) return
    const id = setInterval(() => {
      setTimeLeft((v) => { if (v <= 1) { clearInterval(id); handleSubmit(true, 'Time ended. Auto-submitted.'); return 0 } return v - 1 })
    }, 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, timeLeft])

  /* ── beforeunload + history lock ── */
  useEffect(() => {
    if (!running || result) return
    const onBU = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBU)
    window.history.pushState(null, '', window.location.href)
    const onPop = () => { window.history.pushState(null, '', window.location.href) }
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('beforeunload', onBU); window.removeEventListener('popstate', onPop) }
  }, [running, result])

  /* ── tab / visibility / fullscreen ── */
  useEffect(() => {
    if (!running || result) return
    const getFs = () => document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement
    const isFs = () => Boolean(getFs())
    const tryFs = () => { try { const el = document.documentElement; const r = el.requestFullscreen || el.webkitRequestFullscreen; if (!isFs() && r) void r.call(el) } catch { /* */ } }

    // Suppress blur/focus/fullscreen events during the first 4 s after exam start.
    // Browsers fire blur when entering fullscreen, causing immediate false auto-submit.
    const inGrace = () => { const s = fullscreenStateRef.current.startAt; return s > 0 && Date.now() - s < 4000 }

    const onVis = () => { if (document.hidden) tabClose('tab_switch_detected', { source: 'visibilitychange' }); else tryFs() }
    const onBlur = () => { if (inGrace()) return; tabClose('window_blur', { source: 'blur' }) }
    const onPageHide = () => { if (inGrace()) return; tabClose('page_hidden', { source: 'pagehide' }) }
    const onFocusOut = () => { if (inGrace()) return; if (document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus())) tabClose('focus_lost', { source: 'focusout' }) }
    const onFsChange = () => { if (!isFs() && !inGrace()) tabClose('fullscreen_exited', { source: 'fullscreenchange' }) }

    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('blur', onBlur)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('focusout', onFocusOut)
    document.addEventListener('fullscreenchange', onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange)

    const guardId = setInterval(() => {
      try {
        if (!running || result) return
        const fs = fullscreenStateRef.current
        const grace = fs.startAt > 0 && Date.now() - fs.startAt < 4000
        if (fs.shouldEnforce) {
          const inFs = isFs(); if (inFs) fs.enteredOnce = true
          if (!fs.enteredOnce && fs.startAt && Date.now() - fs.startAt > 5000) { tabClose('fullscreen_required_not_entered', { source: 'guard' }); return }
          if (fs.enteredOnce && !inFs && !grace) { tabClose('fullscreen_exited', { source: 'guard' }); return }
        }
        if (!grace && (document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus()))) tabClose('focus_lost', { source: 'guard' })
      } catch { /* */ }
    }, 120)

    proctorListenersRef.current.push(
      { target: document, event: 'visibilitychange', handler: onVis },
      { target: window, event: 'blur', handler: onBlur },
      { target: window, event: 'pagehide', handler: onPageHide },
      { target: window, event: 'focusout', handler: onFocusOut },
      { target: document, event: 'fullscreenchange', handler: onFsChange },
      { target: document, event: 'webkitfullscreenchange', handler: onFsChange },
    )
    proctorIntervalIdsRef.current.push(guardId)
    return () => {
      document.removeEventListener('visibilitychange', onVis); window.removeEventListener('blur', onBlur)
      window.removeEventListener('pagehide', onPageHide); window.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('fullscreenchange', onFsChange); document.removeEventListener('webkitfullscreenchange', onFsChange)
      clearInterval(guardId)
    }
  }, [tabClose, result, running])

  /* ── device / stream tamper ── */
  useEffect(() => {
    if (!running || result) return
    const g = streamGuardRef.current; g.frozenStreak = 0; g.lastVideoTime = 0
    const video = videoRef.current
    const cs = cameraStreamRef.current; const ms = micStreamRef.current
    const ct = cs?.getVideoTracks?.()?.[0]; const mt = ms?.getAudioTracks?.()?.[0]
    try { g.cameraDeviceId = ct?.getSettings?.().deviceId || null; g.micDeviceId = mt?.getSettings?.().deviceId || null } catch { /* */ }

    const onCE = () => closeNow('camera_stream_ended'); const onME = () => closeNow('mic_stream_ended')
    const onCM = () => closeNow('camera_track_muted'); const onMM = () => closeNow('mic_track_muted')
    if (ct) { ct.addEventListener?.('ended', onCE); ct.addEventListener?.('mute', onCM) }
    if (mt) { mt.addEventListener?.('ended', onME); mt.addEventListener?.('mute', onMM) }

    const gid = setInterval(async () => {
      try {
        if (!running || result) return
        if (navigator.permissions?.query) {
          try { const p = await navigator.permissions.query({ name: 'camera' }); if (p?.state === 'denied') { closeNow('camera_permission_revoked'); return } } catch { /* */ }
          try { const p = await navigator.permissions.query({ name: 'microphone' }); if (p?.state === 'denied') { closeNow('mic_permission_revoked'); return } } catch { /* */ }
        }
        try { const id = ct?.getSettings?.().deviceId || null; if (g.cameraDeviceId && id && id !== g.cameraDeviceId) { closeNow('camera_device_changed'); return } } catch { /* */ }
        try { const id = mt?.getSettings?.().deviceId || null; if (g.micDeviceId && id && id !== g.micDeviceId) { closeNow('mic_device_changed'); return } } catch { /* */ }
        if (video && ct?.readyState === 'live') {
          if (!video.videoWidth || !video.videoHeight) { closeNow('camera_no_video_signal'); return }
          const t = Number(video.currentTime || 0)
          if (g.lastVideoTime && t <= g.lastVideoTime + 0.01) g.frozenStreak += 1; else g.frozenStreak = 0
          g.lastVideoTime = t
          if (g.frozenStreak >= 6) closeNow('camera_video_frozen', { frozen_streak: g.frozenStreak })
        }
      } catch { /* */ }
    }, 1000)
    proctorIntervalIdsRef.current.push(gid)
    return () => {
      clearInterval(gid)
      try { ct?.removeEventListener?.('ended', onCE); ct?.removeEventListener?.('mute', onCM); mt?.removeEventListener?.('ended', onME); mt?.removeEventListener?.('mute', onMM) } catch { /* */ }
    }
  }, [closeNow, result, running])

  /* ── devtools detection ── */
  useEffect(() => {
    if (!running || result) return
    const id = setInterval(() => {
      try {
        if (!running || result) return
        const dW = Math.abs((window.outerWidth || 0) - (window.innerWidth || 0))
        const dH = Math.abs((window.outerHeight || 0) - (window.innerHeight || 0))
        if (dW > 180 || dH > 180) void logNonBlocking('devtools_suspected', { severity: 'medium', payload: { dW, dH }, cooldownMs: 15000, maxAlerts: 2 })
      } catch { /* */ }
    }, 1500)
    proctorIntervalIdsRef.current.push(id)
    return () => clearInterval(id)
  }, [logNonBlocking, result, running])

  /* ── keyboard / clipboard / drag / screenshot blocking ── */
  useEffect(() => {
    if (!running || result) return
    const logB = (ev, pl) => { pushFlag(`Blocked: ${label(ev)}`); try { void assessmentApi.logEvent({ session_code: sessionCode, event_type: ev, severity: 'medium', payload: pl || null }) } catch { /* */ } }

    const onCopy = (e) => { e.preventDefault(); logB('copy_blocked') }
    const onCut = (e) => { e.preventDefault(); logB('cut_blocked') }
    const onPaste = (e) => { e.preventDefault(); logB('paste_blocked') }
    const onCtx = (e) => { e.preventDefault(); logB('context_menu_blocked') }
    const onKey = (e) => {
      const k = String(e.key || '').toLowerCase()
      const c = e.ctrlKey || e.metaKey; const a = e.altKey; const s = e.shiftKey
      if (c && ['c', 'v', 'x'].includes(k)) { e.preventDefault(); logB('clipboard_shortcut_blocked', { key: e.key }); return }
      if (k === 'f12' || (c && s && k === 'i') || (c && s && k === 'j') || (c && k === 'u')) { e.preventDefault(); logB('devtools_shortcut_blocked', { key: e.key }); return }
      if (c && k === 'p') { e.preventDefault(); logB('print_shortcut_blocked'); return }
      if (c && k === 's') { e.preventDefault(); logB('save_shortcut_blocked') }
      if (k === 'printscreen' || k === 'snapshot') { e.preventDefault(); logB('print_screen_blocked') }
      if (e.metaKey && s && k === 's') { e.preventDefault(); logB('screenshot_blocked', { combo: 'Win+Shift+S' }) }
      if (c && k === 'a') { e.preventDefault(); logB('select_all_blocked') }
      if (a && k === 'tab') { e.preventDefault(); logB('tab_switch_detected', { combo: 'Alt+Tab' }) }
    }
    const onDrag = (e) => { e.preventDefault(); logB('drag_blocked') }
    const onDrop = (e) => { e.preventDefault() }
    const onSelect = (e) => { e.preventDefault() }

    document.addEventListener('copy', onCopy); document.addEventListener('cut', onCut)
    document.addEventListener('paste', onPaste); document.addEventListener('contextmenu', onCtx)
    window.addEventListener('keydown', onKey); document.addEventListener('dragstart', onDrag)
    document.addEventListener('drop', onDrop); document.addEventListener('selectstart', onSelect)

    if (navigator.mediaDevices?.getDisplayMedia) {
      const orig = navigator.mediaDevices.getDisplayMedia
      navigator.mediaDevices.getDisplayMedia = function () { logB('screen_capture_blocked'); return Promise.reject(new Error('Screen capture blocked')) }
      window.__origGDM = orig
    }
    document.body.style.userSelect = 'none'; document.body.style.webkitUserSelect = 'none'

    proctorListenersRef.current.push(
      { target: document, event: 'copy', handler: onCopy }, { target: document, event: 'cut', handler: onCut },
      { target: document, event: 'paste', handler: onPaste }, { target: document, event: 'contextmenu', handler: onCtx },
      { target: window, event: 'keydown', handler: onKey }, { target: document, event: 'dragstart', handler: onDrag },
      { target: document, event: 'drop', handler: onDrop }, { target: document, event: 'selectstart', handler: onSelect },
    )
    return () => {
      document.removeEventListener('copy', onCopy); document.removeEventListener('cut', onCut)
      document.removeEventListener('paste', onPaste); document.removeEventListener('contextmenu', onCtx)
      window.removeEventListener('keydown', onKey); document.removeEventListener('dragstart', onDrag)
      document.removeEventListener('drop', onDrop); document.removeEventListener('selectstart', onSelect)
      document.body.style.userSelect = ''; document.body.style.webkitUserSelect = ''
      if (window.__origGDM && navigator.mediaDevices) { navigator.mediaDevices.getDisplayMedia = window.__origGDM; delete window.__origGDM }
    }
  }, [pushFlag, result, running, sessionCode])

  /* ── VM / remote desktop detection ── */
  useEffect(() => {
    if (!running || result) return
    const flags = []
    try {
      const ua = navigator.userAgent || ''
      if (/VirtualBox|VMware|Hyper-V|QEMU|Parallels/i.test(ua)) flags.push('ua_vm')
      const p = navigator.platform || ''
      if (/virtual|vmware/i.test(p)) flags.push('platform_vm')
      if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 1) flags.push('single_core')
      if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 1) flags.push('low_memory')
      if (screen.width === screen.availWidth && screen.height === screen.availHeight && window.outerWidth === window.innerWidth && window.outerHeight === window.innerHeight) flags.push('no_taskbar')
      const gl = document.createElement('canvas').getContext('webgl')
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info')
        if (dbg) {
          const renderer = (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '').toLowerCase()
          if (/swiftshader|llvmpipe|virtualbox|vmware|mesa|parallels/i.test(renderer)) flags.push('vm_gpu')
        }
      }
    } catch { /* */ }
    if (flags.length >= 2) {
      void logNonBlocking('vm_detected', { severity: 'high', payload: { signals: flags }, cooldownMs: 60000, maxAlerts: 1 })
    }
    try {
      const rdpSignals = []
      if (typeof window.showModalDialog === 'function') rdpSignals.push('showModalDialog')
      if (screen.width <= 1024 && screen.height <= 768 && (screen.colorDepth || 24) <= 16) rdpSignals.push('low_res_depth')
      if (navigator.maxTouchPoints === 0 && !/mobile|tablet/i.test(navigator.userAgent || '')) {
        const mq = window.matchMedia?.('(pointer: fine)')
        if (mq && !mq.matches) rdpSignals.push('no_pointer')
      }
      if (rdpSignals.length >= 2) {
        void logNonBlocking('remote_desktop_detected', { severity: 'high', payload: { signals: rdpSignals }, cooldownMs: 60000, maxAlerts: 1 })
      }
    } catch { /* */ }
  }, [logNonBlocking, result, running])

  /* ── server-side environment check ── */
  useEffect(() => {
    if (!running || result || !sessionCode) return
    try {
      const gl = document.createElement('canvas').getContext('webgl')
      let renderer = '', vendor = ''
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info')
        if (dbg) {
          renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || ''
          vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || ''
        }
      }
      void assessmentApi.envCheck({
        session_code: sessionCode,
        user_agent: navigator.userAgent || '',
        platform: navigator.platform || '',
        hardware_concurrency: navigator.hardwareConcurrency || null,
        device_memory: navigator.deviceMemory || null,
        webgl_renderer: renderer,
        webgl_vendor: vendor,
        screen_width: screen.width,
        screen_height: screen.height,
        screen_color_depth: screen.colorDepth,
        max_touch_points: navigator.maxTouchPoints ?? 0,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        languages: [...(navigator.languages || [])],
        plugins_count: navigator.plugins?.length ?? 0,
        has_pointer: window.matchMedia?.('(pointer: fine)')?.matches ?? true,
      }).catch(() => {})
    } catch { /* */ }
  }, [running, result, sessionCode])

  /* ── browser extension detection ── */
  useEffect(() => {
    if (!running || result) return
    const detected = []
    try {
      const rootEl = document.documentElement
      const body = document.body
      const allEls = document.querySelectorAll('div, iframe, script, link')
      for (const el of allEls) {
        const src = el.src || el.href || ''
        if (/^chrome-extension:|^moz-extension:|^safari-extension:/i.test(src)) {
          detected.push(src.substring(0, 80))
        }
      }
      const injected = document.querySelectorAll('[data-extension], [class*="grammarly"], [id*="grammarly"], [class*="honey"], [id*="lastpass"], [data-gramm]')
      if (injected.length) detected.push(`injected_dom_elements:${injected.length}`)
      if (document.querySelectorAll('style[data-emotion], style[data-styled]').length > 3) detected.push('excessive_injected_styles')
    } catch { /* */ }
    if (detected.length) {
      void logNonBlocking('browser_extension_detected', { severity: 'medium', payload: { extensions: detected.slice(0, 5) }, cooldownMs: 30000, maxAlerts: 2 })
    }
    const rescanId = setInterval(() => {
      try {
        const newEls = document.querySelectorAll('[data-extension], [class*="grammarly"], [data-gramm], iframe[src*="chrome-extension"]')
        if (newEls.length) void logNonBlocking('browser_extension_detected', { severity: 'medium', payload: { count: newEls.length }, cooldownMs: 30000, maxAlerts: 2 })
      } catch { /* */ }
    }, 20000)
    proctorIntervalIdsRef.current.push(rescanId)
    return () => clearInterval(rescanId)
  }, [logNonBlocking, result, running])

  /* ── clipboard content detection ── */
  useEffect(() => {
    if (!running || result) return
    const onPasteDetect = async (e) => {
      e.preventDefault()
      let content = ''
      try { content = (e.clipboardData || window.clipboardData)?.getData('text') || '' } catch { /* */ }
      if (content.length > 10) {
        void logNonBlocking('clipboard_content_detected', { severity: 'high', payload: { length: content.length, preview: content.substring(0, 40) }, cooldownMs: 10000, maxAlerts: 3 })
      }
    }
    document.addEventListener('paste', onPasteDetect, true)
    const readClipboardId = setInterval(async () => {
      try {
        if (navigator.clipboard?.readText) {
          const text = await navigator.clipboard.readText()
          if (text && text.length > 30) {
            void logNonBlocking('clipboard_content_detected', { severity: 'medium', payload: { length: text.length, source: 'periodic_read' }, cooldownMs: 30000, maxAlerts: 2 })
          }
        }
      } catch { /* clipboard API may be blocked — expected */ }
    }, 15000)
    proctorIntervalIdsRef.current.push(readClipboardId)
    return () => { document.removeEventListener('paste', onPasteDetect, true); clearInterval(readClipboardId) }
  }, [logNonBlocking, result, running])

  /* ── typing biometrics ── */
  useEffect(() => {
    if (!running || result) return
    const bio = typingBioRef.current
    bio.keyTimes = []; bio.lastKeyAt = 0; bio.burstCount = 0; bio.avgInterval = null

    const onKey = (e) => {
      if (!e.key || e.key.length > 1) return
      const now = Date.now()
      if (bio.lastKeyAt) {
        const gap = now - bio.lastKeyAt
        bio.keyTimes.push(gap)
        if (bio.keyTimes.length > 200) bio.keyTimes.shift()
        if (bio.keyTimes.length >= 20 && !bio.avgInterval) {
          bio.avgInterval = bio.keyTimes.reduce((a, b) => a + b, 0) / bio.keyTimes.length
        }
        if (bio.avgInterval && gap < 15) {
          bio.burstCount += 1
          if (bio.burstCount >= 8) {
            void logNonBlocking('typing_anomaly_detected', { severity: 'high', payload: { reason: 'paste_like_burst', burst: bio.burstCount, avgInterval: Math.round(bio.avgInterval) }, cooldownMs: 15000, maxAlerts: 3 })
            bio.burstCount = 0
          }
        } else {
          bio.burstCount = 0
        }
      }
      bio.lastKeyAt = now
    }
    window.addEventListener('keydown', onKey)
    const checkId = setInterval(() => {
      if (bio.keyTimes.length < 30 || !bio.avgInterval) return
      const recent = bio.keyTimes.slice(-20)
      const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length
      if (bio.avgInterval > 100 && recentAvg < bio.avgInterval * 0.2) {
        void logNonBlocking('typing_anomaly_detected', { severity: 'high', payload: { reason: 'speed_spike', baseline: Math.round(bio.avgInterval), recent: Math.round(recentAvg) }, cooldownMs: 20000, maxAlerts: 3 })
      }
    }, 10000)
    proctorIntervalIdsRef.current.push(checkId)
    return () => { window.removeEventListener('keydown', onKey); clearInterval(checkId) }
  }, [logNonBlocking, result, running])

  /* ── IP geofencing / location binding ── */
  useEffect(() => {
    if (!running || result) return
    const ip = ipRef.current
    async function checkIp() {
      try {
        const resp = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) })
        const data = await resp.json()
        const currentIp = data?.ip
        if (!currentIp) return
        if (!ip.initial) {
          ip.initial = currentIp
          ip.checked = true
          try { await assessmentApi.logEvent({ session_code: sessionCode, event_type: 'ip_recorded', severity: 'low', payload: { ip: currentIp } }) } catch { /* */ }
        } else if (currentIp !== ip.initial) {
          void logNonBlocking('ip_changed', { severity: 'high', payload: { initial: ip.initial, current: currentIp }, cooldownMs: 60000, maxAlerts: 2 })
        }
      } catch { /* network error — don't flag */ }
    }
    void checkIp()
    const id = setInterval(checkIp, 60000)
    proctorIntervalIdsRef.current.push(id)
    return () => clearInterval(id)
  }, [logNonBlocking, result, running, sessionCode])

  /* ── periodic screenshot capture ── */
  useEffect(() => {
    if (!running || result) return
    const captureScreenshot = async () => {
      try {
        const v = videoRef.current
        if (!v || !sessionCode || v.readyState < 2) return
        const c = snapshotCanvasRef.current || document.createElement('canvas')
        snapshotCanvasRef.current = c
        const img = captureFrameAsDataUrl(v, c, { maxSide: CAMERA_SNAPSHOT_MAX_SIDE_PX, quality: CAMERA_SNAPSHOT_JPEG_QUALITY })
        if (!img || img === 'data:,') return
        await assessmentApi.logEvent({
          session_code: sessionCode,
          event_type: 'screenshot_captured',
          severity: 'low',
          payload: {
            timestamp: new Date().toISOString(),
            image_base64: img,
            image_width: c.width,
            image_height: c.height,
            capture_interval_ms: CAMERA_SNAPSHOT_INTERVAL_MS,
          },
        })
      } catch { /* */ }
    }
    const initialId = setTimeout(() => { void captureScreenshot() }, 1200)
    const id = setInterval(() => { void captureScreenshot() }, CAMERA_SNAPSHOT_INTERVAL_MS)
    proctorIntervalIdsRef.current.push(initialId, id)
    return () => { clearTimeout(initialId); clearInterval(id) }
  }, [result, running, sessionCode])

  /* keep camera bound */
  useEffect(() => {
    if (!running || result) return
    if (cameraStreamRef.current && videoRef.current) { videoRef.current.srcObject = cameraStreamRef.current; videoRef.current.play().catch(() => {}) }
  }, [running, result])

  /* ── proctoring helpers ── */
  function stopProctoring() {
    proctorIntervalIdsRef.current.forEach((id) => clearInterval(id)); proctorIntervalIdsRef.current = []
    proctorListenersRef.current.forEach(({ target, event, handler }) => target.removeEventListener(event, handler)); proctorListenersRef.current = []
    try { if (speechRecRef.current) { speechRecRef.current.onresult = null; speechRecRef.current.onerror = null; speechRecRef.current.onend = null; speechRecRef.current.stop() } } catch { /* */ }
    speechRecRef.current = null
  }

  async function sendCameraFrame(session) {
    const v = videoRef.current; const c = frameCanvasRef.current
    if (!v || !c || !session || !v.videoWidth || !v.videoHeight) return
    const ctx = c.getContext('2d'); c.width = v.videoWidth; c.height = v.videoHeight; ctx.drawImage(v, 0, 0, c.width, c.height)
    const img = c.toDataURL('image/jpeg', 0.7)
    try {
      const r = await assessmentApi.analyzeFrame({ session_code: session, camera_type: 'primary', image_base64: img })
      const flags = Array.isArray(r?.flags) ? r.flags : []
      flags.forEach((f) => {
        const fl = String(f || '').trim(); if (!fl) return
        if (fl === 'calibrating_gaze_baseline') { void assessmentApi.logEvent({ session_code: session, event_type: fl, severity: 'low', payload: {} }); return }
        if (fl === 'multiple_faces_detected') { closeNow('multiple_faces_detected', { flag: fl }); return }
        if (fl === 'no_face_detected') { void recordViolation('no_face_detected', { severity: 'high', maxWarnings: 3, cooldownMs: 8000 }); return }
        if (fl === 'suspicious_face_movement' || fl === 'suspicious_eye_movement' || fl === 'prolonged_offscreen_attention') { void recordViolation('suspicious_face_movement', { severity: 'medium', payload: { flag: fl }, maxWarnings: 3, cooldownMs: 7000 }); return }
        if (fl === 'suspicious_head_movement') { void recordViolation('suspicious_head_movement', { severity: 'medium', payload: { flag: fl }, maxWarnings: 3, cooldownMs: 8000 }); return }
        if (['suspicious_object_detected', 'cell_phone_detected', 'book_detected', 'multiple_persons_detected', 'laptop_detected', 'monitor_detected'].includes(fl)) { void recordViolation('suspicious_object_detected', { severity: 'high', payload: { flag: fl }, maxWarnings: 3, cooldownMs: 9000 }); return }
        if (fl === 'suspicious_candidate_identity_change') { closeNow('suspicious_candidate_identity_change', { flag: fl }); return }
        pushFlag(`Camera: ${label(fl)}`)
      })
    } catch { /* */ }
  }

  async function sendAudioSample(session) {
    const b = micCtxRef.current; if (!b || !session) return
    try {
      b.analyser.getFloatTimeDomainData(b.data)
      let sum = 0; for (let i = 0; i < b.data.length; i += 1) sum += b.data[i] * b.data[i]
      const rms = Math.sqrt(sum / b.data.length)
      const r = await assessmentApi.analyzeAudio({ session_code: session, rms })
      if (r?.is_anomaly) void recordViolation('audio_anomaly_detected', { severity: 'medium', payload: { rms: Number(rms.toFixed(4)) }, maxWarnings: 3, cooldownMs: 12000 })
    } catch { /* */ }
  }

  function startSpeechRecognition(session) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR || !session) return
    try {
      const rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US'
      rec.onresult = (ev) => {
        try {
          let txt = ''; for (let i = ev.resultIndex; i < ev.results.length; i += 1) txt += ev.results[i][0]?.transcript || ''
          txt = txt.trim(); if (!txt) return
          const now = Date.now(); speechBufferRef.current.lastText = txt
          if (now - (speechBufferRef.current.lastSentAt || 0) < 4000) return
          speechBufferRef.current.lastSentAt = now; vadStateRef.current.lastSpeechAt = now
          pushFlag('Speech detected')
          void recordViolation('speech_detected', { severity: 'medium', payload: { transcript: txt.slice(0, 240) }, maxWarnings: 3, cooldownMs: 15000 })
          void assessmentApi.logEvent({ session_code: session, event_type: 'speech_recognition', severity: 'medium', payload: { transcript: txt.slice(0, 240) } })
        } catch { /* */ }
      }
      rec.onerror = () => {}; rec.onend = () => { try { if (running && !result) rec.start() } catch { /* */ } }
      rec.start(); speechRecRef.current = rec
    } catch { /* */ }
  }

  function startVAD(session) {
    const st = vadStateRef.current; st.speaking = false; st.aboveMs = 0; st.lastEventAt = 0
    const id = setInterval(() => {
      try {
        if (!running || result) return
        const b = micCtxRef.current; if (!b) return
        b.analyser.getFloatTimeDomainData(b.data)
        let sum = 0; for (let i = 0; i < b.data.length; i += 1) sum += b.data[i] * b.data[i]
        const rms = Math.sqrt(sum / b.data.length)
        st.aboveMs = rms >= 0.03 ? st.aboveMs + 200 : 0
        const now = Date.now()
        if (!st.speaking && st.aboveMs >= 800) {
          st.speaking = true
          if (now - st.lastEventAt > 5000) {
            st.lastEventAt = now; pushFlag('Voice activity'); void recordViolation('voice_activity_detected', { severity: 'medium', payload: { rms: Number(rms.toFixed(4)) }, maxWarnings: 3, cooldownMs: 12000 })
            if (session) void assessmentApi.logEvent({ session_code: session, event_type: 'voice_activity_detected', severity: 'medium', payload: { rms: Number(rms.toFixed(4)) } })
          }
        }
        if (st.speaking && rms < 0.03) st.speaking = false
      } catch { /* */ }
    }, 200)
    proctorIntervalIdsRef.current.push(id)
  }

  /* ── prechecks ── */
  async function startPrechecks() {
    setError(''); setInfo(''); setSpeakerOk(false); setSpeakerTestPlayed(false)
    try {
      if (!cameraStreamRef.current) cameraStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      if (videoRef.current) { videoRef.current.srcObject = cameraStreamRef.current; await videoRef.current.play().catch(() => {}) }
      setCameraOk(true)
    } catch (e) { setCameraOk(false); setError(e?.message || 'Camera permission denied.') }
    try {
      if (!micStreamRef.current) micStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: false, audio: true })
      if (!micCtxRef.current) {
        const ctx = new AudioContext(); const src = ctx.createMediaStreamSource(micStreamRef.current)
        const a = ctx.createAnalyser(); a.fftSize = 1024; src.connect(a)
        micCtxRef.current = { ctx, analyser: a, data: new Float32Array(a.fftSize) }
      }
      setMicOk(true)
      if (!micIntervalRef.current) micIntervalRef.current = setInterval(() => {
        try { const b = micCtxRef.current; if (!b) return; b.analyser.getFloatTimeDomainData(b.data); let sum = 0; for (let i = 0; i < b.data.length; i += 1) sum += b.data[i] * b.data[i]; setMicLevel(Math.sqrt(sum / b.data.length)) } catch { /* */ }
      }, 250)
    } catch (e) { setMicOk(false); setError(e?.message || 'Microphone permission denied.') }
    if (sessionCode) void runEnvironmentCheck(sessionCode)
  }
  function stopPrechecks() {
    if (micIntervalRef.current) { clearInterval(micIntervalRef.current); micIntervalRef.current = null }
    if (micCtxRef.current?.ctx) micCtxRef.current.ctx.close().catch(() => {}); micCtxRef.current = null
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach((t) => t.stop()); micStreamRef.current = null }
    if (cameraStreamRef.current) { cameraStreamRef.current.getTracks().forEach((t) => t.stop()); cameraStreamRef.current = null }
  }
  function stopPrecheckMeter() { if (micIntervalRef.current) { clearInterval(micIntervalRef.current); micIntervalRef.current = null } }

  function resetAll() {
    setExam(null); setSessionCode(''); setAnswers({}); setResult(null); setRunning(false); setTimeLeft(0)
    setTerminationReason(''); setCurrentQ(0); setShowConfirmSubmit(false); submissionStateRef.current.inFlight = false
    setEnvCheckState({ checked: false, severity: 'low', flags: [], riskScore: 0 })
    setGovernmentIdType('aadhaar')
    setIdImageDataUrl(''); setIdImageName(''); setCapturedSelfie(''); setCapturingSelfie(false)
    setIdentityCheck({ loading: false, verified: false, message: '', details: null })
    setDuplicateTabDetected(false)
  }

  async function playTestSound() {
    setError('')
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const o = ctx.createOscillator(); const g = ctx.createGain()
      o.type = 'sine'; o.frequency.value = 440; g.gain.value = 0.08
      o.connect(g); g.connect(ctx.destination); o.start()
      setTimeout(() => { try { o.stop(); ctx.close() } catch { /* */ } }, 450)
      setSpeakerTestPlayed(true)
    } catch (e) { setSpeakerOk(false); setError(e?.message || 'Unable to play test sound.') }
  }

  async function runEnvironmentCheck(nextSessionCode) {
    const activeSessionCode = String(nextSessionCode || sessionCode || '').trim()
    if (!activeSessionCode) return
    try {
      const gl = document.createElement('canvas').getContext('webgl')
      let renderer = '', vendor = ''
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info')
        if (dbg) {
          renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || ''
          vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || ''
        }
      }
      const data = await assessmentApi.envCheck({
        session_code: activeSessionCode,
        user_agent: navigator.userAgent || '',
        platform: navigator.platform || '',
        hardware_concurrency: navigator.hardwareConcurrency || null,
        device_memory: navigator.deviceMemory || null,
        webgl_renderer: renderer,
        webgl_vendor: vendor,
        screen_width: screen.width,
        screen_height: screen.height,
        screen_color_depth: screen.colorDepth,
        max_touch_points: navigator.maxTouchPoints ?? 0,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        languages: [...(navigator.languages || [])],
        plugins_count: navigator.plugins?.length ?? 0,
        has_pointer: window.matchMedia?.('(pointer: fine)')?.matches ?? true,
      })
      setEnvCheckState({
        checked: true,
        severity: String(data?.severity || 'low'),
        flags: Array.isArray(data?.flags) ? data.flags : [],
        riskScore: Number(data?.risk_score || 0),
      })
    } catch {
      setEnvCheckState((prev) => ({ ...prev, checked: true }))
    }
  }

  async function captureSelfieFrame() {
    if (capturingSelfie) return
    setCapturingSelfie(true)
    const v = videoRef.current
    try {
      if (!v) {
        setError('Camera preview is unavailable right now. Please re-check your camera.')
        return
      }

      if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) {
        try { await v.play().catch(() => {}) } catch { /* */ }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }

      const track = cameraStreamRef.current?.getVideoTracks?.()?.[0] || null
      const settings = track?.getSettings?.() || {}
      const sourceWidth = Number(v.videoWidth || settings.width || 640)
      const sourceHeight = Number(v.videoHeight || settings.height || 480)

      if (!sourceWidth || !sourceHeight) {
        setError('Camera preview is not ready yet. Please wait a moment and try again.')
        return
      }

      const maxSide = 1280
      const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight))
      const width = Math.max(1, Math.round(sourceWidth * scale))
      const height = Math.max(1, Math.round(sourceHeight * scale))

      const c = frameCanvasRef.current || document.createElement('canvas')
      const ctx = c.getContext('2d')
      if (!ctx) {
        setError('Unable to access capture canvas. Please refresh and try again.')
        return
      }

      c.width = width
      c.height = height
      ctx.drawImage(v, 0, 0, width, height)
      const img = c.toDataURL('image/jpeg', 0.86)
      if (!img || img === 'data:,') {
        setError('Failed to capture selfie frame. Please try again.')
        return
      }

      setCapturedSelfie(img)
      setIdentityCheck((prev) => ({ ...prev, verified: false, message: '', details: null }))
      setError('')
      showToast('Live selfie captured successfully.')
    } finally {
      setCapturingSelfie(false)
    }
  }

  async function onSelectGovernmentId(event) {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      if (!String(file.type || '').startsWith('image/')) {
        setError('Please select a valid image file for government ID.')
        return
      }

      const dataUrl = await optimizeImageDataUrl(file, { maxSide: 1700, quality: 0.9 })
      setIdImageDataUrl(dataUrl)
      setIdImageName(file.name || 'government-id')
      setIdentityCheck((prev) => ({ ...prev, verified: false, message: '', details: null }))
      setError('')
      showToast('Government ID image uploaded.')
    } catch (err) {
      setError(err?.message || 'Failed to read the selected ID image.')
    }
  }

  async function verifyIdentityBeforeExam() {
    if (!sessionCode) {
      setError('Load the exam first so ID and selfie can be linked to your session.')
      return
    }
    if (!idImageDataUrl) {
      setError('Upload a government ID image before saving identity.')
      return
    }
    if (!capturedSelfie) {
      setError('Capture a live selfie before saving identity.')
      return
    }
    if (!governmentIdType) {
      setError('Select your government ID type before saving identity.')
      return
    }

    setIdentityCheck({ loading: true, verified: false, message: '', details: null })
    setError('')
    try {
      const data = await assessmentApi.verifyCandidateIdentity({
        session_code: sessionCode,
        government_id_type: governmentIdType,
        id_image_base64: idImageDataUrl,
        selfie_image_base64: capturedSelfie,
      })
      const verified = Boolean(data?.verified)
      const message = buildIdentityMessage(data)
      setIdentityCheck({
        loading: false,
        verified,
        message,
        details: data,
      })
      if (verified) showToast('Government ID and selfie saved.')
      else if (message) showToast(message)
    } catch (err) {
      setIdentityCheck({
        loading: false,
        verified: false,
        message: err?.message || 'Identity save failed.',
        details: null,
      })
      setError(err?.message || 'Identity save failed.')
    }
  }

  async function prepareAssessment() {
    const code = String(sessionCodeInput || '').trim().toUpperCase()
    if (!code) { setError('Enter the session code from your email.'); return }
    if (!precheckPassed) { setError('Complete all pre-exam checks first.'); return }
    setStarting(true); setError(''); setInfo('Loading assessment…')
    try {
      resetAll()
      const d = await assessmentApi.accessExam(code)
      setSessionCode(d.session_code)
      setExam(d)
      setAnswers({})
      setTimeLeft(Number(d.duration_minutes || 0) * 60)
      tabSwitchCountRef.current = 0; setTabSwitchCount(0); setAntiCheatFlags([]); setViolationCounts({}); setToast('')
      setCapturedSelfie('')
      setIdentityCheck({ loading: false, verified: false, message: '', details: null })

      // If exam is already completed, jump straight to result view
      const status = String(d.status || '').toLowerCase()
      if (status === 'submitted' || status === 'graded' || status === 'rejected') {
        try {
          const existingResult = await assessmentApi.getExamResult(d.session_code)
          setResult(existingResult)
        } catch {
          setResult({ status: 'submitted', already_completed: true })
        }
        setInfo('This assessment has already been submitted.')
        return
      }

      await runEnvironmentCheck(d.session_code)
      setInfo('')
    } catch (e) { setError(e?.message || 'Unable to load assessment'); setInfo('') }
    finally { setStarting(false) }
  }

  async function beginAssessment() {
    if (!exam || !sessionCode) { setError('Prepare the assessment first.'); return }
    if (!precheckPassed) { setError('Complete all pre-exam checks first.'); return }
    if (duplicateTabDetected) { setError('Close the duplicate exam tab before starting.'); return }
    if (identityRequired && !identityCheck.verified) { setError('Upload ID + capture selfie + save identity before starting.'); return }
    if (!envApproved) { setError('This environment was flagged as high risk. Re-check your setup before starting.'); return }
    setError(''); setInfo(''); setTerminationReason(''); stopPrecheckMeter()
    stopProctoring() // clear precheck intervals BEFORE setRunning so the snapshot useEffect isn't wiped
    // Set startAt BEFORE setRunning so the grace period is active when the fullscreen
    // effect fires and registers its event listeners (requestFullscreen fires blur in browsers).
    fullscreenStateRef.current = { shouldEnforce: true, enteredOnce: false, startAt: Date.now() }
    setRunning(true); setCurrentQ(0)
    try { await assessmentApi.beginExam(sessionCode) } catch (e) { setRunning(false); setError(e?.message || 'Unable to start the assessment.'); return }
    try { const el = document.documentElement; const r = el.requestFullscreen || el.webkitRequestFullscreen; if (r) await r.call(el) } catch { /* */ }
    setTimeout(() => { try { if (!(document.fullscreenElement || document.webkitFullscreenElement)) tabClose('fullscreen_required_not_entered', { source: 'begin_check' }) } catch { /* */ } }, 900)
    try { await assessmentApi.logEvent({ session_code: sessionCode, event_type: 'exam_started', severity: 'low', payload: { fullscreen: Boolean(document.fullscreenElement) } }) } catch { /* */ }
    proctorIntervalIdsRef.current.push(
      setInterval(() => { void sendCameraFrame(sessionCode) }, CAMERA_ANALYSIS_INTERVAL_MS),
      setInterval(() => { void sendAudioSample(sessionCode) }, AUDIO_ANALYSIS_INTERVAL_MS),
    )
    startVAD(sessionCode); startSpeechRecognition(sessionCode)
  }

  /* ── derived ── */
  const timerPct = exam ? (timeLeft / (Number(exam.duration_minutes || 1) * 60)) * 100 : 100
  const urgent = timeLeft > 0 && timeLeft <= 60
  const warn = timeLeft > 60 && timeLeft <= 300
  const curQ = questions[currentQ] || null

  /* ════════════════════════ RENDER ════════════════════════ */
  return (
    <main className="main">
      <section className="ax">

        {/* ──────────── PRECHECK PHASE ──────────── */}
        {!running && !result ? (
          <>
            {/* hero */}
            <div className="ax-hero">
              <div className="ax-hero-icon"><IcoShield size={36} /></div>
              <h1 className="ax-hero-title">Proctored Assessment</h1>
              <p className="ax-hero-sub">Complete the setup below, then start your timed exam. Your camera, microphone, and screen activity are monitored throughout.</p>
            </div>

            {error ? <div className="ax-alert ax-alert--err">{error}</div> : null}
            {info ? <div className="ax-alert ax-alert--info">{info}</div> : null}

            {/* checks card */}
            <div className="ax-card">
              <div className="ax-card-hdr">
                <h2 className="ax-card-title">System Checks</h2>
                <button type="button" className="btn btn-ghost btn-sm" onClick={startPrechecks}>Re-check</button>
              </div>

              <div className="ax-checks">
                {/* camera */}
                <div className={`ax-chk ${cameraOk ? 'ax-chk--ok' : ''}`}>
                  <span className="ax-chk-ico">{cameraOk ? <IcoCheck /> : <IcoCamera />}</span>
                  <div>
                    <div className="ax-chk-lbl">Camera</div>
                    <div className="ax-chk-val">{cameraOk ? 'Connected' : 'Waiting for permission…'}</div>
                  </div>
                </div>
                {/* mic */}
                <div className={`ax-chk ${micOk ? 'ax-chk--ok' : ''}`}>
                  <span className="ax-chk-ico">{micOk ? <IcoCheck /> : <IcoMic />}</span>
                  <div>
                    <div className="ax-chk-lbl">Microphone</div>
                    <div className="ax-chk-val">
                      {micOk ? 'Connected' : 'Waiting for permission…'}
                      {micOk ? <div className="ax-mic-bar"><div className="ax-mic-fill" style={{ width: `${Math.min(100, micLevel * 1200)}%` }} /></div> : null}
                    </div>
                  </div>
                </div>
                {/* speaker */}
                <div className={`ax-chk ${speakerOk ? 'ax-chk--ok' : ''}`}>
                  <span className="ax-chk-ico">{speakerOk ? <IcoCheck /> : <IcoSpeaker />}</span>
                  <div>
                    <div className="ax-chk-lbl">Speaker</div>
                    <div className="ax-chk-val">{speakerOk ? 'Verified' : speakerTestPlayed ? 'Did you hear it?' : 'Not tested'}</div>
                    {!speakerOk ? (
                      <div className="ax-chk-actions">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={playTestSound}>Play tone</button>
                        {speakerTestPlayed ? <button type="button" className="btn btn-primary btn-sm" onClick={() => { setSpeakerOk(true); setError('') }}>I heard it</button> : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* camera preview */}
              <div className="ax-preview">
                <video ref={videoRef} autoPlay muted playsInline />
                <span className="ax-preview-badge"><span className="ax-preview-dot" />LIVE</span>
                <div className="ax-preview-caption">Camera Preview</div>
              </div>
            </div>

            {/* session code + start */}
            <div className="ax-card">
              <h2 className="ax-card-title" style={{ marginBottom: '0.75rem' }}>Enter Session Code</h2>
              <div className="ax-code-row">
                <div style={{ flex: 1 }}>
                  <input
                    className="input ax-code-input"
                    value={sessionCodeInput}
                    onChange={(e) => setSessionCodeInput(e.target.value.toUpperCase())}
                    placeholder="EXAM-XXXXXXXXXX"
                  />
                </div>
                {precheckPassed && hasCode && !exam ? (
                  <button type="button" className="btn btn-primary" onClick={prepareAssessment} disabled={starting}>
                    {starting ? 'Loading…' : 'Load Exam'}
                  </button>
                ) : null}
              </div>

              {exam ? (
                <div className="ax-ready">
                  <div className="ax-ready-chips">
                    <span className="ax-chip">{totalQ} questions</span>
                    <span className="ax-chip">{exam.duration_minutes} min</span>
                    <span className="ax-chip ax-chip--accent">AI-Proctored</span>
                    <span className="ax-chip">Camera capture every {Math.round(CAMERA_SNAPSHOT_INTERVAL_MS / 1000)}s</span>
                  </div>

                  <div style={{ marginTop: '1rem', display: 'grid', gap: '1rem' }}>
                    <div style={{ padding: '1rem', borderRadius: 14, border: '1px solid var(--border)', background: 'var(--bg-soft)' }}>
                      <div style={{ fontWeight: 650, marginBottom: '0.35rem' }}>Environment screening</div>
                      <div className="muted" style={{ fontSize: '0.84rem' }}>
                        {envCheckState.checked
                          ? `Risk score ${envCheckState.riskScore}/100 · ${String(envCheckState.severity || 'low').toUpperCase()}`
                          : 'Environment scan will run after the exam is loaded.'}
                      </div>
                      {envCheckState.flags?.length ? (
                        <div className="chip-row" style={{ marginTop: '0.65rem' }}>
                          {envCheckState.flags.slice(0, 5).map((flag) => <span key={flag} className="chip">{label(flag)}</span>)}
                        </div>
                      ) : null}
                      {!envApproved ? (
                        <div className="ax-alert ax-alert--err" style={{ marginTop: '0.75rem' }}>
                          High-risk environment detected. Close virtual machines, remote desktop tools, or suspicious extensions before starting.
                        </div>
                      ) : null}
                    </div>

                    {identityRequired ? (
                      <div className="ax-id-card">
                        <div style={{ fontWeight: 650, marginBottom: '0.35rem' }}>Identity setup</div>
                        <div className="muted" style={{ fontSize: '0.84rem', marginBottom: '0.85rem' }}>
                          Select an ID type, upload that government ID image, and capture a live selfie before exam start.
                        </div>

                        <div className="ax-id-checks">
                          <span className={`ax-id-check ${idImageDataUrl ? 'ax-id-check--ok' : ''}`}>1. ID uploaded</span>
                          <span className={`ax-id-check ${capturedSelfie ? 'ax-id-check--ok' : ''}`}>2. Live selfie captured</span>
                          <span className={`ax-id-check ${identityCheck.verified ? 'ax-id-check--ok' : ''}`}>3. Identity saved</span>
                        </div>

                        <div className="ax-id-grid">
                          <div>
                            <label className="label" htmlFor="gov-id-type">Government ID type</label>
                            <select
                              id="gov-id-type"
                              className="input"
                              value={governmentIdType}
                              onChange={(e) => {
                                setGovernmentIdType(e.target.value)
                                setIdentityCheck((prev) => ({ ...prev, verified: false, message: '', details: null }))
                              }}
                              style={{ marginBottom: '0.55rem' }}
                            >
                              {GOVERNMENT_ID_TYPES.map((item) => (
                                <option key={item.value} value={item.value}>{item.label}</option>
                              ))}
                            </select>
                            <label className="label" htmlFor="gov-id-upload">Government ID image</label>
                            <input id="gov-id-upload" className="input" type="file" accept="image/*" onChange={onSelectGovernmentId} />
                            <div className="muted" style={{ marginTop: '0.35rem', fontSize: '0.78rem' }}>
                              Accepted types: Aadhaar, PAN, Driving License, Voter ID.
                            </div>
                            {idImageName ? <div className="muted" style={{ marginTop: '0.4rem', fontSize: '0.78rem' }}>Selected: {idImageName}</div> : null}
                          </div>

                          <div className="ax-id-preview-grid">
                            <div className="ax-id-preview-box">
                              {capturedSelfie ? <img src={capturedSelfie} alt="Captured selfie" className="ax-id-preview-img" /> : <span className="muted">No selfie yet</span>}
                              <div className="ax-id-preview-label">Live selfie</div>
                            </div>
                            <div className="ax-id-preview-box">
                              {idImageDataUrl ? <img src={idImageDataUrl} alt="Uploaded ID preview" className="ax-id-preview-img" /> : <span className="muted">No ID uploaded</span>}
                              <div className="ax-id-preview-label">Government ID</div>
                            </div>
                          </div>

                        </div>

                        <div className="ax-id-actions">
                          <button type="button" className="btn btn-ghost btn-sm" onClick={captureSelfieFrame} disabled={!cameraOk || capturingSelfie}>
                            {!cameraOk ? 'Enable camera to capture selfie' : capturingSelfie ? 'Capturing…' : 'Capture live selfie'}
                          </button>
                          <button type="button" className="btn btn-primary btn-sm" onClick={verifyIdentityBeforeExam} disabled={!canVerifyIdentity}>
                            {identityCheck.loading ? 'Saving…' : 'Save identity'}
                          </button>
                          {identityCheck.verified ? <span className="badge-soft badge-green">Saved</span> : null}
                        </div>

                        {identityGuidance.length ? (
                          <ul className="ax-id-guidance">
                            {identityGuidance.slice(0, 3).map((item, index) => (
                              <li key={`${item?.flag || 'guidance'}-${index}`}>{String(item?.message || '').trim()}</li>
                            ))}
                          </ul>
                        ) : null}

                        {identityBlockingFlags.length ? (
                          <div className="chip-row" style={{ marginTop: '0.5rem' }}>
                            {identityBlockingFlags.map((flag) => <span key={`blocking-${flag}`} className="chip">{identityFlagLabel(flag)}</span>)}
                          </div>
                        ) : identityFlags.length ? (
                          <div className="chip-row" style={{ marginTop: '0.5rem' }}>
                            {identityFlags.slice(0, 4).map((flag) => <span key={`flag-${flag}`} className="chip">{identityFlagLabel(flag)}</span>)}
                          </div>
                        ) : null}

                        {identityCheck.message ? (
                          <div className={identityCheck.verified ? 'ax-alert ax-alert--success' : 'ax-alert ax-alert--err'} style={{ marginTop: '0.65rem', marginBottom: 0 }}>
                            {identityCheck.message}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className="ax-ready-rules">
                    <strong>Before you begin:</strong>
                    <ul>
                      <li>Fullscreen is <strong>required</strong> — exiting ends the exam immediately</li>
                      <li>Switching tabs or losing window focus ends the exam</li>
                      <li>Camera, microphone, face detection, and speech recognition remain active</li>
                      <li>Copy, paste, screenshots, and right-click are disabled</li>
                      <li>3-strike warnings for face, eye, head, audio, and object violations</li>
                    </ul>
                  </div>

                  {duplicateTabDetected ? (
                    <div className="ax-alert ax-alert--err" style={{ marginBottom: '0.75rem' }}>
                      Another tab for this assessment is active. Close it before starting here.
                    </div>
                  ) : null}

                  {!networkOnline ? (
                    <div className="ax-alert ax-alert--err" style={{ marginBottom: '0.75rem' }}>
                      Internet connection is currently offline. Reconnect before beginning the assessment.
                    </div>
                  ) : null}

                  <button type="button" className="btn btn-primary ax-begin-btn" onClick={beginAssessment} disabled={!canBeginAssessment}>
                    Begin Assessment
                  </button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {/* ──────────── EXAM PHASE ──────────── */}
        {running && exam ? (
          <div className="ax-exam">
            {/* sticky top bar */}
            <header className="ax-bar">
              <div className="ax-bar-left">
                <span className="ax-bar-code">{sessionCode}</span>
                <span className="ax-bar-dot"></span>
                <span className="ax-bar-prog">{answeredCount}/{totalQ} answered</span>
              </div>
              <div className={`ax-bar-timer ${urgent ? 'ax-bar-timer--urgent' : warn ? 'ax-bar-timer--warn' : ''}`}>
                <IcoTimer size={15} />
                <span>{fmt(timeLeft)}</span>
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowConfirmSubmit(true)} disabled={Boolean(result)}>
                Submit
              </button>
            </header>

            {/* timer bar */}
            <div className="ax-tbar">
              <div className={`ax-tbar-fill ${urgent ? 'ax-tbar-fill--urgent' : warn ? 'ax-tbar-fill--warn' : ''}`} style={{ width: `${timerPct}%` }} />
            </div>

            {/* warnings strip */}
            {(tabSwitchCount > 0 || Object.keys(violationCounts || {}).length > 0) ? (
              <div className="ax-warns">
                {tabSwitchCount > 0 ? <span className="ax-warn ax-warn--crit">Focus violation ({tabSwitchCount})</span> : null}
                {['suspicious_face_movement', 'suspicious_head_movement', 'suspicious_object_detected', 'audio_anomaly_detected', 'voice_activity_detected', 'speech_detected', 'no_face_detected']
                  .filter((k) => (violationCounts || {})[k])
                  .map((k) => <span key={k} className="ax-warn">{label(k)} {violationCounts[k].count}/{violationCounts[k].maxWarnings || 3}</span>)}
              </div>
            ) : null}

            {/* question body */}
            <div className="ax-qbody">
              {curQ ? (
                <div className="ax-qcard">
                  <div className="ax-qcard-num">Question {currentQ + 1} <span className="ax-qcard-of">of {totalQ}</span></div>
                  <div className="ax-qcard-txt">{curQ.question}</div>
                  <div className="ax-qcard-opts">
                    {(curQ.options || []).map((opt, i) => {
                      const sel = answers[curQ.id] === opt
                      return (
                        <button key={`${curQ.id}-${i}`} type="button" className={`ax-opt ${sel ? 'ax-opt--sel' : ''}`} onClick={() => { setAnswers((p) => ({ ...p, [curQ.id]: opt })) }}>
                          <span className="ax-opt-letter">{String.fromCharCode(65 + i)}</span>
                          <span className="ax-opt-text">{opt}</span>
                          {sel ? <span className="ax-opt-check"><IcoCheck size={16} /></span> : null}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : null}

              {/* navigation */}
              <div className="ax-qnav">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCurrentQ((p) => Math.max(0, p - 1))} disabled={currentQ === 0}>← Prev</button>
                <div className="ax-qnav-dots">
                  {questions.map((q, i) => (
                    <button key={q.id} type="button" className={`ax-dot ${i === currentQ ? 'ax-dot--cur' : ''} ${answers[q.id] ? 'ax-dot--done' : ''}`} onClick={() => setCurrentQ(i)} title={`Q${i + 1}${answers[q.id] ? ' (answered)' : ''}`}>{i + 1}</button>
                  ))}
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCurrentQ((p) => Math.min(totalQ - 1, p + 1))} disabled={currentQ >= totalQ - 1}>Next →</button>
              </div>
            </div>

            {/* PIP camera */}
            <div className="ax-pip">
              <video ref={videoRef} autoPlay muted playsInline className="ax-pip-vid" />
              <span className="ax-pip-live">LIVE</span>
            </div>

            <canvas ref={frameCanvasRef} style={{ display: 'none' }} />

            {/* confirm modal */}
            {showConfirmSubmit ? (
              <div className="ax-overlay" onClick={() => setShowConfirmSubmit(false)}>
                <div className="ax-modal" onClick={(e) => e.stopPropagation()}>
                  <h3 className="ax-modal-title">Submit Assessment?</h3>
                  <p className="ax-modal-body">
                    You have answered <strong>{answeredCount}</strong> of <strong>{totalQ}</strong> questions.
                    {answeredCount < totalQ ? <span> <strong>{totalQ - answeredCount}</strong> unanswered questions will be scored as incorrect.</span> : null}
                  </p>
                  <div className="ax-modal-btns">
                    <button type="button" className="btn btn-ghost" onClick={() => setShowConfirmSubmit(false)}>Continue Exam</button>
                    <button type="button" className="btn btn-primary" onClick={() => handleSubmit(false)} disabled={submitting}>{submitting ? 'Submitting…' : 'Confirm Submit'}</button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ──────────── RESULT PHASE ──────────── */}
        {result ? (
          <div className="ax-done">
            <svg className="ax-done-ico" width="72" height="72" viewBox="0 0 72 72" fill="none">
              <circle cx="36" cy="36" r="34" stroke="#22c55e" strokeWidth="3" />
              <path d="M22 37L32 47L50 27" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <h2 className="ax-done-title">Assessment Submitted</h2>
            <p className="ax-done-msg">{terminationReason || 'Your assessment has been submitted successfully.'}</p>
            <p className="ax-done-sub">Your results are being reviewed. You will receive an email with your score and feedback shortly. If you qualify, our team will contact you for the next interview round.</p>
          </div>
        ) : null}

      </section>

      {/* toast */}
      {toast ? <div className="ax-toast">{toast}</div> : null}

      {/* watermark (visible on screenshots) */}
      {running ? <div className="ax-watermark">PROCTORED EXAM &bull; CONFIDENTIAL &bull; {sessionCode}</div> : null}
    </main>
  )
}

export default Assessment
