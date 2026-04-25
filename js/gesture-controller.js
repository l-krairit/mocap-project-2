/**
 * GestureController — MediaPipe Tasks Vision gesture recognizer + custom gestures.
 *
 * Built-in gestures used:
 *   Open_Palm  → stop
 *   Victory    → shuffle toggle
 *   ILoveYou   → like (finger heart)
 *   Closed_Fist (RH) + vertical movement → volume up/down
 *
 * Custom landmark-based gestures:
 *   OK          → play/pause  (thumb-index pinch, other fingers extended)
 *   Pointing_Up (both hands)   → speed up
 *   Pointing_Down (both hands) → speed down
 *   Gun_Right    → RH: skip, LH: +15s (index pointing right + thumb up + M/R/P curled)
 *   Gun_Left     → RH: rewind, LH: -15s (index pointing left + thumb up + M/R/P curled)
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

  // Separate timestamps so continuous and discrete gestures never block each other
  #lastActionTime = 0;   // governs discrete gestures only
  #lastVolumeTime = 0;   // governs volume nudges (RH fist)
  #lastSpeedTime  = 0;   // governs speed nudges  (both hands pointing)
  #lastFistTime   = 0;   // suppresses Open_Palm→stop during fist transitions
  // Per-hand wrist X history for fist-movement detection
  #wristYHistory = new Map();

  static GLOBAL_COOLDOWN = 1800;  // ms between discrete gesture triggers
  static VOLUME_COOLDOWN = 1200;  // ms between volume nudges (fist movement)
  static SPEED_COOLDOWN  = 1200;  // ms between speed nudges  (both hands pointing)

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
        hands.push({ gesture, handedness: handLabel, landmarks });
        this.#route(gesture, handLabel, i, landmarks);
      });

      this.#routeTwoHandSpeed(hands);
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
    const thumbMcp  = l[LM.THUMB_MCP];
    const thumbIp   = l[LM.THUMB_IP];
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
    const indexPointingUp = idxLen > 0.07 && (idxVecY / idxLen) < -0.6;
    // Index is pointing down when the normalised Y component is strongly positive (downward in image)
    const indexPointingDown = idxLen > 0.07 && (idxVecY / idxLen) > 0.6;

    // OK gesture: tight thumb-index pinch + middle/ring/pinky clearly extended upward
    if (tIDist < 0.06 && middleExt && ringExt && pinkyExt && !indexPointingDown) return 'OK';

    // Pointing down: index direction is downward + other fingers folded close to their MCPs
    // Using tip-to-MCP distance avoids Y-axis assumptions when the hand is rotated
    const middleFolded = Math.hypot(middleTip.x - l[LM.MIDDLE_MCP].x, middleTip.y - l[LM.MIDDLE_MCP].y) < 0.18;
    const ringFolded   = Math.hypot(ringTip.x   - l[LM.RING_MCP].x,   ringTip.y   - l[LM.RING_MCP].y)   < 0.18;
    const pinkyFolded  = Math.hypot(pinkyTip.x  - l[LM.PINKY_MCP].x,  pinkyTip.y  - l[LM.PINKY_MCP].y)  < 0.18;
    if (indexPointingUp && middleFolded && ringFolded && pinkyFolded) return 'Pointing_Up';
    if (indexPointingDown && middleFolded && ringFolded && pinkyFolded) return 'Pointing_Down';

    // Gun gesture: index pointing horizontally, thumb up, M/R/P curled
    // idxVecX < 0 → tip is left of MCP in camera space = user's right direction
    const thumbUp = thumbTip.y < wrist.y - 0.06;
    const indexHorizontal = idxLen > 0.09 && Math.abs(idxVecX) > Math.abs(idxVecY) * 1.2;
    if (thumbUp && indexHorizontal && middleCurl && ringCurl && pinkyCurl) {
      return idxVecX < 0 ? 'Gun_Right' : 'Gun_Left';
    }

    // Thumb up / down / left / right: all fingers curled, thumb clearly extended + oriented
    if (indexCurl && middleCurl && ringCurl && pinkyCurl) {
      const dx = thumbTip.x - wrist.x; // raw camera coords
      const dy = thumbTip.y - wrist.y;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);

      const thumbVecX = thumbTip.x - thumbMcp.x;
      const thumbVecY = thumbTip.y - thumbMcp.y;
      const thumbLen = Math.hypot(thumbVecX, thumbVecY);
      const thumbExtended = thumbLen > 0.11;
      const thumbFarFromPalm = Math.hypot(thumbTip.x - wrist.x, thumbTip.y - wrist.y)
        > Math.hypot(thumbMcp.x - wrist.x, thumbMcp.y - wrist.y) + 0.02;
      const thumbSegmentStraight = Math.hypot(thumbTip.x - thumbIp.x, thumbTip.y - thumbIp.y) > 0.05;

      if (!(thumbExtended && thumbFarFromPalm && thumbSegmentStraight)) {
        return builtIn;
      }

      // Vertical thumbs for LH speed controls
      if (ady > adx * 1.15 && ady > 0.10) {
        return dy < -0.03 ? 'Thumb_Up' : dy > 0.03 ? 'Thumb_Down' : builtIn;
      }

      // Horizontal thumbs remain available for readout/debugging
      if (adx > ady * 1.15 && adx > 0.10) {
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

    // ── Continuous: Closed fist + vertical wrist movement (RH volume only) ──
    // Image Y increases downward: fist moves up → dy < 0 → up
    //                             fist moves down → dy > 0 → down
    if (gesture === 'Closed_Fist') {
      const wristY = landmarks[LM.WRIST].y;
      const prev   = this.#wristYHistory.get(handIdx);
      if (prev !== undefined) {
        const dy = wristY - prev;
        if (isRight && now - this.#lastVolumeTime > GestureController.VOLUME_COOLDOWN) {
          if (dy < -0.012) { this.#lastVolumeTime = now; this.#fire('volume_up',   gesture, handedness); }
          else if (dy > 0.012) { this.#lastVolumeTime = now; this.#fire('volume_down', gesture, handedness); }
        }
      }
      this.#lastFistTime = now;
      this.#wristYHistory.set(handIdx, wristY);
      return;
    }
    this.#wristYHistory.delete(handIdx);

    // ── Discrete gestures: one action per GLOBAL_COOLDOWN window ──
    if (now - this.#lastActionTime < GestureController.GLOBAL_COOLDOWN) return;

    let action = null;
    switch (gesture) {
      case 'Open_Palm':    if (now - this.#lastFistTime > 1000) action = 'stop'; break;
      case 'OK':           action = 'play';        break;
      case 'Victory':      action = 'shuffle';     break;
      case 'ILoveYou':     action = 'like';        break;
      case 'Gun_Right':    action = isRight ? 'skip' : 'seek_forward';   break;
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

  #routeTwoHandSpeed(hands) {
    if (hands.length < 2) return;

    const left = hands.find(h => h.handedness === 'Left');
    const right = hands.find(h => h.handedness === 'Right');
    if (!left || !right) return;

    const now = Date.now();
    if (now - this.#lastSpeedTime <= GestureController.SPEED_COOLDOWN) return;

    if (left.gesture === 'Pointing_Up' && right.gesture === 'Pointing_Up') {
      this.#lastSpeedTime = now;
      this.#fire('speed_up', 'Pointing_Up', 'Both');
      return;
    }

    if (left.gesture === 'Pointing_Down' && right.gesture === 'Pointing_Down') {
      this.#lastSpeedTime = now;
      this.#fire('speed_down', 'Pointing_Down', 'Both');
    }
  }

  #dispatch(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
