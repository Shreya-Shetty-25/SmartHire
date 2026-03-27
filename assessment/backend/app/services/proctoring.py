import base64
from collections import deque
from dataclasses import dataclass, field
import os
from pathlib import Path
from threading import Lock
import time
import urllib.request
from datetime import datetime, timezone

import cv2
import numpy as np
from huggingface_hub import hf_hub_download
from mediapipe.python.solutions.face_mesh import FaceMesh


def _haar_cascade_path() -> str:
    cv2_root = Path(cv2.__file__).resolve().parent
    cascade_file = cv2_root / "data" / "haarcascade_frontalface_default.xml"
    return str(cascade_file)


face_cascade = cv2.CascadeClassifier(_haar_cascade_path())


LEFT_IRIS = [474, 475, 476, 477]
RIGHT_IRIS = [469, 470, 471, 472]

LEFT_EYE_OUTER = 33
LEFT_EYE_INNER = 133
RIGHT_EYE_INNER = 362
RIGHT_EYE_OUTER = 263 

LEFT_EYE_TOP = 159
LEFT_EYE_BOTTOM = 145
RIGHT_EYE_TOP = 386
RIGHT_EYE_BOTTOM = 374

NOSE_TIP = 1
MOUTH_TOP = 13
MOUTH_BOTTOM = 14

CALIBRATION_FRAMES = 8
HORIZONTAL_THRESHOLD = 0.12
VERTICAL_THRESHOLD = 0.10
OFFSCREEN_THRESHOLD_SECONDS = 2.5
HEAD_YAW_THRESHOLD = 0.22
HEAD_PITCH_THRESHOLD = 0.2
IDENTITY_SIMILARITY_THRESHOLD = 0.72
IDENTITY_MISMATCH_STREAK_THRESHOLD = 3
SECONDARY_STALE_SECONDS = 8.0
OBJECT_EDGE_DENSITY_THRESHOLD = 0.14
OBJECT_DETECTION_MIN_CONTOUR_AREA_RATIO = 0.01
OBJECT_DETECTION_MAX_CONTOUR_AREA_RATIO = 0.35
FACE_ID_VERIFICATION_THRESHOLD = 0.68
FACENET_IDENTITY_SIMILARITY_THRESHOLD = 0.63
ID_DOCUMENT_CONFIDENCE_THRESHOLD = 0.45
ID_MAX_FACE_AREA_RATIO = 0.58
FACE_MIN_QUALITY_SCORE = 0.18
FACE_DETECTION_CONFIDENCE_THRESHOLD = 0.45

FACENET_REPO_ID = "tomas-gajarsky/facenet"
FACENET_ONNX_CANDIDATE_FILES = [
    "model.onnx",
    "facenet.onnx",
    "weights/facenet.onnx",
    "onnx/model.onnx",
    "checkpoint/model.onnx",
]

OPENCV_DNN_FACE_PROTOTXT_URL = "https://raw.githubusercontent.com/opencv/opencv/master/samples/dnn/face_detector/deploy.prototxt"
OPENCV_DNN_FACE_MODEL_URL = (
    "https://raw.githubusercontent.com/opencv/opencv_3rdparty/dnn_samples_face_detector_20170830/"
    "res10_300x300_ssd_iter_140000_fp16.caffemodel"
)

# Lightweight object detector (COCO) for phones/books.
# Runs via OpenCV DNN; model is downloaded and cached on first use.
YOLOV5N_ONNX_URL = "https://github.com/ultralytics/yolov5/releases/download/v7.0/yolov5n.onnx"

# COCO class ids used by YOLO models.
COCO_CLASS_PERSON = 0
COCO_CLASS_TV = 62
COCO_CLASS_LAPTOP = 63
COCO_CLASS_CELL_PHONE = 67
COCO_CLASS_BOOK = 73

MODEL_CACHE_DIR = Path(__file__).resolve().parent / ".model_cache"


@dataclass
class ProctorTrackState:
    baseline_h: float | None = None
    baseline_v: float | None = None
    calibration_h: list[float] = field(default_factory=list)
    calibration_v: list[float] = field(default_factory=list)
    fused_history: deque[tuple[float, float]] = field(default_factory=lambda: deque(maxlen=6))
    offscreen_start_ts: float | None = None
    max_offscreen_seconds: float = 0.0


_track_state: dict[str, ProctorTrackState] = {}
_track_state_lock = Lock()


@dataclass
class SecondaryStreamState:
    pairing_token: str
    frames_received: int = 0
    last_seen_at: datetime | None = None
    latest_flags: list[str] = field(default_factory=list)
    previous_gray: np.ndarray | None = None
    low_motion_streak: int = 0


_secondary_streams: dict[str, SecondaryStreamState] = {}
_secondary_lock = Lock()


@dataclass
class IdentityTrackState:
    baseline_signature: np.ndarray | None = None
    baseline_model: str | None = None
    mismatch_streak: int = 0


_identity_states: dict[str, IdentityTrackState] = {}
_identity_lock = Lock()


_face_id_verified_sessions: dict[str, bool] = {}
_face_id_lock = Lock()


def cleanup_session_state(session_code: str) -> None:
    """Remove in-memory proctoring state for a finished exam to prevent memory leaks."""
    with _track_state_lock:
        _track_state.pop(session_code, None)
    with _secondary_lock:
        _secondary_streams.pop(session_code, None)
    with _identity_lock:
        _identity_states.pop(session_code, None)
    with _face_id_lock:
        _face_id_verified_sessions.pop(session_code, None)


_detector_dnn_net = None
_detector_dnn_lock = Lock()
_detector_dnn_attempted = False

_yolo_net = None
_yolo_lock = Lock()
_yolo_attempted = False

_facenet_net = None
_facenet_model_path: str | None = None
_facenet_load_error: str | None = None
_facenet_lock = Lock()
_facenet_attempted = False


def _ensure_model_cache() -> Path:
    MODEL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return MODEL_CACHE_DIR


def _download_if_missing(url: str, target_path: Path) -> Path:
    if target_path.exists():
        return target_path
    _ensure_model_cache()
    urllib.request.urlretrieve(url, str(target_path))
    return target_path


def _get_yolov5n_detector():
    global _yolo_net, _yolo_attempted

    with _yolo_lock:
        if _yolo_net is not None:
            return _yolo_net
        if _yolo_attempted:
            return None
        _yolo_attempted = True

        try:
            cache_dir = _ensure_model_cache()
            model_path = _download_if_missing(YOLOV5N_ONNX_URL, cache_dir / "yolov5n.onnx")
            _yolo_net = cv2.dnn.readNetFromONNX(str(model_path))
            return _yolo_net
        except Exception:
            return None


