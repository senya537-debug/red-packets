import test from 'node:test';
import assert from 'node:assert/strict';
import {tick} from '../cloudflare/redpacket-clock.js';

function mockGithub(runs){
  const calls=[];
  globalThis.fetch=async(url,init={})=>{
    calls.push((init.method||'GET')+' '+url);
    const status=new URL(url).searchParams.get('status');
    if(init.method==='POST')return new Response(null,{status:204});
    const list=runs[status]||[];
    return new Response(JSON.stringify({total_count:list.length,workflow_runs:list}),{status:200});
  };
  return calls;
}
const ago=ms=>new Date(Date.now()-ms).toISOString();

test('a recent active run keeps the clock from dispatching',async()=>{
  const calls=mockGithub({queued:[{created_at:ago(60000)}]});
  const result=await tick({GH_DISPATCH_TOKEN:'t'});
  assert.equal(result.status,'busy');assert.ok(!calls.some(c=>c.startsWith('POST')));
});

test('a run stuck for more than 20 minutes no longer blocks dispatching',async()=>{
  const calls=mockGithub({queued:[{created_at:ago(17*3600000)}],in_progress:[{created_at:ago(3*3600000)}]});
  const result=await tick({GH_DISPATCH_TOKEN:'t'});
  assert.equal(result.dispatched,true);assert.ok(calls.some(c=>c.startsWith('POST')));
});

test('idle repository dispatches',async()=>{
  mockGithub({});
  assert.equal((await tick({GH_DISPATCH_TOKEN:'t'})).http_status,204);
});
