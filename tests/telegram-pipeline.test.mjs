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

test('three two-minute rounds cover six extra languages and retain the existing feeds',()=>{
  const covered=new Set();
  for(let round=0;round<3;round++) {
    const stamp=round*120000,rotating=app.rotatingFeedLanguages(stamp);
    assert.equal(rotating.length,2);
    rotating.forEach(language=>covered.add(language));
    const tasks=app.buildDiscoveryFeeds('posts',stamp);
    for(const language of ['en','ru','zh-CN',...rotating]) {
      assert.ok(tasks.some(t=>t.language===language && t.tag.includes(':type2:')));
      assert.ok(tasks.some(t=>t.language===language && t.tag.includes(':discover')));
    }
    assert.ok(tasks.every(t=>!/(?:redpacketcode|cryptobox)/i.test(t.tag)));
    assert.ok(tasks.length<=48,'feed expansion stays bounded');
  }
  assert.equal(covered.size,6);
});

test('fresh global heads run before archive pagination while every existing packet tag stays enabled',()=>{
  const tasks=app.buildDiscoveryFeeds('posts',0),page=t=>Number(t.tag.match(/:page(\d+)$/)?.[1]||1);
  const firstDeep=tasks.findIndex(t=>page(t)>1);
  assert.ok(firstDeep>0);
  assert.ok(tasks.slice(firstDeep).every(t=>page(t)>1));
  assert.ok(tasks[0].tag.includes(':type2:'));
  for(const tag of ['redpacket','redpacketgiveawaycampaign','binanceredpacket','redpacketmission','redpacketquiz','红包'])
    assert.ok(tasks.some(t=>t.tag===tag));
  assert.deepEqual(app.buildDiscoveryFeeds('authors',0),[]);
  assert.ok(app.buildDiscoveryFeeds('community',0).some(t=>t.language==='ar'));
});

test('original check slots reach strong packet hints before same-age emoji-only posts',()=>{
  const weak=Array.from({length:110},(_,i)=>({id:String(1000+i),date:now-60000,title:'🎁'}));
  const strong={id:'9999',date:now-60000,isAssociateRedEnvelop:true};
  const chosen=app.chooseMarkerPosts([...weak,strong],{},now);
  assert.equal(chosen.length,96);
  assert.equal(chosen[0].id,strong.id);
  assert.ok(!app.chooseMarkerPosts([strong],{[strong.id]:now-60000},now).length,'recent checks still cool down');
});

test('local packet phrases are discovery hints while code-only text stays ineligible',()=>{
  for(const title of ['Sobre rojo','Pacote vermelho','Kırmızı paket','Enveloppe rouge','Lì xì','Angpao','紅包']) {
    const raw={id:'9999',title};
    assert.ok(app.searchMarkers(raw).includes('regional:packet'),title);
    assert.equal(app.normalize(raw,'test'),null,'words alone never verify a packet');
    assert.equal(app.isEligiblePost({kind:'code',status:'unverified_code',published_codes:['ABCD1234']}),false);
  }
});

test('profile exploration expands without displacing the active publisher allocation',()=>{
  const authors=[
    ...Array.from({length:150},(_,i)=>({uid:'active_'+String(i).padStart(5,'0'),last_packet_at:now-60000})),
    ...Array.from({length:150},(_,i)=>({uid:'discover_'+String(i).padStart(5,'0'),discovered:true,last_marker_at:now-60000})),
    ...Array.from({length:150},(_,i)=>({uid:'follow_'+String(i).padStart(5,'0'),followed:true}))
  ];
  const selected=app.chooseFastAuthors(authors,now);
  assert.equal(selected.length,320);
  assert.equal(new Set(selected.map(a=>a.uid)).size,320);
  assert.equal(selected.filter(a=>a.scan_reason==='active_packet_publisher').length,128);
  assert.equal(selected.filter(a=>a.scan_reason==='discovery').length,96);
  assert.equal(selected.filter(a=>a.scan_reason==='following').length,96);
});