def _detect_phone_book_yolo(frame_bgr: np.ndarray) -> dict:
    """Detect high-risk objects in the frame (best-effort).

    Uses a lightweight COCO detector (YOLOv5n). Keeps the historical function name and
    response shape for compatibility.

    If the model can't be loaded, returns ok=False.
    """

    net = _get_yolov5n_detector()
    if net is None:
        return {
            "ok": False,
            "counts": {"cell_phone": 0, "book": 0, "person": 0, "laptop": 0, "monitor": 0},
            "detections": [],
        }

    h, w = frame_bgr.shape[:2]
    if h <= 0 or w <= 0:
        return {
            "ok": True,
            "counts": {"cell_phone": 0, "book": 0, "person": 0, "laptop": 0, "monitor": 0},
            "detections": [],
        }

    # YOLOv5 ONNX expects 640x640, RGB, normalized.
    blob = cv2.dnn.blobFromImage(frame_bgr, 1 / 255.0, (640, 640), swapRB=True, crop=False)
    with _yolo_lock:
        net.setInput(blob)
        outputs = net.forward()

    out = outputs[0] if isinstance(outputs, (list, tuple)) else outputs
    if out is None or len(out.shape) != 3:
        return {"ok": True, "counts": {"cell_phone": 0, "book": 0}, "detections": []}

    rows = out[0]
    conf_threshold = 0.35
    iou_threshold = 0.45

    boxes: list[list[int]] = []
    confidences: list[float] = []
    class_ids: list[int] = []

    x_factor = w / 640.0
    y_factor = h / 640.0

    for row in rows:
        obj_conf = float(row[4])
        if obj_conf < 0.15:
            continue

        class_scores = row[5:]
        class_id = int(np.argmax(class_scores))
        class_conf = float(class_scores[class_id])
        score = obj_conf * class_conf
        if score < conf_threshold:
            continue

        if class_id not in (COCO_CLASS_CELL_PHONE, COCO_CLASS_BOOK, COCO_CLASS_PERSON, COCO_CLASS_LAPTOP, COCO_CLASS_TV):
            continue

        cx, cy, bw, bh = float(row[0]), float(row[1]), float(row[2]), float(row[3])
        left = int((cx - bw / 2) * x_factor)
        top = int((cy - bh / 2) * y_factor)
        width = int(bw * x_factor)
        height = int(bh * y_factor)
        boxes.append([left, top, width, height])
        confidences.append(float(score))
        class_ids.append(class_id)

    if not boxes:
        return {
            "ok": True,
            "counts": {"cell_phone": 0, "book": 0, "person": 0, "laptop": 0, "monitor": 0},
            "detections": [],
        }

    indices = cv2.dnn.NMSBoxes(boxes, confidences, conf_threshold, iou_threshold)
    if len(indices) == 0:
        return {
            "ok": True,
            "counts": {"cell_phone": 0, "book": 0, "person": 0, "laptop": 0, "monitor": 0},
            "detections": [],
        }

    detections: list[dict] = []
    counts = {"cell_phone": 0, "book": 0, "person": 0, "laptop": 0, "monitor": 0}
    for index in indices:
        idx = int(index[0]) if isinstance(index, (list, tuple, np.ndarray)) else int(index)
        cid = int(class_ids[idx])
        if cid == COCO_CLASS_CELL_PHONE:
            label = "cell_phone"
        elif cid == COCO_CLASS_BOOK:
            label = "book"
        elif cid == COCO_CLASS_PERSON:
            label = "person"
        elif cid == COCO_CLASS_LAPTOP:
            label = "laptop"
        else:
            label = "monitor"

        if label in counts:
            counts[label] += 1
        x, y, bw, bh = boxes[idx]
        detections.append(
            {
                "label": label,
                "confidence": round(float(confidences[idx]), 4),
                "box": {"x": int(x), "y": int(y), "w": int(bw), "h": int(bh)},
            }
        )

    detections.sort(key=lambda d: d["confidence"], reverse=True)
    return {"ok": True, "counts": counts, "detections": detections[:6]}


def _get_dnn_face_detector():
    global _detector_dnn_net, _detector_dnn_attempted

    with _detector_dnn_lock:
        if _detector_dnn_net is not None:
            return _detector_dnn_net
        if _detector_dnn_attempted:
            return None
        _detector_dnn_attempted = True

        try:
            cache_dir = _ensure_model_cache()
            proto_path = _download_if_missing(OPENCV_DNN_FACE_PROTOTXT_URL, cache_dir / "deploy.prototxt")
            model_path = _download_if_missing(OPENCV_DNN_FACE_MODEL_URL, cache_dir / "res10_300x300_ssd_iter_140000_fp16.caffemodel")
            _detector_dnn_net = cv2.dnn.readNetFromCaffe(str(proto_path), str(model_path))
            return _detector_dnn_net
        except Exception:
            return None


def _detect_faces_dnn(frame_bgr: np.ndarray) -> list[tuple[int, int, int, int]]:
    net = _get_dnn_face_detector()
    if net is None:
        return []

    frame_h, frame_w = frame_bgr.shape[:2]
    blob = cv2.dnn.blobFromImage(frame_bgr, 1.0, (300, 300), (104.0, 177.0, 123.0))
    with _detector_dnn_lock:
        net.setInput(blob)
        detections = net.forward()

    boxes: list[list[int]] = []
    scores: list[float] = []
    for idx in range(detections.shape[2]):
        confidence = float(detections[0, 0, idx, 2])
        if confidence < FACE_DETECTION_CONFIDENCE_THRESHOLD:
            continue

        x1 = int(detections[0, 0, idx, 3] * frame_w)
        y1 = int(detections[0, 0, idx, 4] * frame_h)
        x2 = int(detections[0, 0, idx, 5] * frame_w)
        y2 = int(detections[0, 0, idx, 6] * frame_h)

        x1 = max(0, min(x1, frame_w - 1))
        y1 = max(0, min(y1, frame_h - 1))
        x2 = max(0, min(x2, frame_w - 1))
        y2 = max(0, min(y2, frame_h - 1))

        w = max(0, x2 - x1)
        h = max(0, y2 - y1)
        if w < 36 or h < 36:
            continue

        boxes.append([x1, y1, w, h])
        scores.append(confidence)

    if not boxes:
        return []

    nms_indices = cv2.dnn.NMSBoxes(boxes, scores, FACE_DETECTION_CONFIDENCE_THRESHOLD, 0.50)
    if len(nms_indices) == 0:
        return []

    faces: list[tuple[int, int, int, int]] = []
    for index in nms_indices:
        idx = int(index[0]) if isinstance(index, (list, tuple, np.ndarray)) else int(index)
        x, y, w, h = boxes[idx]
        faces.append((x, y, w, h))
    return faces


