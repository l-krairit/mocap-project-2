/**
 * GestureController — MediaPipe Tasks Vision gesture recognizer + custom gestures.
 *
 * Built-in gestures used:
 *   Open_Palm  → stop
 *   Pointing_Up → speed up
 *   Victory    → shuffle toggle
 *   ILoveYou   → like (finger heart)
 *   Closed_Fist + vertical movement → volume up/down
 *
 * Custom landmark-based gestures:
 *   OK          → play/pause  (thumb-index pinch, other fingers extended)
 *   Pointing_Down → speed down (index tip below MCP, others curled)
 *   Gun_Right    → skip (RH) / +15s (LH)
 *   Gun_Left     → rewind (RH) / -15s (LH)
 */

import {
  GestureRecognizer,
  FilesetResolver,
  DrawingUtils,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

// Hand landmark indices
const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9,  MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP:   13, RING_PIP:   14, RING_DIP:   15, RING_TIP:   16,
  PINKY_MCP:  17, PINKY_PIP:  18, PINKY_DIP:  19, PINKY_TIP:  20,
};

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

export class GestureController extends EventTarget {
  #recognizer = null;
  #drawUtils  = null;
  #running    = false;

  // Separate timestamps so volume and discrete gestures never block each other
  #lastActionTime = 0;   // governs discrete gestures only
  #lastVolumeTime = 0;   // governs volume nudges only
  // Per-hand wrist Y history for volume knob detection
  #wristYHistory = new Map();

  static GLOBAL_COOLDOWN = 1800;  // ms between discrete gesture triggers
  static VOLUME_COOLDOWN = 300;   // ms between volume nudges (fist movement)

  constructor(videoEl, canvasEl) {
    super();
    this.video  = videoEl;
    this.canvas = canvasEl;
    this.ctx    = canvasEl.getContext('2d');
  }

