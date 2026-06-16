/**
 * OpenSourceApp — The base renderer for the Constella open-source distribution.
 *
 * This is your blank canvas. The full knowledge-graph engine, local file
 * indexer, AI pipeline, MCP bridge, and sync layer are all running underneath.
 * Swap out this component with any UI you want — paste in a Jarvis orb,
 * a Salesforce dashboard, FRIDAY, a Wizard of Oz terminal, anything.
 *
 * The core handles:
 *   • Local file indexing + vector search (LanceDB)
 *   • Knowledge graph (concepts → themes → edges)
 *   • AI pipeline (local LLM or cloud)
 *   • MCP tools (Claude Code can call your data directly)
 *   • Cloud sync via your own Firebase project
 */
import React, { useEffect, useRef, useState } from 'react';
import './open-source.css';

// Animated particles that drift across the background
function Particle({ style }: { style: React.CSSProperties }) {
  return <div className="oss-particle" style={style} />;
}

function useParticles(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    style: {
      left: `${Math.random() * 100}%`,
      top: `${Math.random() * 100}%`,
      animationDelay: `${Math.random() * 8}s`,
      animationDuration: `${6 + Math.random() * 10}s`,
      width: `${2 + Math.random() * 3}px`,
      height: `${2 + Math.random() * 3}px`,
      opacity: 0.15 + Math.random() * 0.25,
    } as React.CSSProperties,
  }));
}

// Typewriter effect for the subtitle lines
function TypewriterLine({
  text,
  delay = 0,
  speed = 35,
}: {
  text: string;
  delay?: number;
  speed?: number;
}) {
  const [displayed, setDisplayed] = useState('');
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const startTimer = setTimeout(() => setStarted(true), delay);
    return () => clearTimeout(startTimer);
  }, [delay]);

  useEffect(() => {
    if (!started) return;
    if (displayed.length >= text.length) return;
    const t = setTimeout(
      () => setDisplayed(text.slice(0, displayed.length + 1)),
      speed,
    );
    return () => clearTimeout(t);
  }, [started, displayed, text, speed]);

  return (
    <span>
      {displayed}
      {started && displayed.length < text.length && (
        <span className="oss-cursor">▋</span>
      )}
    </span>
  );
}

// Pulsing ring that sits behind the orb
function PulseRing({ delay = 0 }: { delay?: number }) {
  return (
    <div
      className="oss-pulse-ring"
      style={{ animationDelay: `${delay}s` }}
    />
  );
}

export default function OpenSourceApp() {
  const particles = useParticles(28);
  const [orbHovered, setOrbHovered] = useState(false);

  return (
    <div className="oss-root">
      {/* Starfield background */}
      <div className="oss-bg" />

      {/* Floating particles */}
      <div className="oss-particles">
        {particles.map((p) => (
          <Particle key={p.id} style={p.style} />
        ))}
      </div>

      {/* Radial glow behind the orb */}
      <div className="oss-glow" />

      {/* Main content */}
      <div className="oss-center">
        {/* Orb */}
        <div
          className={`oss-orb-wrap ${orbHovered ? 'oss-orb-wrap--hovered' : ''}`}
          onMouseEnter={() => setOrbHovered(true)}
          onMouseLeave={() => setOrbHovered(false)}
        >
          <PulseRing delay={0} />
          <PulseRing delay={1.4} />
          <PulseRing delay={2.8} />
          <div className="oss-orb">
            <div className="oss-orb-inner" />
          </div>
        </div>

        {/* Title */}
        <h1 className="oss-title">Constella Open Source</h1>

        {/* Subtitle lines */}
        <p className="oss-subtitle">
          <TypewriterLine
            text="Connected to all your data and layers."
            delay={600}
            speed={30}
          />
        </p>

        {/* Divider */}
        <div className="oss-divider" />

        {/* CTA block */}
        <div className="oss-cta">
          <p className="oss-cta-label">customize this ui</p>
          <p className="oss-cta-text">
            Use Claude Code to modify this however you like.
          </p>
          <p className="oss-cta-hint">
            p.s. paste in a Jarvis image, FRIDAY, Wizard of Oz, whichever
            you'd like — or even a Salesforce dashboard if that's your style.
          </p>
        </div>

        {/* Layer pills */}
        <div className="oss-layers">
          {[
            'file index',
            'knowledge graph',
            'ai pipeline',
            'mcp bridge',
            'vector search',
            'cloud sync',
          ].map((layer) => (
            <span key={layer} className="oss-layer-pill">
              {layer}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
