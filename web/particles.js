/**
 * Particle Effects System
 *
 * Fracture: burst of particles from parent center, fading radially outward
 * Merge: spiral particles from both sources converging to midpoint
 *
 * All particles are tiny <div> elements using CSS transforms for GPU acceleration.
 * DOM elements are cleaned up after animation completes.
 */

const PARTICLE_COUNT_FRACTURE = 18;
const PARTICLE_COUNT_MERGE = 24;
const DURATION = 600;
const COLORS = [
  'rgba(140,200,255,0.9)', 'rgba(100,180,255,0.8)', 'rgba(160,140,255,0.8)',
  'rgba(120,220,200,0.8)', 'rgba(200,160,255,0.7)', 'rgba(255,200,80,0.7)',
];

/** Emit a burst of particles from a central point (fracture effect). */
export function emitFractureParticles(x, y) {
  const container = document.getElementById('workspace');
  if (!container) return;

  for (let i = 0; i < PARTICLE_COUNT_FRACTURE; i++) {
    const particle = document.createElement('div');
    particle.className = 'particle';
    const angle = (Math.PI * 2 * i) / PARTICLE_COUNT_FRACTURE;
    const distance = 30 + Math.random() * 60;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];

    particle.style.cssText = `
      left: ${x}px; top: ${y}px;
      background: ${color};
      --dx: ${dx}px; --dy: ${dy}px;
      animation: particleFade ${DURATION * 0.8 + Math.random() * DURATION * 0.4}ms ease-out forwards;
      animation-delay: ${Math.random() * 80}ms;
    `;

    container.appendChild(particle);
    // Cleanup after animation
    setTimeout(() => particle.remove(), DURATION + 200);
  }
}

/** Spiral particles from two sources converging to a midpoint (merge effect). */
export function emitMergeParticles(x1, y1, x2, y2, cx, cy) {
  const container = document.getElementById('workspace');
  if (!container) return;

  const sources = [
    { x: x1, y: y1, count: PARTICLE_COUNT_MERGE / 2 },
    { x: x2, y: y2, count: PARTICLE_COUNT_MERGE / 2 },
  ];

  for (const src of sources) {
    for (let i = 0; i < src.count; i++) {
      const particle = document.createElement('div');
      particle.className = 'particle merge-particle';
      const angle = (Math.PI * 2 * i) / src.count;
      const spiralR = 15 + Math.random() * 10;
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];

      // Midpoint between source and center with spiral offset
      const midX = (src.x + cx) / 2 + Math.cos(angle) * spiralR;
      const midY = (src.y + cy) / 2 + Math.sin(angle) * spiralR;

      particle.style.cssText = `
        left: ${src.x}px; top: ${src.y}px;
        background: ${color};
        --dx: ${cx - src.x}px; --dy: ${cy - src.y}px;
        --mx: ${midX}px; --my: ${midY}px;
        animation: mergeParticleFlow ${DURATION * 1.2 + Math.random() * DURATION * 0.3}ms ease-in-out forwards;
        animation-delay: ${Math.random() * 100}ms;
      `;

      container.appendChild(particle);
      setTimeout(() => particle.remove(), DURATION + 400);
    }
  }
}

/** Clean up all particles (useful for testing). */
export function clearParticles() {
  for (const p of document.querySelectorAll('.particle')) p.remove();
}
