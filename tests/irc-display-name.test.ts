import assert from 'node:assert/strict';
import test from 'node:test';
import type {StreamEvent} from '@comictoons/core';
import {chaosSource} from './ingest-chaos-fixture.ts';

test('IRC chat uses display-name and falls back to nick when missing or blank',()=>{
  const source=chaosSource(),events:StreamEvent[]=[];
  source.adapter.start({event:event=>events.push(event),status(){}});
  source.welcome();
  try{
    for(const [id,tag] of [['named',';display-name=FancyViewer'],['missing',''],['blank',';display-name=\\s\\s']]){
      source.feed(`@id=${id};user-id=viewer${tag} :fallbacknick!u@h PRIVMSG #approved_test :hello ${id}\r\n`);
    }
    assert.deepEqual(events.map(event=>({name:event.name,user:event.user,type:event.type})),[
      {name:'FancyViewer',user:'viewer',type:'chat'},
      {name:'fallbacknick',user:'viewer',type:'chat'},
      {name:'fallbacknick',user:'viewer',type:'chat'},
    ]);
  }finally{source.adapter.stop();}
});
