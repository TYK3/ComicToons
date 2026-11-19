import type { CSSProperties } from 'react';
import type { LookId, UiPanel } from '../data/adapter';
import { useUi } from '../data/store';

const SOURCE: Record<UiPanel['source'], [long: string, short: string]> = { clip: ['Clip frame', 'Clip'], generated: ['Generated art', 'Art'], cameo: ['Ink me cameo', 'Cameo'] };

/** The art layer alone, in a Look. Used inside panels and for Look picker thumbnails. */
export function LookArt({ panel, look, eager = false }: { panel: Pick<UiPanel, 'imageUrl' | 'altText' | 'art'>; look: LookId; eager?: boolean }) {
  return <div className="ct-art" data-look={look} data-tone={panel.art.tone}>
    <img src={panel.imageUrl} alt={panel.altText} width={panel.art.width} height={panel.art.height} decoding="async" loading={eager ? 'eager' : 'lazy'}/>
  </div>;
}

export interface PanelProps {
  panel: UiPanel;
  /** Defaults to the studio Look, so every view changes together. */
  look?: LookId;
  stamp?: 'On air' | 'Rejected' | 'Waiting';
  lettering?: boolean;
  tags?: boolean;
  className?: string;
  style?: CSSProperties;
  eager?: boolean;
}

export function Panel({ panel, look, stamp, lettering = true, tags = true, className = '', style, eager }: PanelProps) {
  const ui = useUi();
  const active = look ?? ui.studio.look;
  return <figure className={`ct-panel ${className}`} data-look={active} style={style} data-panel-id={panel.id}>
    <LookArt panel={panel} look={active} eager={eager}/>
    {lettering && panel.caption && <p className="ct-caption">{panel.caption}</p>}
    {lettering && panel.dialogue[0] && <p className="ct-bubble" data-at={panel.bubblePlacement === 'bottom-left' ? 'bottom-left' : 'top-right'}>
      {panel.dialogue[0]}{panel.generatedCaption && <span className="ct-gen">Generated caption</span>}
    </p>}
    {lettering && panel.sfx && <span className="ct-sfx" aria-hidden="true">{panel.sfx}</span>}
    {stamp && <span className={`ct-stamp${stamp === 'Rejected' ? ' ct-stamp--rejected' : ''}`}>{stamp}</span>}
    {tags && <figcaption className="ct-panel__tags"><PanelTagList panel={panel} lettering={lettering}/></figcaption>}
  </figure>;
}

function PanelTagList({ panel, lettering, outside = false }: { panel: UiPanel; lettering: boolean; outside?: boolean }) {
  const [long, short] = SOURCE[panel.source];
  return <>
    {outside ? <span className="ct-tag">{long}</span> : <span className="ct-tag"><span className="ct-src-long">{long}</span><span className="ct-src-short" aria-hidden="true">{short}</span></span>}
    {panel.chosenBy && <span className="ct-tag ct-tag--paper ct-tag--extra">Chat chose · {panel.chosenBy.pct}%</span>}
    {panel.cameo && <span className="ct-tag ct-tag--paper ct-tag--extra">@{panel.cameo}</span>}
    {panel.origin !== 'twitch' && <span className="ct-tag ct-tag--dash">Sample</span>}
    {panel.generatedCaption && lettering && <span className={`ct-tag ct-tag--paper${outside ? '' : ' ct-gen-tag'}`}>Generated caption</span>}
  </>;
}

/** POLISH-1 N7: the same tags as a line under the art, for studio tiles where tags on the art cover the SFX. */
export function PanelTags({ panel, className = '' }: { panel: UiPanel; className?: string }) {
  return <p className={className}><PanelTagList panel={panel} lettering outside/></p>;
}
