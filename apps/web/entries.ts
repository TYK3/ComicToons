/** Keep legacy pathname routes on the classic entry while the new UI uses hash routes. */
export function classicEntryUrl(url:string):string|undefined{
  const parsed=new URL(url,'http://localhost');
  if(!/^\/(?:classic(?:\.html)?|studio|dashboard|overlay|connect|auth|director|catchup|(?:book|series|recap|r)\/[^/]+)\/?$/.test(parsed.pathname))return;
  return `/classic.html${parsed.search}`;
}
