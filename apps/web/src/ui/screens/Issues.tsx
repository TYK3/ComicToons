import {ReaderBar} from '../components/ReaderBar';
import {ScreenState} from '../components/ScreenState';
import {LookArt} from '../components/Panel';
import {useAdapter,useLoad,useUi} from '../data/store';
import {useStudioMode} from '../data/StudioSession';
import {href} from '../router';
import {LibraryNav} from '../components/LibraryNav';
import {StudioModeSwitch} from '../components/StudioModeSwitch';
import '../styles/workspaces.css';

export function Issues(){
  const adapter=useAdapter(),ui=useUi(),{mode}=useStudioMode();
  const label=mode==='sample'?'Sample':'Live';
  const {data,error,retry}=useLoad(async()=>Promise.all((await adapter.listIssues()).map(id=>adapter.getIssue(id,ui.studio.look))),[adapter,ui.studio.look,ui.studio.recapUrl]);
  return <div className="ct-reader"><ReaderBar backLabel={`${label} Studio`}><span>Library</span><StudioModeSwitch/></ReaderBar><main className="ct-reader__main ct-workspace-issues"><h1 className="ct-display">{label} library</h1><p>{mode==='sample'?'Comics saved from your simulated streams.':'Comics saved from your Twitch streams.'} Read the same story as a collected comic book or manga series.</p><LibraryNav current="issues"/>
    {error?<ScreenState kind="error" title="Couldn’t load issues" actions={<button className="ct-btn" onClick={retry}>Try again</button>}><p>{error}</p></ScreenState>:!data?<p role="status">Loading issues…</p>:!data.length?<ScreenState kind="empty" title={`No ${label} issues yet`} actions={<a className="ct-btn ct-btn--ink" href={href('/studio')}>Open {label} Studio</a>}><p>{mode==='sample'?'Run the demo to save a complete issue automatically, or review panels manually and use Create & export.':'Capture a video source, release its panels, then use Create & export.'}</p></ScreenState>:<ul className="ct-issue-list">{data.map(issue=><li key={issue.id}><div>{issue.panels[0]&&<LookArt panel={issue.panels[0]} look={ui.studio.look}/>}</div><h2>{issue.title}</h2><p>{issue.panels.length} panels · {label}</p><div className="ct-row"><a className="ct-btn" href={href(`/recap/${issue.id}`)}>Open issue</a><a className="ct-btn" href={href(`/book/${issue.id}`)}>Read book</a><a className="ct-btn" href={href(`/series/${issue.id}`)}>Read manga</a></div></li>)}</ul>}
  </main></div>;
}
