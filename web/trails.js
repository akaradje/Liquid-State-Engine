/**
 * Connection Trails — Energy Beam System
 *
 * Draws a pulsing glow beam between a dragged node and its merge target.
 * Uses a <canvas> with globalCompositeOperation: 'lighter' for additive blending.
 *
 * Beam gets brighter as nodes get closer.
 * Disappears instantly when drag ends without merge.
 */

const canvas = document.createElement('canvas');
canvas.id = 'trails-canvas';
const ctx = canvas.getContext('2d');

// Insert canvas between workspace and data-boxes
function init() {
  const workspace = document.getElementById('workspace');
  if (!workspace || document.getElementById('trails-canvas')) return;
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:45;pointer-events:none;';
  document.body.insertBefore(canvas, workspace.nextSibling);
  resize();
  window.addEventListener('resize', resize);
}

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

let beamFrom = null;
let beamTo = null;

/** Show beam between two points. Pass null to hide. */
export function drawBeam(from, to) {
  beamFrom = from;
  beamTo = to;
}

let animId = null;

/** Start the animation loop (called once). */
export function startTrailLoop() {
  init();
  if (animId) return;
  const tick = () => {
    renderFrame();
    animId = requestAnimationFrame(tick);
  };
  animId = requestAnimationFrame(tick);
}

function renderFrame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!beamFrom || !beamTo) return;

  const dx = beamTo.x - beamFrom.x;
  const dy = beamTo.y - beamFrom.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return;

  // Brighter when closer
  const intensity = Math.max(0.15, Math.min(1, 200 / dist));
  const pulse = 0.7 + 0.3 * Math.sin(Date.now() / 200);

  // Outer glow
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  const gradient = ctx.createLinearGradient(beamFrom.x, beamFrom.y, beamTo.x, beamTo.y);
  gradient.addColorStop(0, `rgba(140,180,255,${intensity * 0.3 * pulse})`);
  gradient.addColorStop(0.5, `rgba(255,200,80,${intensity * 0.5 * pulse})`);
  gradient.addColorStop(1, `rgba(140,180,255,${intensity * 0.3 * pulse})`);

  // Wide glow
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 8 * intensity * pulse;
  ctx.beginPath();
  ctx.moveTo(beamFrom.x, beamFrom.y);
  ctx.lineTo(beamTo.x, beamTo.y);
  ctx.stroke();

  // Core beam
  const coreGrad = ctx.createLinearGradient(beamFrom.x, beamFrom.y, beamTo.x, beamTo.y);
  coreGrad.addColorStop(0, `rgba(200,220,255,${intensity * 0.6 * pulse})`);
  coreGrad.addColorStop(0.5, `rgba(255,220,120,${intensity * 0.8 * pulse})`);
  coreGrad.addColorStop(1, `rgba(200,220,255,${intensity * 0.6 * pulse})`);

  ctx.strokeStyle = coreGrad;
  ctx.lineWidth = 2 * intensity * pulse;
  ctx.beginPath();
  ctx.moveTo(beamFrom.x, beamFrom.y);
  ctx.lineTo(beamTo.x, beamTo.y);
  ctx.stroke();

  // Sparkles at midpoint
  const midX = (beamFrom.x + beamTo.x) / 2;
  const midY = (beamFrom.y + beamTo.y) / 2;
  ctx.fillStyle = `rgba(255,240,180,${intensity * pulse})`;
  ctx.beginPath();
  ctx.arc(midX, midY, 3 * intensity * pulse, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/** Stop the trail loop. */
export function stopTrailLoop() {
  if (animId) { cancelAnimationFrame(animId); animId = null; }
}