def _resolve_hf_token() -> str | None:
    return os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACEHUB_API_TOKEN")


def _load_facenet_model():
    global _facenet_net, _facenet_model_path, _facenet_load_error, _facenet_attempted

    with _facenet_lock:
        if _facenet_net is not None:
            return _facenet_net
        if _facenet_attempted:
            return None
        _facenet_attempted = True

        token = _resolve_hf_token()
        last_error = ""
        for filename in FACENET_ONNX_CANDIDATE_FILES:
            try:
                model_path = hf_hub_download(
                    repo_id=FACENET_REPO_ID,
                    filename=filename,
                    token=token,
                    local_dir=str(_ensure_model_cache() / "hf_facenet"),
                    local_dir_use_symlinks=False,
                )
                net = cv2.dnn.readNetFromONNX(model_path)
                _facenet_net = net
                _facenet_model_path = model_path
                _facenet_load_error = None
                return _facenet_net
            except Exception as exc:
                last_error = str(exc)

        _facenet_load_error = last_error or "model_unavailable"
        return None


def _extract_facenet_embedding(gray: np.ndarray, faces) -> np.ndarray | None:
    net = _load_facenet_model()
    if net is None or len(faces) == 0:
        return None

    face_crop, _ = _crop_largest_face(gray, faces, size=160)
    if face_crop is None:
        return None

    face_rgb = cv2.cvtColor(face_crop, cv2.COLOR_GRAY2RGB).astype(np.float32)
    face_rgb = (face_rgb - 127.5) / 128.0
    input_nchw = np.transpose(face_rgb, (2, 0, 1))[None, ...]

    try:
        with _facenet_lock:
            net.setInput(input_nchw)
            output = net.forward()
    except Exception:
        try:
            input_nhwc = face_rgb[None, ...]
            with _facenet_lock:
                net.setInput(input_nhwc)
                output = net.forward()
        except Exception:
            return None

    embedding = output.flatten().astype(np.float32)
    norm = float(np.linalg.norm(embedding))
    if norm <= 1e-8:
        return None
    return embedding / norm


def _extract_identity_vector(gray: np.ndarray, faces) -> tuple[np.ndarray | None, str]:
    facenet_embedding = _extract_facenet_embedding(gray, faces)
    if facenet_embedding is not None:
        return facenet_embedding, "hf_facenet"

    signature = _face_signature(gray, faces)
    if signature is not None:
        return signature, "classic_histogram"
    return None, "none"


def _decode_base64_image(image_base64: str) -> np.ndarray:
    payload = image_base64.split(",")[-1]
    raw = base64.b64decode(payload)
    array = np.frombuffer(raw, dtype=np.uint8)
    frame = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("Could not decode frame")
    return frame


def _detect_faces(gray: np.ndarray):
    frame_bgr = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR) if len(gray.shape) == 2 else gray
    dnn_faces = _detect_faces_dnn(frame_bgr)
    if dnn_faces:
        return dnn_faces
    fallback_faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=3, minSize=(30, 30))
    return [tuple(map(int, box)) for box in fallback_faces]


def _face_count(gray: np.ndarray) -> int:
    return len(_detect_faces(gray))


def _get_or_create_identity_state(session_code: str) -> IdentityTrackState:
    with _identity_lock:
        state = _identity_states.get(session_code)
        if state is None:
            state = IdentityTrackState()
            _identity_states[session_code] = state
        return state


def _face_signature(gray: np.ndarray, faces) -> np.ndarray | None:
    if len(faces) == 0:
        return None
    x, y, w, h = max(faces, key=lambda box: box[2] * box[3])
    crop = gray[y : y + h, x : x + w]
    if crop.size == 0:
        return None
    resized = cv2.resize(crop, (96, 96))
    hist = cv2.calcHist([resized], [0], None, [64], [0, 256])
    hist = cv2.normalize(hist, hist).flatten()
    return hist.astype(np.float32)


def _crop_largest_face(gray: np.ndarray, faces, size: int = 160) -> tuple[np.ndarray | None, float]:
    if len(faces) == 0:
        return None, 0.0
    x, y, w, h = max(faces, key=lambda box: box[2] * box[3])
    frame_area = float(gray.shape[0] * gray.shape[1])
    area_ratio = float((w * h) / max(frame_area, 1.0))

    pad_w = int(w * 0.15)
    pad_h = int(h * 0.15)
    x1 = max(0, x - pad_w)
    y1 = max(0, y - pad_h)
    x2 = min(gray.shape[1], x + w + pad_w)
    y2 = min(gray.shape[0], y + h + pad_h)
    crop = gray[y1:y2, x1:x2]
    if crop.size == 0:
        return None, area_ratio

    resized = cv2.resize(crop, (size, size))
    return resized, area_ratio


def _face_quality_score(face_crop_gray: np.ndarray | None) -> float:
    if face_crop_gray is None or face_crop_gray.size == 0:
        return 0.0

    blur = float(cv2.Laplacian(face_crop_gray, cv2.CV_64F).var())
    brightness = float(np.mean(face_crop_gray))
    contrast = float(np.std(face_crop_gray))

    blur_score = float(np.clip(blur / 220.0, 0.0, 1.0))
    brightness_score = 1.0 - float(np.clip(abs(brightness - 135.0) / 135.0, 0.0, 1.0))
    contrast_score = float(np.clip(contrast / 65.0, 0.0, 1.0))

    return float(round(0.5 * blur_score + 0.25 * brightness_score + 0.25 * contrast_score, 4))


def _dhash_similarity(image_a: np.ndarray | None, image_b: np.ndarray | None) -> float | None:
    if image_a is None or image_b is None:
        return None

    def _dhash(image: np.ndarray) -> np.ndarray:
        resized = cv2.resize(image, (9, 8))
        diff = resized[:, 1:] > resized[:, :-1]
        return diff.flatten().astype(np.uint8)

    hash_a = _dhash(image_a)
    hash_b = _dhash(image_b)
    if hash_a.size != hash_b.size:
        return None
    distance = int(np.count_nonzero(hash_a != hash_b))
    return float(max(0.0, 1.0 - (distance / hash_a.size)))