// ---- USD-equivalent valuation of non-stable reward coins ----
const tick=(symbol,lastPrice,quoteVolume)=>({symbol,lastPrice:String(lastPrice),quoteVolume:String(quoteVolume)});
const marketTickers=()=>[tick('BTCUSDT',100000,5e9),tick('BNBUSDT',600,1e9),tick('ETHUSDT',4000,2e9),
  tick('DOGEUSDT',0.2,5e8),tick('SOLUSDT',200,9e8),tick('SOLBTC',0.002,100),tick('TINYUSDT',0.5,50),
  tick('ALTBNB',0.01,1000),...Array.from({length:120},(_,i)=>tick('COIN'+i+'USDT',1,1e6))];
const fmt=(post,lang)=>app.formatTelegramPost(post,lang).text;
const market=()=>app.buildUsdMarket(marketTickers(),now);
const coinPacket=(currency,amount,places,id='900')=>{const p=packet(id);
  return {...p,post:{...p.post,currency,available_amount:amount,available_receivers:places}};};

test('non-stable coins convert to USD via direct pairs, bridge pairs and best liquidity',()=>{
  const m=market();
  assert.equal(app.usdPrice('USDT',m).price,1);
  assert.equal(app.usdPrice('DOGE',m).price,0.2);
  assert.equal(app.usdPrice('SOL',m).route,'SOLUSDT','direct pair with the deepest market wins over BTC bridge');
  assert.ok(Math.abs(app.usdPrice('ALT',m).price-6)<1e-9,'ALTBNB * BNBUSDT');
  assert.equal(app.usdPrice('NOPE',m),null);
  assert.equal(app.usdPrice('DOGE',null),null);
});

test('valuation computes average in USD and flags thin markets',()=>{
  const m=market();
  const doge=app.valuation(coinPacket('DOGE',100,10).post,m);
  assert.ok(Math.abs(doge.avg_usd-2)<1e-9);assert.equal(doge.liquid,true);
  const tiny=app.valuation(coinPacket('TINY',100,10).post,m);
  assert.equal(tiny.liquid,false);
  assert.equal(app.valuation(coinPacket('NOPE',100,10).post,m),null);
  assert.equal(app.valuation(packet().post,m),null,'no amount, no valuation');
});

test('valuedPost does not mutate input and skips live alerts',()=>{
  const m=market(),c=coinPacket('DOGE',100,10);
  const v=app.valuedPost(c.post,m);
  assert.equal(c.post.valuation,undefined);assert.ok(v.valuation);
  const live={kind:'live'};assert.equal(app.valuedPost(live,m),live);
  assert.equal(app.valuedPost(c.post,null),c.post);
});

test('message shows coin and USD amounts, marks large only for liquid coins (RU/EN)',()=>{
  const m=market();
  const big=app.valuedPost(coinPacket('DOGE',100,10).post,m);
  const ru=fmt(big,'ru'),en=fmt(big,'en');
  assert.match(ru,/В среднем ≈ 10 DOGE \(≈ 2 \$\) на человека/);assert.match(ru,/Крупный пакет/);
  assert.match(en,/Average ≈ 10 DOGE \(≈ 2 \$\) per person/);assert.match(en,/Large packet/);
  const small=fmt(app.valuedPost(coinPacket('DOGE',10,10).post,m),'ru');
  assert.match(small,/\(≈ 0\.2 \$\)/);assert.doesNotMatch(small,/Крупный/);
  const thin=fmt(app.valuedPost(coinPacket('TINY',100000,10).post,m),'ru');
  assert.doesNotMatch(thin,/Крупный/);assert.doesNotMatch(thin,/\$\)/);assert.match(thin,/мало торгуется/);
  const unpriced=fmt(coinPacket('NOPE',100,10).post,'ru');
  assert.match(unpriced,/В среднем ≈ 10 NOPE на человека/);
  const usdt=fmt(coinPacket('USDT',20,10).post,'ru');
  assert.match(usdt,/≈ 2 \$ на человека/);assert.match(usdt,/Крупный/);
});

