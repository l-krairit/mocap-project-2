# GestureBeats

GestureBeats is a browser-based DJ controller that combines webcam gesture recognition, a custom audio library, and an animated turntable-style interface. The app is built from three main parts:

- `js/gesture-controller.js` handles camera access, MediaPipe gesture recognition, custom landmark-based gesture classification, and gesture-to-action routing.
- `js/music-player.js` manages audio playback, library state, playback speed, volume, shuffle, liking tracks, seeking, and cover-art extraction.
- `js/app.js` connects the gesture layer to the player and updates the UI.

The visual layout lives in `index.html` and `css/style.css`.

## Setup & Run

The app runs entirely in the browser. You can open `index.html` directly, but using a local static server is recommended (some browsers restrict module/WASM loading from the file:// protocol).

- Quick open: double-click `index.html` or open it from your browser.

- Recommended — start a local server and open http://localhost:8000:

  - With Python 3 (works on Windows/macOS/Linux):

    ```bash
    # from project root
    python -m http.server 8000
    ```

    or (Windows) if you need the `py` launcher:

    ```bash
    py -3 -m http.server 8000
    ```

  - With Node (no install required):

    ```bash
    npx http-server -c-1 -p 8000
    ```

  - From VS Code: install and run the "Live Server" extension on the project folder.

After the server is running, open http://localhost:8000 in your browser and grant webcam permission when prompted. If audio playback is blocked, interact with the page (click Play) to satisfy browser autoplay policies.

Supported browsers: recent Chrome, Edge, and Firefox releases. Localhost serves as a secure origin for getUserMedia and MediaPipe assets.

## System Overview

The application runs entirely in the browser. It does not require a backend or database.

### Data Sources

The program uses two kinds of audio sources:

- Built-in demo tracks from the local `audios/` folder:
  - Between The Bars - Elliott Smith
  - Fallen Down - Toby Fox
  - High and Dry - Radiohead
  - Coming Up Roses - Harry Styles
  - Sodium Chloride - Panchiko
- User-added local audio files selected through the file picker or dropped into the drop zone.

Gesture recognition uses the MediaPipe Tasks Vision Gesture Recognizer model loaded from a remote URL, together with the MediaPipe WASM runtime.

### Landmark and Gesture Model Source

The gesture system relies on the 21-hand-landmark hand model exposed by MediaPipe. The code uses these landmark indices:

- Wrist
- Thumb CMC, MCP, IP, TIP
- Index MCP, PIP, DIP, TIP
- Middle MCP, PIP, DIP, TIP
- Ring MCP, PIP, DIP, TIP
- Pinky MCP, PIP, DIP, TIP

The built-in recognizer provides coarse gesture labels such as `Open_Palm`, `Closed_Fist`, `Victory`, and `ILoveYou`. The app then layers custom logic on top of the landmarks to detect gestures that the base model does not directly provide, such as `OK`, `Pointing_Up`, `Pointing_Down`, `Gun_Right`, `Gun_Left`, and thumb orientation variants.

## Program Flow

1. `index.html` loads the interface and imports `js/app.js` as a module.
2. `app.js` creates a `MusicPlayer`, wires event listeners, registers button handlers, and sets up search, drag-and-drop, and timeline seeking.
3. `app.js` creates a `GestureController`, initializes the MediaPipe recognizer, and starts the camera stream.
4. On every processed camera frame, `gesture-controller.js`:
   - runs MediaPipe recognition,
   - draws landmarks on the overlay canvas,
   - classifies the current hand pose,
   - emits per-frame readout events,
   - emits action events when a gesture matches a supported command.
5. `app.js` listens for those events and calls methods on `MusicPlayer`.
6. `MusicPlayer` updates audio playback and emits state events.
7. `app.js` responds to those state events by updating the UI: track title, art, progress bar, speed, shuffle, liked state, turntable animation, and status text.

## Main UI Areas

The interface is split into three columns:

- Left panel: song library, search, liked songs.
- Center panel: turntable, track metadata, timeline, transport controls, volume, visualizer, and gesture guide.
- Right panel: webcam preview, drawn gesture landmarks, live hand readout, last detected gesture, and audio drop zone.

The layout is intentionally DJ-themed rather than a generic media player. The spinning vinyl, tonearm animation, mono-style meters, and neon-like accents are purely presentational and are driven by player state.

## Logic Description

### `app.js` Orchestration Layer

`app.js` is the application coordinator. It owns the DOM references, binds events, and translates user or gesture intent into player actions.

#### Startup Sequence

When the app starts, it:

- sets the status indicator to loading,
- loads the built-in song list into the player,
- attaches player event handlers,
- attaches UI button and search handlers,
- configures drag-and-drop for audio files,
- starts the animated visualizer loop,
- creates and initializes the gesture controller,
- requests webcam access and starts live recognition.

#### Gesture-to-Action Mapping

When the gesture controller emits a `gesture` event, `app.js` maps actions as follows:

- `play` → toggle play/pause
- `stop` → stop playback
- `skip` → skip to the next track
- `rewind` → rewind or go to the previous track
- `speed_up` / `speed_down` → adjust playback speed by 0.25x
- `volume_up` / `volume_down` → nudge volume by 0.03
- `shuffle` → toggle shuffle mode
- `like` → like or unlike the current track
- `seek_forward` / `seek_backward` → jump by 15 seconds

The app also listens to `frameUpdate` events to show the current gesture detected on each hand, even when no command is triggered.

#### UI Synchronization

The player state drives the visible controls:

- `stateChanged` updates the play button, tonearm animation, turntable spinning state, and current track details.
- `volumeChanged` updates the volume bar and clamps visual feedback at 0% and 100%.
- `speedChanged` updates the displayed playback rate.
- `shuffleChanged` updates both shuffle labels.
- `likedChanged` refreshes the liked-song list and liked badge.
- `timeupdate` updates current time, total time, and timeline progress.
- `artworkLoaded` swaps in album art when metadata extraction succeeds.

### `gesture-controller.js` Recognition Layer

This module is responsible for webcam ingestion, MediaPipe recognition, custom gesture classification, and rate limiting.

#### MediaPipe Setup

The controller uses `@mediapipe/tasks-vision` through the CDN bundle. It downloads:

- a WASM runtime from the Tasks Vision package,
- the gesture recognizer task model from Google Cloud Storage.

It configures the recognizer for:

- video mode,
- up to two hands,
- fairly strict detection and tracking thresholds.

#### Frame Loop

Each frame the controller:

- synchronizes the overlay canvas size with the webcam stream,
- clears the drawing surface,
- runs recognition on the current video frame,
- draws hand landmarks and connectors,
- classifies each detected hand pose,
- emits a per-frame hand summary,
- routes recognized gestures to actions with cooldown protection.

#### Custom Classification Strategy

The recognizer’s raw labels are not treated as the final answer. The controller derives extra gestures from landmark geometry so the app can support more expressive controls.

The key design choices are:

- use normalized landmark distances and directions instead of absolute pixel locations,
- compare fingertip positions to PIP and MCP joints to determine extension or curl,
- use directional vectors for gestures like pointing and gun pose so the logic remains more robust to hand rotation,
- separate discrete gestures from continuous gestures so volume and speed nudges do not block taps like play, skip, or like.

#### Gesture Rules

The controller recognizes these behaviors:

- `Closed_Fist` on the right hand with vertical wrist movement controls volume.
- `OK` gesture maps to play/pause.
- Both hands `Pointing_Up` map to speed up.
- Both hands `Pointing_Down` map to speed down.
- `Victory` maps to shuffle.
- `ILoveYou` maps to like.
- `Open_Palm` maps to stop, but only after a short post-fist delay to avoid accidental stop triggers during transitions.
- `Gun_Right` and `Gun_Left` are routed differently depending on which hand performs them.
  - Right hand: skip / rewind.
  - Left hand: seek forward / seek backward.

#### Cooldowns and Debouncing

The controller intentionally throttles gesture firing:

- `GLOBAL_COOLDOWN` prevents repeated discrete actions from firing too rapidly.
- `VOLUME_COOLDOWN` limits repeated volume nudges.
- `SPEED_COOLDOWN` limits repeated speed nudges.
- `#lastFistTime` prevents an `Open_Palm` stop from immediately firing as the user opens the hand after a fist.

This design avoids command storms when the camera reports the same pose across many consecutive frames.

### `music-player.js` Playback Layer

The music player owns audio playback, playlist state, metadata extraction, and playback events.

#### Audio Engine

Playback is handled by a single `HTMLAudioElement`, plus a lazy-created Web Audio graph:

- `AudioContext`
- `MediaElementSource`
- `GainNode`
- `AnalyserNode`

The AudioContext is created lazily because browsers usually require a user gesture before audio playback or context resume is allowed.

#### Library Management

The player keeps an in-memory song array and supports:

- adding built-in songs,
- adding local files,
- selecting and playing a track by index,
- random playback when shuffle is enabled,
- preserving liked-song state as a set of track indexes.

Local files are normalized into simple track objects containing name, artist, URL, file reference, and artwork.

#### Playback Operations

Supported player operations include:

- play / pause / toggle play
- stop
- skip to next track
- rewind to the beginning or previous track
- seek by seconds
- seek to a fraction of track duration
- set and nudge volume
- set and nudge speed
- toggle shuffle
- toggle like state

#### Metadata and Album Art

The player tries to load cover art for both built-in and local songs.

Its strategy is:

- fetch the audio blob,
- try `music-metadata-browser` first,
- fall back to a manual MP3 ID3/APIC parser if needed,
- create an object URL for the extracted image,
- update the UI when artwork becomes available.

This is why some songs can show artwork even when they were added locally.

#### Event Model

The player emits custom events so the UI can stay decoupled from playback internals:

- `stateChanged`
- `volumeChanged`
- `speedChanged`
- `shuffleChanged`
- `likedChanged`
- `libraryChanged`
- `artworkLoaded`
- `timeupdate`
- `metadataLoaded`

## Why These Design Choices Were Made

The code favors a separation of concerns:

- gesture recognition is isolated from playback logic,
- playback logic is isolated from UI rendering,
- the UI only reacts to events and does not directly inspect raw gesture frames.

That separation makes the system easier to extend. For example, adding a new gesture only requires changes in `gesture-controller.js` and one mapping in `app.js`, not a rewrite of the player or HTML structure.

The gesture system also uses cooldowns and multi-frame signals rather than one-frame triggers because webcam gesture detection is noisy. A single ambiguous frame should not instantly trigger a destructive command like stop or rewind.

The use of normalized landmark comparisons instead of pixel thresholds makes the gesture logic more portable across different webcam resolutions and camera placements.

## Limitations

This system is useful as an interactive demo, but it is not a production-grade gesture controller.

### Gesture Recognition Limits

- The app depends on webcam quality, lighting, framing, and hand visibility.
- Fast hand motion can cause missed detections or unstable gesture labels.
- Some poses may be misclassified when the hand is rotated, partially occluded, or near the edge of the frame.
- The app only handles two hands, so additional hands are ignored.
- Continuous gestures like volume control depend on wrist movement being visible over multiple frames.

### Control Ambiguity

- Some gestures are intentionally overloaded with context, such as `Gun_Right` meaning different actions depending on whether the hand is left or right.
- `Open_Palm` and `Closed_Fist` can occur during transitions, so cooldowns reduce false triggers but can also delay legitimate commands.
- The logic is tuned for the current gesture vocabulary; changing camera angle or hand pose style may require retuning thresholds.

### Audio and Metadata Limits

- Local file artwork extraction depends on embedded metadata and image tags.
- Songs without album art fall back to text-only display.
- Metadata parsing is best-effort; malformed files may not yield cover art.
- Shuffle chooses randomly and does not avoid recently played tracks beyond the current one.

### Browser and Platform Limits

- Webcam access requires browser permission.
- Audio playback may be blocked until the user interacts with the page.
- MediaPipe model loading depends on remote CDN availability.
- Cross-origin or network failures can prevent model, WASM, or metadata-library loading.

### Known Implementation Caveat

The drop zone and file input are intended to accept audio files, but file type handling depends on browser-reported MIME types. If a browser does not provide reliable audio MIME information, dropped files may not be recognized as expected.

## User Controls

### Pointer / UI Controls

- Add songs with the `＋` button.
- Search the library with the search box.
- Click a song to play it.
- Click a liked song to jump back to it.
- Click the timeline to seek.
- Use the transport buttons for play/pause, stop, skip, rewind, and 15-second seek jumps.
- Drag audio files into the drop zone or anywhere onto the page.

### Gesture Controls

- Right-hand fist movement: volume up / down.
- Both hands pointing up: speed up.
- Both hands pointing down: speed down.
- Open palm: stop.
- OK sign: play / pause.
- Right-hand point right: skip.
- Right-hand point left: rewind.
- Left-hand point right: seek forward 15 seconds.
- Left-hand point left: seek backward 15 seconds.
- Victory sign: shuffle.
- I-love-you sign: like current track.

## File Structure

- `index.html` - page structure and UI elements.
- `css/style.css` - all visual styling and animation.
- `js/app.js` - application wiring and UI state synchronization.
- `js/gesture-controller.js` - webcam gesture recognition and action routing.
- `js/music-player.js` - audio playback, library management, and metadata logic.
- `audios/` - built-in demo tracks.

## Extending the Program

Common extension points are straightforward:

- Add a new gesture in `gesture-controller.js`.
- Map it to a player command in `app.js`.
- Add a corresponding method in `music-player.js` if the command needs new playback behavior.
- Add a label in `GESTURE_LABELS` or `ACTION_LABELS` so the UI shows the new command clearly.

If you add a new built-in track, register it in `BUILT_IN_SONGS` inside `app.js` and place the audio file in `audios/`.

## Runtime Dependencies

The app currently depends on remote browser-loaded libraries:

- `@mediapipe/tasks-vision`
- `music-metadata-browser`
- Google Fonts: Orbitron, Rajdhani, Inter, and DM Mono

Because the dependencies are loaded from CDNs, the app can be affected by network availability.

## Summary

GestureBeats is a single-page webcam-controlled music player. The MediaPipe-based gesture controller interprets hand poses and movement, the music player manages audio state and metadata, and the main app file binds those systems to the UI. The result is a gesture-driven DJ interface that works well as an interactive demo and is structured so the gesture vocabulary or playback commands can be expanded later.