def _orb_similarity(image_a: np.ndarray | None, image_b: np.ndarray | None) -> float | None:
    if image_a is None or image_b is None:
        return None

    orb_factory = getattr(cv2, "ORB_create", None)
    if orb_factory is None:
        return None
    orb = orb_factory(nfeatures=400)
    keypoints_a, descriptors_a = orb.detectAndCompute(image_a, None)
    keypoints_b, descriptors_b = orb.detectAndCompute(image_b, None)

    if descriptors_a is None or descriptors_b is None or len(keypoints_a) == 0 or len(keypoints_b) == 0:
        return None

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    knn_matches = matcher.knnMatch(descriptors_a, descriptors_b, k=2)

    good_matches = 0
    for pair in knn_matches:
        if len(pair) < 2:
            continue
        first, second = pair
        if first.distance < 0.78 * second.distance:
            good_matches += 1

    denominator = max(min(len(keypoints_a), len(keypoints_b)), 1)
    return float(np.clip(good_matches / denominator, 0.0, 1.0))


def _face_similarity_components(id_gray: np.ndarray, id_faces, selfie_gray: np.ndarray, selfie_faces) -> tuple[float | None, dict]:
    id_facenet = _extract_facenet_embedding(id_gray, id_faces)
    selfie_facenet = _extract_facenet_embedding(selfie_gray, selfie_faces)
    facenet_similarity = None
    if id_facenet is not None and selfie_facenet is not None:
        facenet_similarity = _cosine_similarity(id_facenet, selfie_facenet)

    id_signature = _face_signature(id_gray, id_faces)
    selfie_signature = _face_signature(selfie_gray, selfie_faces)
    histogram_similarity = None
    if id_signature is not None and selfie_signature is not None:
        histogram_similarity = _cosine_similarity(id_signature, selfie_signature)

    id_crop, _ = _crop_largest_face(id_gray, id_faces)
    selfie_crop, _ = _crop_largest_face(selfie_gray, selfie_faces)
    orb_similarity = _orb_similarity(id_crop, selfie_crop)
    dhash_similarity = _dhash_similarity(id_crop, selfie_crop)

    weighted_components: list[tuple[float, float]] = []
    if facenet_similarity is not None:
        weighted_components.append((float(np.clip(facenet_similarity, 0.0, 1.0)), 0.6))
    if histogram_similarity is not None:
        weighted_components.append((float(np.clip(histogram_similarity, 0.0, 1.0)), 0.2))
    if orb_similarity is not None:
        weighted_components.append((float(np.clip(orb_similarity, 0.0, 1.0)), 0.12))
    if dhash_similarity is not None:
        weighted_components.append((float(np.clip(dhash_similarity, 0.0, 1.0)), 0.08))

    combined_similarity = None
    if weighted_components:
        total_weight = sum(weight for _, weight in weighted_components)
        combined_similarity = sum(value * weight for value, weight in weighted_components) / max(total_weight, 1e-6)

    return combined_similarity, {
        "facenet_similarity": None if facenet_similarity is None else round(float(facenet_similarity), 4),
        "histogram_similarity": None if histogram_similarity is None else round(float(histogram_similarity), 4),
        "orb_similarity": None if orb_similarity is None else round(float(orb_similarity), 4),
        "dhash_similarity": None if dhash_similarity is None else round(float(dhash_similarity), 4),
        "model_source": "hf_facenet" if facenet_similarity is not None else "classic_fallback",
    }


def _document_text_density(gray: np.ndarray) -> float:
    enhanced = cv2.GaussianBlur(gray, (3, 3), 0)
    binary = cv2.adaptiveThreshold(
        enhanced,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        31,
        11,
    )
    num_labels, _, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)

    char_like_components = 0
    for idx in range(1, num_labels):
        x, y, w, h, area = stats[idx]
        if area < 8 or area > 1200:
            continue
        aspect_ratio = w / max(h, 1)
        if 0.15 <= aspect_ratio <= 8.0 and 4 <= h <= 50:
            char_like_components += 1

    frame_area = float(gray.shape[0] * gray.shape[1])
    return float(char_like_components / max(frame_area, 1.0))


def _document_rect_score(gray: np.ndarray) -> float:
    edges = cv2.Canny(gray, 70, 170)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = float(gray.shape[0] * gray.shape[1])

    best = 0.0
    for contour in contours:
        area = cv2.contourArea(contour)
        if area <= 0:
            continue
        area_ratio = area / max(frame_area, 1.0)
        if area_ratio < 0.12 or area_ratio > 0.98:
            continue

        perimeter = cv2.arcLength(contour, True)
        if perimeter <= 0:
            continue

        approx = cv2.approxPolyDP(contour, 0.03 * perimeter, True)
        x, y, w, h = cv2.boundingRect(contour)
        aspect_ratio = w / max(h, 1)

        polygon_score = 1.0 if len(approx) in {4, 5} else 0.45
        aspect_score = 1.0 if 0.5 <= aspect_ratio <= 2.2 else 0.35
        candidate = 0.55 * polygon_score + 0.45 * aspect_score
        best = max(best, candidate)

    return float(round(best, 4))


def _id_document_confidence(id_gray: np.ndarray, id_faces) -> tuple[float, dict]:
    rect_score = _document_rect_score(id_gray)
    text_density = _document_text_density(id_gray)
    text_score = float(np.clip(text_density / 0.00045, 0.0, 1.0))

    face_area_ratio = 0.0
    face_ratio_score = 0.4
    if len(id_faces) > 0:
        _, face_area_ratio = _crop_largest_face(id_gray, id_faces)
        if 0.03 <= face_area_ratio <= 0.42:
            face_ratio_score = 1.0
        elif face_area_ratio <= ID_MAX_FACE_AREA_RATIO:
            face_ratio_score = 0.65
        else:
            face_ratio_score = 0.0

    confidence = float(np.clip(0.45 * rect_score + 0.4 * text_score + 0.15 * face_ratio_score, 0.0, 1.0))
    return round(confidence, 4), {
        "document_rect_score": rect_score,
        "text_density": round(text_density, 6),
        "face_area_ratio": round(face_area_ratio, 4),
    }


def _cosine_similarity(vec_a: np.ndarray, vec_b: np.ndarray) -> float:
    denom = (np.linalg.norm(vec_a) * np.linalg.norm(vec_b)) + 1e-8
    return float(np.dot(vec_a, vec_b) / denom)

  
