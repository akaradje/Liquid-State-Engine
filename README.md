# 🌊 Liquid-State Engine

> **Turning Liquid Thoughts into Solid Knowledge.**

An AI-powered interactive workspace where concepts become draggable, fracturable, mergeable nodes. Built with DeepSeek V4 and vanilla JavaScript — no frameworks, no GPU, no Wasm required.

---

## Core Features

### 🧠 Deterministic LOD (6 Levels of Detail)

Every concept is decomposed through a strict ontological hierarchy:

| Level | Name | Example |
|-------|------|---------|
| L1 | Category/Field | Anatomy, Transportation |
| L2 | System/Entity | Human Skeleton, Car |
| L3 | Macro-Parts/Sub-systems | Axial Skeleton, Engine |
| L4 | Micro-Components | Skull, Piston |
| L5 | Materials/Tissues | Bone Tissue, Steel |
| L6 | Chemical/Atomic | Calcium, Carbon |

The AI assesses the input's LOD and decomposes **exactly one level deeper** — never skipping from L2 (Skeleton) to L6 (Calcium).

### 🌿 Natural Ontology

No forced component counts. If a system naturally has 2 parts, you get 2. If it has many, you get the most critical 3-8. Quality and structural accuracy over arbitrary quotas.

### ⚡ Hybrid AI Strategy

- **0ms Knowledge Cache**: Every unique keyword is cached server-side. Repeated queries return instantly without API calls.
- **Model Escalation**: If `deepseek-v4-flash` (LITE) returns empty, the system auto-escalates to `deepseek-chat` (STANDARD) with JSON mode enabled. No manual intervention needed.
- **Three-Tier Routing**: LITE (flash) → STANDARD (chat) → ULTRA (pro) — complexity-based auto-selection.

### 🪞 Self-Reflecting Agents

Every AI response undergoes real-time Quality Control. A separate critique agent scores the output on accuracy, creativity, depth, and relevance. If the score is below 7, the response is regenerated with improvement guidance.

### 🎨 Glassmorphic UI

Ultra-lite DOM architecture with translucent panels, backdrop blur, and subtle glow effects. All nodes are draggable `<div>` elements — no canvas rendering overhead.

### 🔬 Multi-Agent Debate

Three AI personas (Scientist, Philosopher, Artist) independently decompose a concept, then a Synthesizer combines their perspectives into a final result. Alt+double-click to trigger.

### 🔗 Additional Capabilities

- **Semantic Memory**: Persistent knowledge graph tracking all relationships
- **Analogical Reasoning**: `A:B :: C:?` — AI completes analogies from your workspace
- **Counterfactual Reasoning**: "What if X didn't exist?" / "What is the extreme of X?"
- **Proactive Curiosity**: AI suggests interesting merges when you're idle
- **Tension Detection**: Identifies dialectical oppositions with wavy SVG lines
- **Deep Fracture**: Recursive multi-level decomposition (Shift+double-click)
- **Workspace Persistence**: Auto-save to localStorage, export/import as JSON
- **Real-Time Collaboration**: WebSocket relay for multi-user workspaces
- **Embedding Similarity**: Vector-based semantic clustering (press 'C')
- **Ontology Hierarchy**: IS-A taxonomy chains with LCA merge context (press 'H')
- **Tool-Using Agent**: Wikipedia, dictionary, calculator tools via ReAct loop
- **Hover Descriptions**: AI-generated definitions with cached async loading

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| AI Backend | DeepSeek V4 (Flash / Chat / Pro) |
| Server | Node.js HTTP + WebSocket relay |
| Frontend | Vanilla JS (ES Modules), Preact+htm HUD |
| Styling | CSS Glassmorphism, SVG overlays |
| Storage | localStorage + server-side memory cache |
| Validation | Custom pre-commit hook (`scripts/validate.js`) |

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [DeepSeek API Key](https://platform.deepseek.com/) (free tier available)

### Setup

```bash
git clone https://github.com/akaradje/Liquid-State-Engine.git
cd Liquid-State-Engine
npm install
```

### Configure

Copy the environment template and add your API key:

```bash
cp .env.example .env
# Edit .env: DEEPSEEK_API_KEY=sk-your-key-here
```

### Run

```bash
npm run serve
# Open http://localhost:8080
```

### Optional: Collaboration Server

```bash
npm run collab
# WebSocket relay on ws://localhost:8081
```

---

## Interaction Guide

| Gesture | Action |
|---------|--------|
| Double-click workspace | Create a new node |
| Drag node | Move freely |
| Double-click node | AI fracture (decompose) |
| Shift + Double-click | Deep recursive fracture |
| Alt + Double-click | Multi-agent debate |
| Drag A onto B | AI merge (synthesize) |
| Right-click / long-press | Context menu (fracture, invert, amplify, delete) |
| Hover (500ms) | AI-generated description + metadata tooltip |
| Press 'S' | Save workspace |
| Press 'L' | Load workspace |
| Press 'C' | Auto-cluster by similarity |
| Press 'H' | Hierarchy view |
| Press 'R' | Toggle relationship lines |
| Press 'M' | Toggle audio |
| Press 'F' | Toggle reflection |

---

## Project Structure

```
├── scripts/
│   ├── serve.js           # HTTP server + 15 AI endpoints
│   ├── collab-server.js   # WebSocket relay
│   ├── validate.js        # Pre-commit validator
│   └── test-ai.js         # 19-test AI suite
├── web/
│   ├── index.html         # Entry point
│   ├── main.js            # Frontend orchestrator
│   ├── style.css          # Glassmorphism + animations
│   ├── ai-enrich.js       # AI enrichment client
│   ├── ai-memory.js       # Semantic knowledge graph
│   ├── ai-suggest.js      # Auto-suggestion client
│   ├── audio.js           # Procedural sound effects
│   ├── collab.js          # WebSocket collaboration
│   ├── curiosity.js       # Proactive AI suggestions
│   ├── meta-learner.js    # User preference learning
│   ├── ontology.js        # IS-A hierarchy tree
│   ├── particles.js       # Fracture/merge effects
│   ├── persistence.js     # Save/load workspace
│   ├── relations-viz.js   # SVG relationship lines
│   ├── semantic-space.js  # Embedding similarity
│   ├── tension-detector.js # Dialectical opposition
│   ├── trails.js          # Energy beam canvas
│   └── hud/
│       ├── app.js         # Preact HUD
│       └── style.css      # HUD panel styles
├── .env.example           # API key template
├── CLAUDE.md              # AI coding rules
└── package.json
```

## License

MIT

---

*Built for the era of Liquid Information — where concepts flow, merge, and crystallize into knowledge.*
