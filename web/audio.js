/**
 * Procedural Audio Feedback System
 *
 * Uses Web Audio API (OscillatorNode + GainNode) to generate
 * sound effects without any audio files. All sounds are synthesized.
 *
 * AudioContext is lazily created on first user gesture (browser policy).
 */

let ctx = null;
let muted = false;

// Restore mute preference
try { muted = localStorage.getItem('lse-audio-muted') === 'true'; } catch {}

function ensureCtx() {
  if (!ctx) {
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  // Resume if suspended (browser may auto-suspend)
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** Master volume multiplier (respects mute). */
function vol(base) { return muted ? 0 : base; }

// ---- Sound Generators ----

/**
 * Soft "ping" — node creation.
 * Sine wave 440Hz, 80ms, gentle fade.
 */
export function playCreate() {
  const c = ensureCtx();
  if (!c) return;
  const v = vol(0.12);
  if (v === 0) return;

  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(440, c.currentTime);
  osc.frequency.exponentialRampToValueAtTime(880, c.currentTime + 0.04);
  gain.gain.setValueAtTime(v, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.08);
  osc.connect(gain).connect(c.destination);
  osc.start(c.currentTime);
  osc.stop(c.currentTime + 0.1);
}

/**
 * "Shatter" — node fracture.
 * White noise burst + descending sine sweep.
 */
export function playFracture() {
  const c = ensureCtx();
  if (!c) return;
  const v = vol(0.15);
  if (v === 0) return;

  // White noise burst (50ms)
  const bufferSize = c.sampleRate * 0.05;
  const noiseBuffer = c.createBuffer(1, bufferSize, c.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
  const noise = c.createBufferSource();
  noise.buffer = noiseBuffer;
  const noiseGain = c.createGain();
  noiseGain.gain.setValueAtTime(v, c.currentTime);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.05);
  noise.connect(noiseGain).connect(c.destination);
  noise.start(c.currentTime);

  // Descending sine sweep 800→200Hz over 200ms
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(800, c.currentTime);
  osc.frequency.exponentialRampToValueAtTime(200, c.currentTime + 0.2);
  gain.gain.setValueAtTime(v * 0.6, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.22);
  osc.connect(gain).connect(c.destination);
  osc.start(c.currentTime);
  osc.stop(c.currentTime + 0.25);
}

/**
 * "Fusion" — successful merge.
 * Ascending sine sweep 200→600Hz + harmonic overtone.
 */
export function playMerge() {
  const c = ensureCtx();
  if (!c) return;
  const v = vol(0.13);
  if (v === 0) return;

  // Fundamental sweep
  const osc1 = c.createOscillator();
  const gain1 = c.createGain();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(200, c.currentTime);
  osc1.frequency.exponentialRampToValueAtTime(600, c.currentTime + 0.3);
  gain1.gain.setValueAtTime(v, c.currentTime);
  gain1.gain.setValueAtTime(v * 0.7, c.currentTime + 0.15);
  gain1.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.35);
  osc1.connect(gain1).connect(c.destination);
  osc1.start(c.currentTime);
  osc1.stop(c.currentTime + 0.4);

  // Harmonic overtone (2x frequency, quieter)
  const osc2 = c.createOscillator();
  const gain2 = c.createGain();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(400, c.currentTime);
  osc2.frequency.exponentialRampToValueAtTime(1200, c.currentTime + 0.25);
  gain2.gain.setValueAtTime(v * 0.4, c.currentTime);
  gain2.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.3);
  osc2.connect(gain2).connect(c.destination);
  osc2.start(c.currentTime);
  osc2.stop(c.currentTime + 0.35);
}

/**
 * Quiet "tick" — node hover.
 * Triangle wave, very short, low volume.
 */
export function playHover() {
  const c = ensureCtx();
  if (!c) return;
  const v = vol(0.06);
  if (v === 0) return;

  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(300, c.currentTime);
  gain.gain.setValueAtTime(v, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.02);
  osc.connect(gain).connect(c.destination);
  osc.start(c.currentTime);
  osc.stop(c.currentTime + 0.03);
}

/** Toggle mute and persist preference. */
export function toggleMute() {
  muted = !muted;
  try { localStorage.setItem('lse-audio-muted', String(muted)); } catch {}
  return muted;
}

export function isMuted() { return muted; }