def _evaluate_identity(session_code: str, gray: np.ndarray, faces) -> dict:
    signature, model_source = _extract_identity_vector(gray, faces)
    if signature is None:
        return {
            "ready": False,
            "similarity": None,
            "mismatch_streak": 0,
            "is_mismatch": False,
            "model_source": model_source,
        }

    face_crop, _ = _crop_largest_face(gray, faces)
    quality_score = _face_quality_score(face_crop)
    if quality_score < FACE_MIN_QUALITY_SCORE:
        return {
            "ready": False,
            "similarity": None,
            "mismatch_streak": 0,
            "is_mismatch": False,
            "quality_score": quality_score,
            "model_source": model_source,
        }

    state = _get_or_create_identity_state(session_code)
    if state.baseline_signature is None or state.baseline_model != model_source:
        state.baseline_signature = signature
        state.baseline_model = model_source
        threshold = FACENET_IDENTITY_SIMILARITY_THRESHOLD if model_source == "hf_facenet" else IDENTITY_SIMILARITY_THRESHOLD
        return {
            "ready": False,
            "similarity": 1.0,
            "mismatch_streak": 0,
            "is_mismatch": False,
            "quality_score": quality_score,
            "model_source": model_source,
            "threshold": threshold,
        }

    threshold = FACENET_IDENTITY_SIMILARITY_THRESHOLD if model_source == "hf_facenet" else IDENTITY_SIMILARITY_THRESHOLD
    similarity = _cosine_similarity(state.baseline_signature, signature)
    is_mismatch = similarity < threshold
    if is_mismatch:
        state.mismatch_streak += 1
    else:
        state.mismatch_streak = 0
        state.baseline_signature = 0.97 * state.baseline_signature + 0.03 * signature

    return {
        "ready": True,
        "similarity": round(similarity, 4),
        "mismatch_streak": state.mismatch_streak,
        "is_mismatch": is_mismatch,
        "quality_score": quality_score,
        "model_source": model_source,
        "threshold": threshold,
    }


def _detect_suspicious_objects(gray: np.ndarray, faces) -> dict:
    masked = gray.copy()
    for (x, y, w, h) in faces:
        pad_w = int(w * 0.25)
        pad_h = int(h * 0.25)
        x1 = max(0, x - pad_w)
        y1 = max(0, y - pad_h)
        x2 = min(masked.shape[1], x + w + pad_w)
        y2 = min(masked.shape[0], y + h + pad_h)
        masked[y1:y2, x1:x2] = 0

    edges = cv2.Canny(masked, 80, 180)
    kernel = np.ones((3, 3), np.uint8)
    edges = cv2.dilate(edges, kernel, iterations=1)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    frame_area = float(gray.shape[0] * gray.shape[1])
    suspicious_count = 0
    for contour in contours:
        area = cv2.contourArea(contour)
        if area <= 0:
            continue
        area_ratio = area / max(frame_area, 1.0)
        if area_ratio < OBJECT_DETECTION_MIN_CONTOUR_AREA_RATIO or area_ratio > OBJECT_DETECTION_MAX_CONTOUR_AREA_RATIO:
            continue

        perimeter = cv2.arcLength(contour, True)
        if perimeter <= 0:
            continue

        approx = cv2.approxPolyDP(contour, 0.04 * perimeter, True)
        x, y, w, h = cv2.boundingRect(contour)
        aspect_ratio = w / max(h, 1)

        rectangle_like = len(approx) in {4, 5, 6}
        handheld_shape = 0.4 <= aspect_ratio <= 0.85
        paper_like_shape = 1.25 <= aspect_ratio <= 1.85

        if rectangle_like and (handheld_shape or paper_like_shape):
            suspicious_count += 1

    edge_density = float(np.count_nonzero(edges)) / max(frame_area, 1.0)
    return {
        "suspicious_count": suspicious_count,
        "edge_density": round(edge_density, 4),
    }


def _landmarks(frame_bgr: np.ndarray):
    frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    with FaceMesh(static_image_mode=True, max_num_faces=1, refine_landmarks=True) as mesh:
        result = mesh.process(frame_rgb)

    multi_face_landmarks = getattr(result, "multi_face_landmarks", None)
    if not multi_face_landmarks:
        return None
    return multi_face_landmarks[0].landmark


def _mean_xy(landmarks, indices: list[int]) -> tuple[float, float]:
    x = sum(landmarks[idx].x for idx in indices) / len(indices)
    y = sum(landmarks[idx].y for idx in indices) / len(indices)
    return x, y


def _iris_eye_ratios(landmarks) -> tuple[float, float]:
    left_iris_x, left_iris_y = _mean_xy(landmarks, LEFT_IRIS)
    right_iris_x, right_iris_y = _mean_xy(landmarks, RIGHT_IRIS)

    left_min_x = min(landmarks[LEFT_EYE_INNER].x, landmarks[LEFT_EYE_OUTER].x)
    left_max_x = max(landmarks[LEFT_EYE_INNER].x, landmarks[LEFT_EYE_OUTER].x)
    right_min_x = min(landmarks[RIGHT_EYE_INNER].x, landmarks[RIGHT_EYE_OUTER].x)
    right_max_x = max(landmarks[RIGHT_EYE_INNER].x, landmarks[RIGHT_EYE_OUTER].x)

    left_w = max(left_max_x - left_min_x, 1e-6)
    right_w = max(right_max_x - right_min_x, 1e-6)

    left_h_ratio = (left_iris_x - left_min_x) / left_w
    right_h_ratio = (right_iris_x - right_min_x) / right_w

    left_min_y = min(landmarks[LEFT_EYE_TOP].y, landmarks[LEFT_EYE_BOTTOM].y)
    left_max_y = max(landmarks[LEFT_EYE_TOP].y, landmarks[LEFT_EYE_BOTTOM].y)
    right_min_y = min(landmarks[RIGHT_EYE_TOP].y, landmarks[RIGHT_EYE_BOTTOM].y)
    right_max_y = max(landmarks[RIGHT_EYE_TOP].y, landmarks[RIGHT_EYE_BOTTOM].y)

    left_h = max(left_max_y - left_min_y, 1e-6)
    right_h = max(right_max_y - right_min_y, 1e-6)

    left_v_ratio = (left_iris_y - left_min_y) / left_h
    right_v_ratio = (right_iris_y - right_min_y) / right_h

    horizontal = float(np.clip((left_h_ratio + right_h_ratio) / 2, 0.0, 1.0))
    vertical = float(np.clip((left_v_ratio + right_v_ratio) / 2, 0.0, 1.0))
    return horizontal, vertical


