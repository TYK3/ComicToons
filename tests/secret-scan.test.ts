import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
const script=fileURLToPath(new URL('../scripts/secret-scan.mjs',import.meta.url));
test('secret scanning succeeds in an archive and detects secrets without printing their value',()=>{
  const directory=mkdtempSync(join(tmpdir(),'comictoons-secret-scan-'));
  try{
    writeFileSync(join(directory,'README.md'),'A source archive without git metadata.\n');
    assert.equal(spawnSync(process.execPath,[script],{cwd:directory,encoding:'utf8',env:childEnv}).status,0);
    const secret='sk-'+ 'q'.repeat(40);
    writeFileSync(join(directory,'bad.txt'),secret);
    const result=spawnSync(process.execPath,[script],{cwd:directory,encoding:'utf8',env:childEnv});
    assert.equal(result.status,1);
    assert.match(result.stdout+result.stderr,/bad.txt/);
    assert.equal((result.stdout+result.stderr).includes(secret),false);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('archive scanning ignores dependency and regenerated output trees',()=>{
  const directory=mkdtempSync(join(tmpdir(),'comictoons-secret-scan-'));
  try{
    for(const name of ['node_modules','artifacts','exports','dist']){
      mkdirSync(join(directory,name));
      writeFileSync(join(directory,name,'test.txt'),'sk-'+'z'.repeat(40));
    }
    assert.equal(spawnSync(process.execPath,[script],{cwd:directory,encoding:'utf8',env:childEnv}).status,0);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