test('delivery order ranks liquid USD-equivalent rewards alongside stable coins',()=>{
  const m=market();
  const stable=coinPacket('USDT',30,10,'1'),doge=coinPacket('DOGE',500,10,'2'),thin=coinPacket('TINY',1e6,10,'3'),
    none=coinPacket('NOPE',1e6,10,'4');
  const items=[stable,doge,thin,none].map(c=>({...c,post:app.valuedPost(c.post,m)}));
  // DOGE: 500*0.2/10 = 10 $ > USDT 3 $; thin and unpriced coins fall back behind
  assert.deepEqual(app.orderDeliveryCandidates(items).map(c=>c.key).slice(0,2),[doge.key,stable.key]);
});

test('price loading falls back to second endpoint, validates data, and fails safely',async()=>{
  app.resetUsdMarketCache();
  const calls=[],good=new Response(JSON.stringify(marketTickers()),{status:200});
  const fetchImpl=async url=>{calls.push(url);return url.startsWith('https://api.binance.com')?new Response('x',{status:451}):good;};
  const m=await app.loadUsdMarket({fetchImpl,now:1000});
  assert.equal(m.source,'https://data-api.binance.vision');assert.equal(calls.length,2);
  await app.loadUsdMarket({fetchImpl:async()=>{throw new Error('must be cached');},now:2000});
  app.resetUsdMarketCache();
  await assert.rejects(app.loadUsdMarket({fetchImpl:async()=>new Response('[]',{status:200}),now:5000}),/unavailable/);
  await assert.rejects(app.loadUsdMarket({fetchImpl:async()=>{throw new Error('offline');},now:5000}),/unavailable/);
  app.resetUsdMarketCache();
});

// ---- small public feed file for the website ----
test('public feed file is small, worker-compatible, and skips unchanged writes',async()=>{
  const a=packet('810'),b=packet('811');
  const state={items:{big:{state:'sent'}},authors:Array.from({length:50},(_,i)=>({uid:'u'+i})),
    public_feed:{[a.key]:{candidate:a,observed_at:now},[b.key]:{candidate:b,observed_at:now-1000},
      'code:ZZZZ1234':{candidate:{key:'code:ZZZZ1234',post:{...a.post,kind:'code',published_codes:['ZZZZ1234']}},observed_at:now}}};
  const file=app.buildPublicFeedFile(state,now);
  assert.equal(file.version,1);assert.deepEqual(file.items,{});
  assert.deepEqual(Object.keys(file.public_feed).sort(),[a.key,b.key]);
  assert.equal(file.authors,undefined);assert.equal(file.outbox,undefined);
  const env={GITHUB_REPOSITORY:'o/r',GITHUB_REF_NAME:'main',GH_STATE_TOKEN:'t'};
  const calls=[];let remote=null;
  const fetchImpl=async(url,init={})=>{
    calls.push(init.method||'GET');
    if((init.method||'GET')==='GET')return remote?new Response(JSON.stringify({sha:'s1',content:remote}),{status:200}):new Response('{}',{status:404});
    const sent=JSON.parse(init.body);assert.match(sent.message,/\[skip ci\]/);remote=sent.content;return new Response('{}',{status:200});
  };
  assert.equal((await app.exportPublicFeed(env,state,{fetchImpl,now})).changed,true);
  assert.deepEqual(calls,['GET','PUT']);
  // only observed_at moved, file is fresh: no new commit
  const moved={...state,public_feed:Object.fromEntries(Object.entries(state.public_feed).map(([k,e])=>[k,{...e,observed_at:now+60000}]))};
  assert.equal((await app.exportPublicFeed(env,moved,{fetchImpl,now:now+60000})).changed,false);
  assert.equal(calls.length,3);
  // a new finding or a stale file triggers a write
  const c=packet('812');
  assert.equal((await app.exportPublicFeed(env,{...state,public_feed:{...state.public_feed,[c.key]:{candidate:c,observed_at:now}}},{fetchImpl,now:now+60000})).changed,true);
  assert.equal((await app.exportPublicFeed(env,state,{fetchImpl,now:now+16*60000})).changed,true);
  await assert.rejects(app.exportPublicFeed(env,state,{fetchImpl:async()=>new Response('x',{status:500}),now}),/HTTP 500/);
});