def _head_pose_ratios(landmarks) -> tuple[float, float]:
    left_eye = landmarks[LEFT_EYE_OUTER]
    right_eye = landmarks[RIGHT_EYE_OUTER]
    nose = landmarks[NOSE_TIP]
    mouth_top = landmarks[MOUTH_TOP]
    mouth_bottom = landmarks[MOUTH_BOTTOM]

    eye_mid_x = (left_eye.x + right_eye.x) / 2
    eye_mid_y = (left_eye.y + right_eye.y) / 2
    eye_distance = abs(right_eye.x - left_eye.x) + 1e-6

    mouth_mid_y = (mouth_top.y + mouth_bottom.y) / 2
    lower_face_h = max(mouth_mid_y - eye_mid_y, 1e-6)

    yaw_ratio = (nose.x - eye_mid_x) / eye_distance
    pitch_ratio = (nose.y - eye_mid_y) / lower_face_h - 0.5
    return float(yaw_ratio), float(pitch_ratio)


def _direction_from_fused(fused_h: float, fused_v: float) -> str:
    if fused_h > HORIZONTAL_THRESHOLD:
        return "looking_right"
    if fused_h < -HORIZONTAL_THRESHOLD:
        return "looking_left"
    if fused_v > VERTICAL_THRESHOLD:
        return "looking_down"
    if fused_v < -VERTICAL_THRESHOLD:
        return "looking_up"
    return "center"


def _state_key(session_code: str, camera_type: str) -> str:
    return f"{session_code}:{camera_type}"


def _get_or_create_state(session_code: str, camera_type: str) -> ProctorTrackState:
    key = _state_key(session_code, camera_type)
    with _track_state_lock:
        state = _track_state.get(key)
        if state is None:
            state = ProctorTrackState()
            _track_state[key] = state
        return state


def _apply_calibration_and_smoothing(
    session_code: str,
    camera_type: str,
    face_count: int,
    horizontal_ratio: float,
    vertical_ratio: float,
    yaw_ratio: float,
    pitch_ratio: float,
) -> dict:
    state = _get_or_create_state(session_code, camera_type)

    if state.baseline_h is None and face_count == 1 and len(state.calibration_h) < CALIBRATION_FRAMES:
        state.calibration_h.append(horizontal_ratio)
        state.calibration_v.append(vertical_ratio)
        if len(state.calibration_h) >= CALIBRATION_FRAMES:
            state.baseline_h = float(np.mean(state.calibration_h))
            state.baseline_v = float(np.mean(state.calibration_v))

    if state.baseline_h is None:
        baseline_h = 0.5
        baseline_v = 0.5
        calibration_in_progress = True
    else:
        assert state.baseline_v is not None
        baseline_h = state.baseline_h
        baseline_v = state.baseline_v
        calibration_in_progress = False

    fused_h = 0.7 * (horizontal_ratio - baseline_h) + 0.3 * yaw_ratio
    fused_v = 0.7 * (vertical_ratio - baseline_v) + 0.3 * pitch_ratio
    state.fused_history.append((fused_h, fused_v))

    smooth_h = float(np.mean([value[0] for value in state.fused_history]))
    smooth_v = float(np.mean([value[1] for value in state.fused_history]))
    direction = _direction_from_fused(smooth_h, smooth_v)

    now = time.monotonic()
    is_offscreen = face_count != 1 or direction != "center"
    if is_offscreen:
        if state.offscreen_start_ts is None:
            state.offscreen_start_ts = now
        offscreen_duration = now - state.offscreen_start_ts
        state.max_offscreen_seconds = max(state.max_offscreen_seconds, offscreen_duration)
    else:
        offscreen_duration = 0.0
        state.offscreen_start_ts = None

    return {
        "direction": direction,
        "smooth_h": smooth_h,
        "smooth_v": smooth_v,
        "baseline_h": baseline_h,
        "baseline_v": baseline_v,
        "calibration_in_progress": calibration_in_progress,
        "calibration_collected": len(state.calibration_h),
        "offscreen_duration": round(offscreen_duration, 3),
        "max_offscreen_duration": round(state.max_offscreen_seconds, 3),
    }


