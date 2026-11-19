import {chromium,type Browser,type Page} from '@playwright/test';
import {validChannel} from '../ingest/irc.ts';
export interface CaptureSource {open(channel:string):Promise<void>;frame():Promise<{buffer:Buffer;videoTime:number}>;close():Promise<void>}
export class CaptureError extends Error {constructor(readonly code:'offline'|'status'|'stopped',message:string){super(message);}}
/** Screenshots the actual playing video, without profile photos, thumbnails or library substitutions. */
export class TwitchVideoCapture implements CaptureSource {
  private browser?:Browser;private page?:Page;private previous=-1;
  private generation=0;
  constructor(private options:{isLive?:(channel:string)=>Promise<boolean>;launch?:()=>Promise<Browser>}={}){}
  private channel='';
  async open(channel:string){
    if(!validChannel(channel))throw new Error('Enter a Twitch channel name.');
    const generation=++this.generation;this.previous=-1;this.channel=channel;
    await this.requireLive();if(generation!==this.generation)throw new CaptureError('stopped','Capture was stopped.');
    const browser=await (this.options.launch?.()??chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']}));
    if(generation!==this.generation){await browser.close();throw new CaptureError('stopped','Capture was stopped.');}this.browser=browser;
    const page=await browser.newPage({viewport:{width:1280,height:900},locale:'en-GB'});
    if(generation!==this.generation){await browser.close();throw new CaptureError('stopped','Capture was stopped.');}this.page=page;
    await page.goto(`https://www.twitch.tv/${channel}`,{waitUntil:'domcontentloaded',timeout:45000});
    const reject=page.getByRole('button',{name:/Reject.*Cookies|Reject All/i});if(await reject.count())await reject.first().click({timeout:2000}).catch(()=>{});
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('video')).some(v=>v.readyState>=2&&v.videoWidth>0),undefined,{timeout:45000});
    if(await page.getByText(/^offline$/i,{exact:true}).count())throw new CaptureError('offline','This channel is offline. Start a live broadcast, then try again. Archived videos are not used as live footage.');
  }
  private async requireLive(){
    if(this.options.isLive&&!await this.options.isLive(this.channel))throw new CaptureError('offline','This channel is offline. Start a live broadcast, then try again. Archived videos are not used as live footage.');
  }
  async frame(){
    if(!this.page)throw new Error('Video capture is not open.');
    await this.requireLive();
    const body=(await this.page.locator('body').innerText({timeout:4000})).slice(0,16000);
    if(/Error\s*#\s*\d+|stream is offline|is currently offline|commercial break|advertisement in progress/i.test(body))throw new Error('The video shows an offline, advert or playback-error screen. No scene was captured.');
    const video=this.page.locator('video').first();
    const state=await video.evaluate(node=>{const v=node as HTMLVideoElement;return {time:v.currentTime,ready:v.readyState,width:v.videoWidth,paused:v.paused,ended:v.ended};});
    if(state.ready<2||!state.width||state.paused||state.ended||state.time<=this.previous)throw new Error('Waiting for playing video. The current frame has not advanced.');
    const buffer=await video.screenshot({type:'jpeg',quality:85,timeout:8000});this.previous=state.time;
    return {buffer,videoTime:state.time};
  }
  async close(){this.generation++;const browser=this.browser;this.browser=undefined;this.page=undefined;await browser?.close().catch(()=>{});}
}