  async initialize() {
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    this.#recognizer = await GestureRecognizer.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.5,
    });
    this.#drawUtils = new DrawingUtils(this.ctx);
    return this;
  }

  async startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = stream;
    await new Promise(r => this.video.addEventListener('loadeddata', r, { once: true }));
    this.#running = true;
    this.#loop();
  }

  stop() {
    this.#running = false;
    this.video.srcObject?.getTracks().forEach(t => t.stop());
  }

  // ── Frame loop ─────────────────────────────────────────────
  #loop() {
    if (!this.#running) return;

    const now = performance.now();

    // Sync canvas size
    if (this.canvas.width !== this.video.videoWidth) {
      this.canvas.width  = this.video.videoWidth;
      this.canvas.height = this.video.videoHeight;
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    let results;
    try {
      results = this.#recognizer.recognizeForVideo(this.video, now);
    } catch {
      requestAnimationFrame(() => this.#loop());
      return;
    }

    // Draw landmarks on top of (already CSS-mirrored) canvas
    if (results.landmarks?.length) {
      for (const lms of results.landmarks) {
        this.#drawUtils.drawConnectors(lms, GestureRecognizer.HAND_CONNECTIONS, {
          color: '#00d4ff', lineWidth: 2,
        });
        this.#drawUtils.drawLandmarks(lms, {
          color: '#ff0099', lineWidth: 1, radius: 3,
        });
      }
    }

    if (results.gestures?.length) {
      // Clear stale wrist history for hands no longer visible
      const activeHandCount = results.gestures.length;
      for (const key of this.#wristYHistory.keys()) {
        if (key >= activeHandCount) this.#wristYHistory.delete(key);
      }

      // Collect all hands then emit one frameUpdate
      const hands = [];
      results.gestures.forEach((gestures, i) => {
        const builtIn   = gestures[0]?.categoryName ?? 'None';
        const handLabel = results.handedness[i]?.[0]?.categoryName ?? 'Right';
        const landmarks = results.landmarks[i];
        if (!landmarks) return;

        const gesture = this.#classify(builtIn, landmarks);
        hands.push({ gesture, handedness: handLabel });
        this.#route(gesture, handLabel, i, landmarks);
      });
      this.#dispatch('frameUpdate', { hands });
    } else {
      this.#wristYHistory.clear();
      this.#dispatch('frameUpdate', { hands: [] });
    }

    requestAnimationFrame(() => this.#loop());
  }

  // ── Custom gesture classifier ──────────────────────────────
  #classify(builtIn, l) {
    const thumbTip  = l[LM.THUMB_TIP];
    const wrist     = l[LM.WRIST];
    const indexTip  = l[LM.INDEX_TIP];
    const indexPip  = l[LM.INDEX_PIP];
    const indexMcp  = l[LM.INDEX_MCP];
    const middleTip = l[LM.MIDDLE_TIP];
    const middlePip = l[LM.MIDDLE_PIP];
    const ringTip   = l[LM.RING_TIP];
    const ringPip   = l[LM.RING_PIP];
    const pinkyTip  = l[LM.PINKY_TIP];
    const pinkyPip  = l[LM.PINKY_PIP];

    const middleExt = middleTip.y < middlePip.y - 0.03;
    const ringExt   = ringTip.y  < ringPip.y  - 0.03;
    const pinkyExt  = pinkyTip.y < pinkyPip.y - 0.03;
    const middleCurl = middleTip.y > middlePip.y;
    const ringCurl   = ringTip.y  > ringPip.y;
    const pinkyCurl  = pinkyTip.y > pinkyPip.y;
    const indexCurl  = indexTip.y > indexPip.y;

    const tIDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);

    // Index direction vector (MCP → TIP) — works regardless of hand orientation
    const idxVecX = indexTip.x - indexMcp.x;
    const idxVecY = indexTip.y - indexMcp.y;
    const idxLen  = Math.hypot(idxVecX, idxVecY);
    // Index is pointing down when the normalised Y component is strongly positive (downward in image)
    const indexPointingDown = idxLen > 0.07 && (idxVecY / idxLen) > 0.6;

    // OK gesture: tight thumb-index pinch + middle/ring/pinky clearly extended upward
    if (tIDist < 0.06 && middleExt && ringExt && pinkyExt && !indexPointingDown) return 'OK';

    // Pointing down: index direction is downward + other fingers folded close to their MCPs
    // Using tip-to-MCP distance avoids Y-axis assumptions when the hand is rotated
    const middleFolded = Math.hypot(middleTip.x - l[LM.MIDDLE_MCP].x, middleTip.y - l[LM.MIDDLE_MCP].y) < 0.18;
    const ringFolded   = Math.hypot(ringTip.x   - l[LM.RING_MCP].x,   ringTip.y   - l[LM.RING_MCP].y)   < 0.18;
    const pinkyFolded  = Math.hypot(pinkyTip.x  - l[LM.PINKY_MCP].x,  pinkyTip.y  - l[LM.PINKY_MCP].y)  < 0.18;
    if (indexPointingDown && middleFolded && ringFolded && pinkyFolded) return 'Pointing_Down';

    // "Gun" pose (for LH seek): index clearly horizontal + thumb up + other fingers folded
    const idxNormX = idxLen > 0 ? idxVecX / idxLen : 0;
    const indexHorizontal = idxLen > 0.09 && Math.abs(idxNormX) > 0.78;
    const thumbUp = thumbTip.y < Math.min(l[LM.THUMB_IP].y, l[LM.THUMB_MCP].y) - 0.02;
    if (indexHorizontal && thumbUp && middleFolded && ringFolded && pinkyFolded) {
      // Raw camera coordinates are not mirrored. Pointing right (user perspective)
      // appears as negative X direction in the frame.
      return idxNormX < 0 ? 'Gun_Right' : 'Gun_Left';
    }

    // Thumb left / right: all fingers curled, thumb extended horizontally
    if (indexCurl && middleCurl && ringCurl && pinkyCurl) {
      const dx = thumbTip.x - wrist.x;   // raw camera coords
      const dy = Math.abs(thumbTip.y - wrist.y);
      // Thumb must be clearly horizontal (|dx| > |dy|) and extended far enough
      if (Math.abs(dx) > dy && Math.abs(dx) > 0.10) {
        // Raw camera: user's right hand, thumb right → thumb appears to camera's LEFT → dx < 0
        // (The canvas is CSS-mirrored so visually it shows correctly)
        return dx < 0 ? 'Thumb_Right' : 'Thumb_Left';
      }
    }

    return builtIn;
  }

  // ── Gesture → action routing ───────────────────────────────
  #route(gesture, handedness, handIdx, landmarks) {
    if (!gesture || gesture === 'None' || gesture === 'Unknown') return;

    // MediaPipe Tasks Vision reports handedness from person's perspective.
    // 'Right' = user's right hand.
    const isRight = handedness === 'Right';
    const now = Date.now();

    // ── Continuous: Closed fist + horizontal wrist movement = volume ──
    // Raw camera coords: fist right (user's right, mirrored) → dx < 0 → volume up
    //                    fist left  (user's left,  mirrored) → dx > 0 → volume down
    if (gesture === 'Closed_Fist') {
      const wristX = landmarks[LM.WRIST].x;
      const prev   = this.#wristYHistory.get(handIdx);
      if (prev !== undefined) {
        const dx = wristX - prev;
        if (now - this.#lastVolumeTime > GestureController.VOLUME_COOLDOWN) {
          if (dx < -0.012) {
            this.#lastVolumeTime = now;
            this.#fire('volume_up', gesture, handedness);
          } else if (dx > 0.012) {
            this.#lastVolumeTime = now;
            this.#fire('volume_down', gesture, handedness);
          }
        }
      }
      this.#wristYHistory.set(handIdx, wristX);
      return;
    }
    this.#wristYHistory.delete(handIdx);

    // ── Discrete gestures: one action per GLOBAL_COOLDOWN window ──
    if (now - this.#lastActionTime < GestureController.GLOBAL_COOLDOWN) return;

    let action = null;
    switch (gesture) {
      case 'Open_Palm':    action = 'stop';        break;
      case 'OK':           action = 'play';        break;
      case 'Pointing_Up':  action = 'speed_up';    break;
      case 'Pointing_Down':action = 'speed_down';  break;
      case 'Victory':      action = 'shuffle';     break;
      case 'ILoveYou':     action = 'like';        break;
      case 'Thumb_Right':  action = null;                              break;
      case 'Thumb_Left':   action = null;                              break;
      case 'Gun_Right':    action = isRight ? 'skip' : 'seek_forward';  break;
      case 'Gun_Left':     action = isRight ? 'rewind' : 'seek_backward'; break;
    }

    if (action) {
      this.#lastActionTime = now;
      this.#fire(action, gesture, handedness);
    }
  }

  #fire(action, gesture, handedness) {
    this.#dispatch('gesture', { action, gesture, handedness });
  }

  #dispatch(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