def analyze_frame(session_code: str, camera_type: str, image_base64: str) -> dict:
    frame = _decode_base64_image(image_base64)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    faces = _detect_faces(gray)
    face_count = len(faces)

    gaze_direction = "unknown"
    horizontal_ratio = 0.5
    vertical_ratio = 0.5
    yaw_ratio = 0.0
    pitch_ratio = 0.0

    landmarks = _landmarks(frame) if face_count == 1 else None
    if landmarks is not None:
        horizontal_ratio, vertical_ratio = _iris_eye_ratios(landmarks)
        yaw_ratio, pitch_ratio = _head_pose_ratios(landmarks)

    fused = _apply_calibration_and_smoothing(
        session_code=session_code,
        camera_type=camera_type,
        face_count=face_count,
        horizontal_ratio=horizontal_ratio,
        vertical_ratio=vertical_ratio,
        yaw_ratio=yaw_ratio,
        pitch_ratio=pitch_ratio,
    )
    gaze_direction = fused["direction"]

    identity = {
        "ready": False,
        "similarity": None,
        "mismatch_streak": 0,
        "is_mismatch": False,
        "model_source": "none",
        "threshold": IDENTITY_SIMILARITY_THRESHOLD,
    }
    if camera_type == "primary" and face_count == 1:
        identity = _evaluate_identity(session_code, gray, faces)

    object_detection = {"suspicious_count": 0, "edge_density": 0.0}
    if camera_type == "primary":
        object_detection = _detect_suspicious_objects(gray, faces)

    phone_book_detection = {
        "ok": False,
        "counts": {"cell_phone": 0, "book": 0, "person": 0, "laptop": 0, "monitor": 0},
        "detections": [],
    }
    if camera_type == "primary":
        phone_book_detection = _detect_phone_book_yolo(frame)

    flags: list[str] = []
    severity = "low"

    if face_count == 0:
        flags.append("no_face_detected")
        severity = "high"
    elif face_count > 1:
        flags.append("multiple_faces_detected")
        severity = "high"

    if fused["calibration_in_progress"]:
        flags.append("calibrating_gaze_baseline")

    if gaze_direction in {"looking_left", "looking_right", "looking_up", "looking_down"}:
        flags.append("suspicious_eye_movement")
        severity = "medium" if severity != "high" else severity

    # Head movement detection (best-effort) using normalized yaw/pitch ratios.
    # Keep thresholds conservative to reduce false positives.
    if face_count == 1 and landmarks is not None:
        try:
            if abs(float(yaw_ratio)) > HEAD_YAW_THRESHOLD or abs(float(pitch_ratio)) > HEAD_PITCH_THRESHOLD:
                flags.append("suspicious_head_movement")
                severity = "medium" if severity != "high" else severity
        except Exception:
            pass

    if fused["offscreen_duration"] >= OFFSCREEN_THRESHOLD_SECONDS:
        flags.append("prolonged_offscreen_attention")
        severity = "high"

    if identity["is_mismatch"] and identity["mismatch_streak"] >= IDENTITY_MISMATCH_STREAK_THRESHOLD:
        flags.append("suspicious_candidate_identity_change")
        severity = "high"

    # Contour/edge-based object heuristics are noisy; require stronger evidence.
    # High-confidence object detection is handled by YOLO flags below.
    if object_detection["suspicious_count"] >= 2 or object_detection["edge_density"] >= OBJECT_EDGE_DENSITY_THRESHOLD:
        flags.append("suspicious_object_detected")
        severity = "high" if object_detection["suspicious_count"] >= 2 else ("medium" if severity != "high" else severity)

    if phone_book_detection.get("counts", {}).get("cell_phone", 0) > 0:
        flags.append("cell_phone_detected")
        severity = "high"

    if phone_book_detection.get("counts", {}).get("book", 0) > 0:
        flags.append("book_detected")
        severity = "high" if severity != "high" else severity

    # Expanded object flags (best-effort). These are separate from face detection.
    if phone_book_detection.get("counts", {}).get("person", 0) > 1:
        flags.append("multiple_persons_detected")
        severity = "high"

    if phone_book_detection.get("counts", {}).get("laptop", 0) > 0:
        flags.append("laptop_detected")
        severity = "high" if severity != "high" else severity

    if phone_book_detection.get("counts", {}).get("monitor", 0) > 0:
        flags.append("monitor_detected")
        severity = "high" if severity != "high" else severity

    return {
        "face_count": face_count,
        "gaze": gaze_direction,
        "gaze_horizontal_ratio": round(horizontal_ratio, 4),
        "gaze_vertical_ratio": round(vertical_ratio, 4),
        "head_yaw_ratio": round(yaw_ratio, 4),
        "head_pitch_ratio": round(pitch_ratio, 4),
        "calibration": {
            "in_progress": fused["calibration_in_progress"],
            "collected": fused["calibration_collected"],
            "required": CALIBRATION_FRAMES,
            "baseline_h": round(fused["baseline_h"], 4),
            "baseline_v": round(fused["baseline_v"], 4),
        },
        "fusion": {
            "smooth_h": round(fused["smooth_h"], 4),
            "smooth_v": round(fused["smooth_v"], 4),
            "offscreen_duration": fused["offscreen_duration"],
            "max_offscreen_duration": fused["max_offscreen_duration"],
        },
        "identity": identity,
        "object_detection": object_detection,
        "phone_book_detection": phone_book_detection,
        "flags": flags,
        "severity": severity,
        "score": max(0, 100 - (15 * len([flag for flag in flags if flag != "calibrating_gaze_baseline"]))),
    }


def verify_face_id_match(session_code: str, id_image_base64: str, selfie_image_base64: str) -> dict:
    flags: list[str] = []

    if not id_image_base64 or not id_image_base64.strip():
        flags.append("government_id_not_uploaded")
    if not selfie_image_base64 or not selfie_image_base64.strip():
        flags.append("selfie_not_uploaded")

    if flags:
        with _face_id_lock:
            _face_id_verified_sessions[session_code] = False
        return {
            "verified": False,
            "similarity": None,
            "threshold": FACE_ID_VERIFICATION_THRESHOLD,
            "flags": flags,
            "id_face_count": 0,
            "selfie_face_count": 0,
            "government_id_uploaded": "government_id_not_uploaded" not in flags,
            "id_document_confidence": 0.0,
            "face_quality_score": 0.0,
            "similarity_breakdown": {
                "facenet_similarity": None,
                "histogram_similarity": None,
                "orb_similarity": None,
                "dhash_similarity": None,
                "model_source": "none",
            },
            "id_document_signals": {
                "document_rect_score": 0.0,
                "text_density": 0.0,
                "face_area_ratio": 0.0,
            },
        }

    try:
        id_frame = _decode_base64_image(id_image_base64)
        selfie_frame = _decode_base64_image(selfie_image_base64)
    except Exception:
        with _face_id_lock:
            _face_id_verified_sessions[session_code] = False
        return {
            "verified": False,
            "similarity": None,
            "threshold": FACE_ID_VERIFICATION_THRESHOLD,
            "flags": ["invalid_image_payload"],
            "id_face_count": 0,
            "selfie_face_count": 0,
            "government_id_uploaded": True,
            "id_document_confidence": 0.0,
            "face_quality_score": 0.0,
            "model_source": "none",
            "similarity_breakdown": {
                "facenet_similarity": None,
                "histogram_similarity": None,
                "orb_similarity": None,
                "dhash_similarity": None,
                "model_source": "none",
            },
            "id_document_signals": {
                "document_rect_score": 0.0,
                "text_density": 0.0,
                "face_area_ratio": 0.0,
            },
        }

    id_gray = cv2.cvtColor(id_frame, cv2.COLOR_BGR2GRAY)
    selfie_gray = cv2.cvtColor(selfie_frame, cv2.COLOR_BGR2GRAY)

    id_faces = _detect_faces(id_gray)
    selfie_faces = _detect_faces(selfie_gray)

    id_document_confidence, id_document_signals = _id_document_confidence(id_gray, id_faces)
    if id_document_confidence < ID_DOCUMENT_CONFIDENCE_THRESHOLD:
        flags.append("uploaded_image_not_government_id_like")

    if len(id_faces) == 0:
        flags.append("id_face_not_detected")
    elif len(id_faces) > 1:
        flags.append("multiple_faces_in_id")

    if len(selfie_faces) == 0:
        flags.append("selfie_face_not_detected")
    elif len(selfie_faces) > 1:
        flags.append("multiple_faces_in_selfie")

    id_face_crop, id_face_area_ratio = _crop_largest_face(id_gray, id_faces)
    selfie_face_crop, _ = _crop_largest_face(selfie_gray, selfie_faces)
    face_quality_score = min(_face_quality_score(id_face_crop), _face_quality_score(selfie_face_crop))

    if id_face_area_ratio > ID_MAX_FACE_AREA_RATIO:
        flags.append("id_image_appears_like_selfie")

    similarity = None
    verified = False
    verification_threshold = FACE_ID_VERIFICATION_THRESHOLD
    similarity_breakdown = {
        "facenet_similarity": None,
        "histogram_similarity": None,
        "orb_similarity": None,
        "dhash_similarity": None,
        "model_source": "none",
    }

    if not flags:
        combined_similarity, component_scores = _face_similarity_components(id_gray, id_faces, selfie_gray, selfie_faces)
        similarity_breakdown = component_scores
        if combined_similarity is None:
            flags.append("face_signature_generation_failed")
        else:
            similarity = round(float(combined_similarity), 4)
            if similarity_breakdown.get("model_source") == "hf_facenet":
                verification_threshold = FACENET_IDENTITY_SIMILARITY_THRESHOLD
            verified = similarity >= verification_threshold
            if not verified:
                flags.append("face_id_mismatch")

    if face_quality_score < FACE_MIN_QUALITY_SCORE:
        verified = False
        if "low_face_quality" not in flags:
            flags.append("low_face_quality")

    if id_document_confidence < ID_DOCUMENT_CONFIDENCE_THRESHOLD:
        verified = False

    with _face_id_lock:
        _face_id_verified_sessions[session_code] = verified

    return {
        "verified": verified,
        "similarity": similarity,
        "threshold": verification_threshold,
        "flags": flags,
        "id_face_count": len(id_faces),
        "selfie_face_count": len(selfie_faces),
        "government_id_uploaded": True,
        "id_document_confidence": id_document_confidence,
        "face_quality_score": round(face_quality_score, 4),
        "model_source": similarity_breakdown.get("model_source", "none"),
        "similarity_breakdown": similarity_breakdown,
        "id_document_signals": id_document_signals,
    }


