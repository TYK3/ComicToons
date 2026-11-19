import { useState, type CSSProperties } from 'react';
import type { LookId, UiPanel } from '../data/adapter';
import { useUi } from '../data/store';
import { panelArtUrl, panelArtRect } from '../data/sampleStories';
import { dialogueScenes, letteringPocket, sfxPocket } from '../data/lettering';

const SOURCE: Record<UiPanel['source'], [long: string, short: string]> = { clip: ['Clip frame', 'Clip'], generated: ['Generated art', 'Art'], cameo: ['Ink me cameo', 'Cameo'] };

/** The art layer alone, in a Look. Used inside panels and for Look picker thumbnails. */
export function LookArt({ panel, look, eager = false }: { panel: Pick<UiPanel, 'imageUrl' | 'altText' | 'art'>; look: LookId; eager?: boolean }) {
  const atlas = panel.art.atlas;
  const [natural, setNatural] = useState({ width: 1494, height: 1052 });
  const [x, y, width, height] = panelArtRect(panel);
  const ratio = atlas ? natural.width * width / (natural.height * height) : panel.art.width / panel.art.height;
  const crop: CSSProperties | undefined = atlas ? { position: 'absolute', width: `${100 / width}%`, height: `${100 / height}%`, maxWidth: 'none', left: `${-x / width * 100}%`, top: `${-y / height * 100}%`, objectFit: 'fill' } : undefined;
  const image = <img src={panelArtUrl(panel, look)} style={crop} onLoad={event => { const image = event.currentTarget; setNatural({ width: image.naturalWidth, height: image.naturalHeight }); }} alt={panel.altText} width={panel.art.width} height={panel.art.height} decoding="async" loading={eager ? 'eager' : 'lazy'}/>;
  return <div className="ct-art" data-look={look} data-tone={panel.art.tone} data-atlas={atlas ? atlas.cell : undefined}>
    {atlas ? <div className="ct-art__crop" style={{ width: `min(100cqw, ${ratio * 100}cqh)`, height: `min(100cqh, ${100 / ratio}cqw)` }}>{image}</div> : image}
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
  const scenes = dialogueScenes(panel);
  const [sceneAt, setSceneAt] = useState(0);
  const scene = scenes[Math.min(sceneAt, scenes.length - 1)]!;
  const pocket = letteringPocket(scene);
  const effect = sfxPocket(scene);
  const bubbleStyle: CSSProperties | undefined = pocket ? { left: `${pocket.x}%`, top: `${pocket.y}%`, width: `${pocket.width}%`, height: `${pocket.height}%` } : undefined;
  return <figure className={`ct-panel ${className}`} data-look={active} data-lettered={lettering || undefined} data-integrated={lettering && !!pocket || undefined} style={style} data-panel-id={panel.id}>
    {lettering ? <div className="ct-panel__scene" style={{ aspectRatio: `${panel.art.width} / ${panel.art.height}` }}><LookArt panel={panel} look={active} eager={eager}/>{pocket && scene.dialogue[0] && <p className={`ct-bubble ct-bubble--inside${panel.art.replaceBubble?' ct-bubble--replacement':''}`} style={bubbleStyle}>{panel.art.replaceBubble&&<span className="ct-bubble__label">{panel.art.bubbleLabel??'Chat'}</span>}{scene.dialogue[0]}</p>}{effect && panel.sfx && <span className="ct-sfx ct-sfx--inside" aria-hidden="true" style={{left:`${effect.x}%`,top:`${effect.y}%`,width:`${effect.width}%`,height:`${effect.height}%`,fontSize:`clamp(8px,${Math.min(effect.width/(panel.sfx.length*.65),effect.height*.5625)}cqw,36px)`}}>{panel.sfx}</span>}<span className="ct-sr">{panel.caption}{!pocket && ` ${panel.dialogue.join(' ')}`}</span></div> : <LookArt panel={panel} look={active} eager={eager}/>}
    {lettering && pocket && scenes.length > 1 && <figcaption className="ct-panel__dialogue-nav" aria-label="Dialogue frames">
      <button type="button" aria-label="Previous dialogue frame" disabled={sceneAt === 0} onClick={() => setSceneAt(Math.max(0, sceneAt - 1))}>←</button>
      <span>{Math.min(sceneAt + 1, scenes.length)} / {scenes.length}</span>
      <button type="button" aria-label="Next dialogue frame" disabled={sceneAt >= scenes.length - 1} onClick={() => setSceneAt(sceneAt + 1)}>→</button>
    </figcaption>}
    {lettering && !pocket && panel.dialogue.length > 0 && <figcaption className="ct-panel__layout-needed">Lettering layout needed</figcaption>}
    {stamp && <span className={`ct-stamp${stamp === 'Rejected' ? ' ct-stamp--rejected' : ''}`}>{stamp}</span>}
    {tags && <figcaption className="ct-panel__tags"><PanelTagList panel={panel} lettering={lettering}/></figcaption>}
  </figure>;
}

function PanelTagList({ panel, lettering, outside = false }: { panel: UiPanel; lettering: boolean; outside?: boolean }) {
  const [long, short] = panel.releaseBlocked ? ['Library placeholder', 'Placeholder'] : SOURCE[panel.source];
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
