import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import type { Panel } from '../types';
import { timecode } from '../types';

export function ComicPanel({ panel, index = 0, className = '' }: { panel: Panel; index?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (panel.atlas) return <article className={`comic-panel story-panel ${className}`} data-panel-id={panel.id} data-source-id={panel.sourceId} data-provider="storyboard" data-asset={panel.imageUrl.split('/').at(-1)} data-story-frame={panel.atlas.frame} data-story-style={panel.provenance?.style} data-lettering-placement="in-art">
    <div className="panel-art">{broken ? <div className="art-fallback"><ImageOff size={28}/><span>The art took a detour.</span></div> : <img src={panel.imageUrl} alt={panel.altText} onError={() => setBroken(true)}/>}</div>
    <div className="story-lettering">{panel.dialogue.map((line, lineIndex) => <p key={lineIndex} className={`story-balloon ${lineIndex ? 'story-chat' : ''}`} data-lettering-kind="dialogue" dir="auto">{line}</p>)}
      {panel.sfx && <span className="story-sfx" data-lettering-kind="sfx" aria-label={`Sound effect: ${panel.sfx}`}>{panel.sfx}</span>}
    </div><span className="story-transcript">{panel.caption}</span>
  </article>;
  // All reviewed library image zones are protected. Unknown art also fails closed.
  // No text is put into an image zone without a verified full-text fit.
  return <article className={`comic-panel composition-${panel.composition ?? index} ${className}`} data-panel-id={panel.id} data-provider={panel.provenance?.provider} data-asset={panel.provenance?.asset} data-lettering-placement="caption-rail">
    <div className="panel-art">
      {broken ? <div className="art-fallback"><ImageOff size={28}/><span>The art took a detour.</span><span>The story is still here.</span></div> : <img src={panel.imageUrl} alt={panel.altText} onError={() => setBroken(true)} />}
    </div>
    <div className="lettering-rail">
      <div className="panel-meta">
        <span className="panel-number" data-lettering-kind="number" aria-label={`Panel ${index + 1}`}>{String(index + 1).padStart(2, '0')}</span>
        <time className="panel-time" data-lettering-kind="timestamp">{timecode(panel.at)}</time>
        {panel.sfx && <span className="panel-sfx" data-lettering-kind="sfx" aria-label={`Sound effect: ${panel.sfx}`}>{panel.sfx}</span>}
      </div>
      {panel.dialogue?.map((line, lineIndex) => <p className="speech-bubble" data-lettering-kind="dialogue" dir="auto" key={lineIndex}>{line}</p>)}
      <p className="panel-caption" data-lettering-kind="caption" dir="auto">{panel.caption}</p>
    </div>
    {panel.provenance && <details className="art-provenance"><summary>{panel.provenance.provider === 'library' ? 'AI-generated · Library art' : 'Procedural fallback'}</summary><span>{panel.provenance.asset || 'Original vector composition'} · {panel.provenance.style}</span></details>}
  </article>;
}