def detect_audio_anomaly(rms_value: float, threshold: float = 0.045) -> dict:
    is_anomaly = rms_value >= threshold
    return {
        "audio_rms": round(rms_value, 6),
        "threshold": threshold,
        "is_anomaly": is_anomaly,
        "severity": "medium" if is_anomaly else "low",
        "event_type": "audio_noise_detected" if is_anomaly else "audio_ok",
    }


def register_secondary_stream(session_code: str, pairing_token: str) -> dict:
    with _secondary_lock:
        _secondary_streams[session_code] = SecondaryStreamState(pairing_token=pairing_token)
    return {"ok": True}


def get_secondary_stream_status(session_code: str, pairing_token: str) -> dict:
    with _secondary_lock:
        stream = _secondary_streams.get(session_code)
        if not stream or stream.pairing_token != pairing_token:
            return {
                "connected": False,
                "frames_received": 0,
                "last_seen_at": None,
                "latest_flags": [],
                "is_stale": True,
                "last_seen_age_seconds": None,
                "blocking_flags": [],
            }

        now = datetime.now(timezone.utc)
        last_seen_age_seconds = None
        if stream.last_seen_at is not None:
            last_seen_age_seconds = float((now - stream.last_seen_at).total_seconds())
        is_stale = (last_seen_age_seconds is None) or (last_seen_age_seconds > SECONDARY_STALE_SECONDS)

        blocking_flag_set = {
            "secondary_portrait_view_detected",
            "secondary_camera_too_close_reduce_background_visibility",
            "secondary_feed_possibly_frozen",
            "secondary_low_light",
            "secondary_blurry_or_occluded",
        }
        blocking_flags = [flag for flag in stream.latest_flags if flag in blocking_flag_set]

        return {
            "connected": stream.frames_received > 0 and not is_stale,
            "frames_received": stream.frames_received,
            "last_seen_at": stream.last_seen_at,
            "latest_flags": stream.latest_flags,
            "is_stale": is_stale,
            "last_seen_age_seconds": None if last_seen_age_seconds is None else round(last_seen_age_seconds, 2),
            "blocking_flags": blocking_flags,
        }


def analyze_secondary_environment_frame(session_code: str, pairing_token: str, image_base64: str) -> dict:
    frame = _decode_base64_image(image_base64)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    frame_height, frame_width = gray.shape
    brightness = float(np.mean(gray))
    blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    faces = _detect_faces(gray)
    face_count = len(faces)

    with _secondary_lock:
        stream = _secondary_streams.get(session_code)
        if not stream or stream.pairing_token != pairing_token:
            raise ValueError("Secondary camera pairing is invalid or expired")

        if stream.previous_gray is None:
            motion_score = 100.0
            stream.low_motion_streak = 0
        else:
            frame_diff = cv2.absdiff(gray, stream.previous_gray)
            motion_score = float(np.mean(frame_diff))
            if motion_score < 1.5:
                stream.low_motion_streak += 1
            else:
                stream.low_motion_streak = 0

        stream.previous_gray = gray
        stream.frames_received += 1
        stream.last_seen_at = datetime.now(timezone.utc)

    flags: list[str] = []
    severity = "low"

    if brightness < 28:
        flags.append("secondary_low_light")
        severity = "medium"
    if frame_height > frame_width:
        flags.append("secondary_portrait_view_detected")
        severity = "medium" if severity != "high" else severity
    if blur_score < 40:
        flags.append("secondary_blurry_or_occluded")
        severity = "medium" if severity != "high" else severity
    if face_count == 1:
        x, y, w, h = max(faces, key=lambda box: box[2] * box[3])
        face_area_ratio = float((w * h) / max(frame_width * frame_height, 1))
        if face_area_ratio > 0.28:
            flags.append("secondary_camera_too_close_reduce_background_visibility")
            severity = "medium" if severity != "high" else severity
    if face_count > 1:
        flags.append("secondary_multiple_faces_detected")
        severity = "high"
    if face_count == 0:
        flags.append("secondary_no_person_visible")
    if stream.low_motion_streak >= 8:
        flags.append("secondary_feed_possibly_frozen")
        severity = "high"

    with _secondary_lock:
        stream = _secondary_streams.get(session_code)
        if stream:
            stream.latest_flags = flags

    return {
        "brightness": round(brightness, 2),
        "blur_score": round(blur_score, 2),
        "motion_score": round(motion_score, 2),
        "face_count": face_count,
        "flags": flags,
        "severity": severity,
    }
