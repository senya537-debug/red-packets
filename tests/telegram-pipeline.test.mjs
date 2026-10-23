import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Exercise the actual embedded workflow runtime without invoking main or using credentials.
const workflow=fs.readFileSync(new URL('../.github/workflows/square_access_check.yml',import.meta.url),'utf8');
const start=workflow.indexOf("          node --input-type=module <<'JS'\n");
assert.ok(start>=0);
const bodyStart=workflow.indexOf('\n',start)+1,end=workflow.indexOf('\n          JS',bodyStart);
assert.ok(end>bodyStart);
const runtime=workflow.slice(bodyStart,end).replace(/^          /gm,'').replace(/^await main\(\)\.catch\(.*$/m,'');
const app=await import('data:text/javascript;base64,'+Buffer.from(runtime).toString('base64'));
const now=Date.now(),destination='a'.repeat(64);
const packet=(id='123')=>({key:'post:'+id,post:{post_id:id,kind:'quiz',status:'reported_open',
  source_kind:'square',discovery_kind:'square',url:'https://www.binance.com/en/square/post/'+id,
  published_at:new Date(now-86400000).toISOString(),expires_at:new Date(now+3600000).toISOString(),
  published_codes:[],question:'Test'}});
const recordKey=candidate=>destination+':'+candidate.key;

test('standalone codes cannot enter discovery results, outbox, public feed or delivery order',()=>{
  assert.match(workflow,/worker: \[posts, authors, live, community\]/);
  for(const status of ['unverified_code','reported_open']) {
    const code={key:'code:ABCD1234',post:{...packet().post,kind:'code',status,published_codes:['ABCD1234']}};
    const snapshot={reported_open:[code.post],other_candidates:[code.post]};
    const entries={[code.key]:{candidate:code,observed_at:now}};
    assert.equal(app.isEligiblePost(code.post,now),false);
    assert.deepEqual(app.publishCandidates(snapshot,now),[]);
    assert.deepEqual(app.compactOutbox(entries,{},now),{});
    assert.deepEqual(app.compactPublicFeed(entries,now),{});
    assert.deepEqual(app.orderDeliveryCandidates([code]),[]);
    assert.throws(()=>app.formatTelegramPost(code.post),/disabled/);
  }
});

test('open packet/quiz remains eligible after 10 minutes; expired packets do not',()=>{
  const candidate=packet();
  assert.equal(app.isFreshPost(candidate.post,now),false);
  assert.equal(app.isEligiblePost(candidate.post,now),true);
  assert.equal(app.isEligiblePost({...candidate.post,expires_at:new Date(now-1).toISOString()},now),false);
  assert.equal(app.isEligiblePost({...candidate.post,status:'run_out'},now),false);
});

test('original diagnostics distinguish absent metadata, status and changed identity',()=>{
  const candidate=packet();
  assert.equal(app.originalRecheckReason(candidate,null,now),'packet_metadata_missing');
  for(const status of ['expired','run_out','unknown'])
    assert.equal(app.originalRecheckReason(candidate,{...candidate.post,status},now),'original_status_'+status);
  candidate.post.packet_id='old';candidate.post.packet_code='ABCD1234';
  assert.equal(app.originalRecheckReason(candidate,{...packet().post,packet_id:'new'},now),'packet_id_changed');
  assert.equal(app.originalRecheckReason(candidate,{...packet().post,packet_code:'WXYZ1234'},now),'packet_code_changed');
  assert.equal(app.originalRecheckReason(candidate,packet().post,now),null,'omitted anonymous identity is not a changed packet');
});

test('stale rejections back off, including legacy records; sent and uncertain stay protected',()=>{
  const key=recordKey(packet()),state={items:{[key]:{state:'skipped_stale',updated_at:now}}};
  assert.equal(app.deliverySkipReason(state,[key],now+2*60000),'original_recheck_cooldown');
  assert.equal(app.deliverySkipReason(state,[key],now+15*60000),'previously_stale');
  state.items[key].retry_at=now+20*60000;
  assert.equal(app.deliverySkipReason(state,[key],now+16*60000),'original_recheck_cooldown');
  state.items[key].state='uncertain';
  assert.equal(app.deliverySkipReason(state,[key],now+86400000),'delivery_uncertain');
  state.items[key].state='sent';
  assert.equal(app.deliverySkipReason(state,[key],now+86400000),'already_sent');
  assert.equal(app.deliverySkipReason(state,[],now),null,'another post can proceed');
});

test('delivery order starts with a packet/quiz and keeps verified live alerts moving',()=>{
  const a=packet('123'),b=packet('456'),live={key:'live:789',post:{kind:'live'}};
  assert.deepEqual(app.orderDeliveryCandidates([live,a,b]).map(c=>c.key),[a.key,live.key,b.key]);
});

const clone=value=>JSON.parse(JSON.stringify(value));
function storageFixture(onWrite) {
  const waits=[],storage=new app.GitHubState({GITHUB_REPOSITORY:'owner/repo',GITHUB_REF_NAME:'test',GH_STATE_TOKEN:'offline'},async ms=>waits.push(ms));
  let remote={version:1,items:{},enabled_destination:null},writes=0,reads=0;
  storage.readLatest=async()=>{reads++;storage.sha='blob-'+reads;return clone(remote);};
  storage.request=async(method,body)=>{
    assert.equal(method,'PUT');writes++;
    const pending=JSON.parse(Buffer.from(body.content,'base64').toString('utf8'));
    return onWrite({writes,pending,commit:()=>{remote=clone(pending);}});
  };
  return {storage,waits,counts:()=>({writes,reads})};
}
const response=(status,body)=>new Response(JSON.stringify(body),{status});

test('GitHub HTTP 500 before commit reconciles history then retries successfully',async()=>{
  const f=storageFixture(({writes,commit})=>{
    if(writes===1)return response(500,{message:'temporary'});
    commit();return response(200,{content:{sha:'confirmed'}});
  });
  const state=await f.storage.load();state.items.receipt={state:'queued'};
  await f.storage.save(state,'offline test');
  assert.deepEqual(f.counts(),{writes:2,reads:2});
  assert.deepEqual(state.items.receipt,{state:'queued',identity_keys:[]});
  assert.deepEqual(f.waits,[1000]);
});

test('lost acknowledgment after committed write does not repeat that write',async()=>{
  const f=storageFixture(({commit})=>{commit();return response(500,{message:'ack lost'});});
  const state=await f.storage.load();state.items.receipt={state:'sending',claim_id:'one'};
  await f.storage.save(state,'claim before send');
  assert.deepEqual(f.counts(),{writes:1,reads:2});
  assert.equal(state.items.receipt.claim_id,'one');
});

test('unconfirmed repeated state failures stop after three writes',async()=>{
  const f=storageFixture(()=>response(503,{message:'unavailable'}));
  const state=await f.storage.load();state.items.receipt={state:'sending'};
  await assert.rejects(f.storage.save(state,'claim before send'),/persistence not confirmed after 3/);
  assert.equal(f.counts().writes,3);
});

test('state conflict merge preserves sent/uncertain receipts and removes legacy codes from active queues',()=>{
  const c=packet(),key=recordKey(c),code={key:'code:ABCD1234',post:{...c.post,kind:'code',status:'unverified_code'}};
  const base={version:1,items:{},enabled_destination:destination};
  const local={...clone(base),items:{[key]:{state:'sending',claim_id:'local'}},
    outbox:{[code.key]:{candidate:code,observed_at:now}},public_feed:{[code.key]:{candidate:code,observed_at:now}}};
  for(const status of ['sent','uncertain']) {
    const remote={...clone(base),items:{[key]:{state:status,claim_id:'other',message_id:'42'}}};
    const merged=app.mergeDeliveryState(base,local,remote);
    assert.equal(merged.items[key].state,status);
    assert.deepEqual(merged.outbox,{});assert.deepEqual(merged.public_feed,{});
  }
});
