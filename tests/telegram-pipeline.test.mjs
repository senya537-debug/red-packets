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

test('global discovery does not rotate or filter by publication language',()=>{
  for(let round=0;round<3;round++) {
    assert.deepEqual(app.rotatingFeedLanguages(round*120000),[]);
    const tasks=app.buildDiscoveryFeeds('posts',round*120000);
    assert.ok(tasks.some(t=>t.tag==='square:global:type1:page1'));
    assert.ok(tasks.some(t=>t.tag==='square:global:type2:page1'));
    assert.ok(tasks.some(t=>t.tag==='square:discover'));
    assert.ok(tasks.every(t=>!/:global:(?:ru|zh-CN|es|pt-BR|tr|fr|vi|id):/.test(t.tag)));
    assert.ok(tasks.every(t=>!/(?:redpacketcode|cryptobox)/i.test(t.tag)));
    assert.ok(tasks.length<=32,'language-neutral feed expansion stays bounded');
  }
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

test('personal following has no dedicated scan quota; global discoveries and active publishers fill the budget',()=>{
  const authors=[
    ...Array.from({length:150},(_,i)=>({uid:'active_'+String(i).padStart(5,'0'),last_packet_at:now-60000})),
    ...Array.from({length:220},(_,i)=>({uid:'discover_'+String(i).padStart(5,'0'),discovered:true,last_marker_at:now-60000})),
    ...Array.from({length:150},(_,i)=>({uid:'follow_'+String(i).padStart(5,'0'),followed:true}))
  ];
  const selected=app.chooseFastAuthors(authors,now);
  assert.equal(selected.length,320);
  assert.equal(new Set(selected.map(a=>a.uid)).size,320);
  assert.equal(selected.filter(a=>a.scan_reason==='active_packet_publisher').length,128);
  assert.equal(selected.filter(a=>a.scan_reason==='discovery').length,192);
  assert.equal(selected.filter(a=>a.scan_reason==='following').length,0);
});

test('outbox and public feed retain the highest verified stablecoin reward-per-place candidates',()=>{
  const entries={};
  for(let i=0;i<205;i++) {
    const candidate=packet(String(10000+i));
    candidate.post.currency='USDT';
    candidate.post.available_amount=i===0?100:0.1;
    candidate.post.available_receivers=10;
    entries[candidate.key]={candidate,observed_at:now-i};
  }
  const outbox=app.compactOutbox(entries,{},now);
  const feed=app.compactPublicFeed(entries,now);
  assert.equal(Object.keys(outbox).length,200);
  assert.equal(Object.keys(feed).length,200);
  assert.ok(outbox['post:10000'],'best reward-per-place survives outbox compaction');
  assert.ok(feed['post:10000'],'best reward-per-place survives public-feed compaction');
  assert.ok(!outbox['post:10204'],'lowest-priority tail is trimmed first');
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
  const minute=60000,c=packet('812');
  const withNew={...state,public_feed:{...state.public_feed,[c.key]:{candidate:c,observed_at:now}}};
  // only observed_at moved: no commit
  const moved={...state,public_feed:Object.fromEntries(Object.entries(state.public_feed).map(([k,e])=>[k,{...e,observed_at:now+minute}]))};
  assert.equal((await app.exportPublicFeed(env,moved,{fetchImpl,now:now+minute})).changed,false);
  // a real change is held back until 10 minutes after the previous write
  assert.equal((await app.exportPublicFeed(env,withNew,{fetchImpl,now:now+9*minute})).changed,false);
  assert.equal(calls.filter(m=>m==='PUT').length,1);
  assert.equal((await app.exportPublicFeed(env,withNew,{fetchImpl,now:now+11*minute})).changed,true);
  assert.equal(calls.filter(m=>m==='PUT').length,2);
  // an unchanged feed refreshes only after 30 minutes
  assert.equal((await app.exportPublicFeed(env,withNew,{fetchImpl,now:now+30*minute})).changed,false);
  assert.equal((await app.exportPublicFeed(env,withNew,{fetchImpl,now:now+42*minute})).changed,true);
  await assert.rejects(app.exportPublicFeed(env,state,{fetchImpl:async()=>new Response('x',{status:500}),now}),/HTTP 500/);
});

// ---- total amount and competition (comments) when Square hides per-person figures ----
const totalPacket=(currency,amount,comments,id)=>{const p=coinPacket(currency,null,null,id);
  return {...p,post:{...p.post,available_amount:null,available_receivers:null,amount:String(amount),comments}};};

test('normalize keeps total amount and comment count',()=>{
  const post=app.normalize({id:'123456',commentCount:20,redEnvelop:{currency:'USDT',amount:'5',availableAmount:null,
    quiz:'q',type:1,isExpired:false,isRunOut:false,expiredTime:Date.now()+3600000}},'t');
  assert.equal(post.comments,20);assert.equal(post.amount,'5');assert.equal(post.available_amount,null);
  assert.equal(app.normalize({id:'123457',redEnvelop:{currency:'USDT',quiz:'q'}},'t').comments,null);
});

test('message shows total amount, competition estimate and honest wording (RU/EN)',()=>{
  const m=market();
  const low=app.valuedPost(totalPacket('USDT',5,5,'950').post,m);
  const ru=fmt(low,'ru'),en=fmt(low,'en');
  assert.match(ru,/Всего в пакете ≈ 5 \$/);assert.match(ru,/Square не показывает/);
  assert.match(ru,/Комментариев: 5 · ≈ 1 \$ на комментатора \(оценка\)/);assert.match(ru,/мало конкурентов/);
  assert.match(en,/Total in the packet ≈ 5 \$/);assert.match(en,/per commenter \(estimate\)/);assert.match(en,/little competition/);
  assert.doesNotMatch(ru,/на человека/);
  const crowded=fmt(app.valuedPost(totalPacket('USDT',5,500,'951').post,m),'ru');
  assert.match(crowded,/≈ 0\.01 \$ на комментатора/);assert.doesNotMatch(crowded,/мало конкурентов/);
  const noComments=fmt(app.valuedPost(totalPacket('USDT',5,null,'952').post,m),'ru');
  assert.match(noComments,/Всего в пакете ≈ 5 \$/);assert.doesNotMatch(noComments,/Комментариев/);
  const doge=fmt(app.valuedPost(totalPacket('DOGE',100,10,'953').post,m),'ru');
  assert.match(doge,/Всего в пакете ≈ 100 DOGE \(≈ 20 \$\)/);assert.match(doge,/≈ 2 \$ на комментатора/);
  const thin=fmt(app.valuedPost(totalPacket('TINY',100000,2,'954').post,m),'ru');
  assert.doesNotMatch(thin,/на комментатора/);assert.doesNotMatch(thin,/мало конкурентов/);assert.match(thin,/мало торгуется/);
  const unpriced=fmt(app.valuedPost(totalPacket('NOPE',77,2,'955').post,m),'ru');
  assert.match(unpriced,/Всего в пакете ≈ 77 NOPE/);assert.doesNotMatch(unpriced,/\$\)/);
  assert.match(fmt(coinPacket('USDT',null,null,'956').post,'ru'),/Размер награды неизвестен/);
});

test('delivery order prefers a big total with few comments, then unknowns',()=>{
  const m=market();
  const exact=coinPacket('USDT',30,10,'960'),     // real average 3 $
    quiet=totalPacket('USDT',5,5,'961'),          // 1 $ per commenter
    crowded=totalPacket('USDT',50,500,'962'),     // 0.1 $ per commenter
    unknownComments=totalPacket('USDT',2,null,'963'), // 2 / 50 assumed
    nothing=coinPacket('USDT',null,null,'964');
  const items=[nothing,crowded,unknownComments,quiet,exact].map(c=>({...c,post:app.valuedPost(c.post,m)}));
  assert.deepEqual(app.orderDeliveryCandidates(items).map(c=>c.key).slice(0,4),[exact.key,quiet.key,crowded.key,unknownComments.key]);
});

// ---- watchdog: private alerts and healthcheck ping ----
test('watchdog findings cover errors, failed searches, price outage and silence',()=>{
  const hour=3600000,sentState=(ageH,seenH)=>({items:{a:{state:'sent',updated_at:now-ageH*hour},b:{state:'queued',updated_at:now}},
    public_feed:{x:{observed_at:now-seenH*hour}}});
  assert.deepEqual(app.watchdogFindings({},sentState(1,1),now),{});
  const f=app.watchdogFindings({last_error:'boom',workers:{posts:{status:'done'},live:{status:'failed'}},usd_prices:{ok:false,error:'HTTP 451'}},sentState(5,4),now);
  assert.deepEqual(Object.keys(f).sort(),['no_discovery','no_sends','prices_down','run_error','search_failed']);
  assert.match(f.search_failed,/live/);assert.match(f.no_sends,/5 ч/);
  assert.deepEqual(app.watchdogFindings({usd_prices:{ok:true}},{items:{},public_feed:{}},now),{},'empty history is not an outage');
});

test('watchdog throttles repeats, resends after cooldown and reports recovery once',()=>{
  const hour=3600000;
  let plan=app.planWatchdog({run_error:'e'},{},now);
  assert.equal(plan.messages.length,1);assert.match(plan.messages[0],/^⚠️/);
  const again=app.planWatchdog({run_error:'e'},plan.next,now+10*60000);
  assert.deepEqual(again.messages,[]);assert.equal(again.next.run_error.last_sent,now);
  assert.equal(app.planWatchdog({run_error:'e'},plan.next,now+hour+1).messages.length,1);
  const ok=app.planWatchdog({},plan.next,now+hour);
  assert.equal(ok.messages.length,1);assert.match(ok.messages[0],/^✅/);assert.deepEqual(ok.next,{});
  assert.deepEqual(app.planWatchdog({},ok.next,now+2*hour).messages,[]);
  assert.equal(app.planWatchdog({prices_down:'p'},{prices_down:{last_sent:now,active:true}},now+5*hour).messages.length,0,'price outage waits 6h');
});

test('runWatchdog is a no-op without settings, alerts privately, and persists only on change',async()=>{
  const base={GITHUB_REPOSITORY:'o/r',GITHUB_REF_NAME:'main',GH_STATE_TOKEN:'t'};
  const state={items:{},public_feed:{}},calls=[];
  const fetchImpl=async()=>{calls.push('x');return new Response('{}',{status:200});};
  assert.deepEqual(await app.runWatchdog(base,{},state,{fetchImpl,now}),{alerts:false,ping:false,sent:0});
  assert.equal(calls.length,0);
  // alert path
  let remote=null;const sent=[],puts=[];
  const gh=async(url,init={})=>{
    if(!String(url).includes('api.github.com'))return new Response('',{status:200});
    if((init.method||'GET')==='GET')return remote?new Response(JSON.stringify({sha:'s',content:remote}),{status:200}):new Response('{}',{status:404});
    puts.push(1);remote=JSON.parse(init.body).content;return new Response('{}',{status:200});
  };
  const telegram=async(env,method,payload)=>{sent.push(payload);return {ok:true,status:200};};
  const env={...base,TG_ALERT_CHAT_ID:'42'};
  const first=await app.runWatchdog(env,{last_error:'boom'},state,{fetchImpl:gh,telegram,now});
  assert.equal(first.sent,1);assert.equal(sent[0].chat_id,'42');assert.match(sent[0].text,/boom/);assert.equal(puts.length,1);
  const second=await app.runWatchdog(env,{last_error:'boom'},state,{fetchImpl:gh,telegram,now:now+60000});
  assert.equal(second.sent,0);assert.equal(puts.length,1,'no commit when nothing changed');
  const healthy=await app.runWatchdog(env,{},state,{fetchImpl:gh,telegram,now:now+120000});
  assert.equal(healthy.sent,1);assert.match(sent[1].text,/Восстановилось/);
  // healthcheck: success vs fail ping, strict URL
  const pings=[];const hc=async url=>{pings.push(String(url));return new Response('',{status:200});};
  const withPing={...base,HEALTHCHECK_URL:'https://hc-ping.com/abc-123'};
  await app.runWatchdog(withPing,{},state,{fetchImpl:hc,now});
  await app.runWatchdog(withPing,{last_error:'x'},state,{fetchImpl:hc,now});
  assert.deepEqual(pings,['https://hc-ping.com/abc-123','https://hc-ping.com/abc-123/fail']);
  const bad=await app.runWatchdog({...base,HEALTHCHECK_URL:'https://evil.example/x'},{},state,{fetchImpl:hc,now});
  assert.match(bad.ping_error,/hc-ping/);assert.equal(pings.length,2);
});

// ---- daily digest ----
const feedEntry=(c,observed=now)=>({candidate:c,observed_at:observed});
const dailyState=()=>{
  const q=totalPacket('USDT',5,5,'970'),crowded=totalPacket('USDT',5,500,'971'),doge=totalPacket('DOGE',100,10,'972'),
    none=coinPacket('USDT',null,null,'973'),old=totalPacket('USDT',9,1,'974');
  old.post.published_at=new Date(now-3*86400000).toISOString();
  return {items:{},public_feed:Object.fromEntries([q,crowded,doge,none,old].map(c=>[c.key,feedEntry(c)]))};
};

test('daily report is due once per UTC day after the report hour and respects claims',()=>{
  const at=h=>Date.UTC(2026,9,30,h,0,0),dest='d'.repeat(64),key=dest+':daily:2026-10-30';
  assert.equal(app.dailyReportDue({items:{}},dest,at(6)),null,'too early');
  assert.equal(app.dailyReportDue({items:{}},dest,at(7)),key);
  for(const state of ['sent','uncertain','sending'])assert.equal(app.dailyReportDue({items:{[key]:{state}}},dest,at(9)),null);
  assert.equal(app.dailyReportDue({items:{[key]:{state:'queued',retry_at:at(9)+1000}}},dest,at(9)),null,'cooldown after a definite failure');
  assert.equal(app.dailyReportDue({items:{[key]:{state:'queued',retry_at:at(9)-1}}},dest,at(9)),key);
  assert.equal(app.dailyReportDue({items:{[key]:{state:'sent'}}},dest,Date.UTC(2026,9,31,8)),dest+':daily:2026-10-31','next day is due again');
});

test('daily report summarizes the feed honestly and ranks by estimated amount per commenter',()=>{
  const m=market(),report=app.buildDailyReport(dailyState(),m,now);
  assert.equal(report.active,5);assert.equal(report.fresh,4,'three-day-old post is not new');
  assert.equal(report.known,4);
  // per commenter: 974 = 9 $, 972 (20 $ of DOGE / 10) = 2 $, 970 = 1 $, 971 = 0.01 $; 973 has no amount
  assert.deepEqual(report.top.map(p=>p.post_id),['974','972','970','971']);
  assert.equal(report.notable,3,'only estimates of 0.5 $ or more count');
  const ru=app.formatDailyReport(report,'ru').text,en=app.formatDailyReport(report,'en').text;
  assert.match(ru,/итоги суток/);assert.match(ru,/Новых пакетов и викторин за 24 ч: <b>4<\/b>/);assert.match(ru,/Square не показывает/);
  assert.match(en,/daily summary/);assert.match(en,/<a href="https:\/\/www\.binance\.com\/en\/square\/post\/\d+">post<\/a>/);
  assert.equal(app.buildDailyReport({items:{},public_feed:{}},m,now),null,'nothing to report, nothing is sent');
});

test('publishDailyReport claims before sending, sends once and never throws into delivery',async()=>{
  const dest='d'.repeat(64),at=Date.UTC(2026,9,30,8,0,0),saves=[],sends=[];
  const state=dailyState();state.public_feed=Object.fromEntries(Object.entries(state.public_feed).map(([k,e])=>[k,{...e,observed_at:at}]));
  for(const e of Object.values(state.public_feed))e.candidate.post.expires_at=new Date(at+3600000).toISOString(),e.candidate.post.published_at=new Date(at-3600000).toISOString();
  state.enabled_destination='base';state.enabled_topic_signature=null;
  const configuration={base:'base',signature:null},stats={connection_failures:0,uncertain:0};
  const storage={save:async(s,reason)=>{saves.push([reason,s.items[dest+':daily:2026-10-30']?.state]);}};
  const send=async(env,chat,message)=>{sends.push(message);return {ok:true,message_id:'77'};};
  const args=[state,storage,{},'-100',configuration,dest,'ru',async()=>{},null,stats,market(),{send,now:at}];
  await app.publishDailyReport(...args);
  assert.deepEqual(saves.map(x=>x[1]),['sending','sent'],'claim persisted before the message goes out');
  assert.equal(sends.length,1);assert.equal(stats.daily_report_sent,1);
  await app.publishDailyReport(...args);
  assert.equal(sends.length,1,'second pump in the same day does nothing');
  // uncertain delivery is never retried
  const s2={...state,items:{}},stats2={connection_failures:0,uncertain:0};
  await app.publishDailyReport(s2,storage,{},'-100',configuration,dest,'ru',async()=>{},null,stats2,market(),
    {send:async()=>({ok:false,uncertain:true,error:'unclear'}),now:at});
  assert.equal(s2.items[dest+':daily:2026-10-30'].state,'uncertain');assert.equal(stats2.uncertain,1);
  assert.equal(app.dailyReportDue(s2,dest,at+3600000),null);
  // a failing store or send is reported, not thrown
  const s3={...state,items:{}},stats3={connection_failures:0,uncertain:0};
  await app.publishDailyReport(s3,{save:async()=>{throw new Error('github down');}},{},'-100',configuration,dest,'ru',async()=>{},null,stats3,market(),{send,now:at});
  assert.match(stats3.daily_report_error,/github down/);
  // wrong destination configuration sends nothing
  const s4={...state,items:{},enabled_destination:'other'};
  const before=sends.length;
  await app.publishDailyReport(s4,storage,{},'-100',configuration,dest,'ru',async()=>{},null,{connection_failures:0,uncertain:0},market(),{send,now:at});
  assert.equal(sends.length,before);
});

// ---- one commit for all search workers ----
test('enqueueSnapshots writes all workers in a single commit and keeps each worker status',async()=>{
  const proto=app.GitHubState.prototype,saved={readLatest:proto.readLatest,request:proto.request};
  const remote={version:1,items:{},enabled_destination:null};const commits=[];
  proto.readLatest=async function(){this.sha='s'+commits.length;return clone(remote);};
  proto.request=async function(method,body){
    const pending=JSON.parse(Buffer.from(body.content,'base64').toString('utf8'));
    commits.push(body.message);Object.assign(remote,clone(pending));
    return response(200,{content:{sha:'c'+commits.length}});
  };
  try {
    const env={GITHUB_REPOSITORY:'o/r',GITHUB_REF_NAME:'main',GH_STATE_TOKEN:'ghs_testtoken0123456789',GITHUB_RUN_ID:'77',GITHUB_RUN_ATTEMPT:'1'};
    const live={...packet('990').post,kind:'quiz'};
    const entries=[
      {worker:'posts',status:'done',snapshot:{reported_open:[packet('991').post],other_candidates:[]}},
      {worker:'authors',status:'done',snapshot:{reported_open:[packet('992').post],other_candidates:[],packet_authors:[{uid:'author-uid-0001',name:'a'}]}},
      {worker:'live',status:'failed',error:'boom',snapshot:{reported_open:[],other_candidates:[]}},
      {worker:'community',status:'done',snapshot:{reported_open:[live],other_candidates:[]}}];
    const results=await app.enqueueSnapshots(entries,env,async()=>{});
    assert.equal(commits.length,1,'one commit, not one per worker');assert.match(commits[0],/enqueue workers/);
    assert.deepEqual(results.map(r=>r.worker),['posts','authors','live','community']);
    const runs=remote.worker_runs['77:1'];
    assert.deepEqual(Object.fromEntries(Object.entries(runs).map(([w,r])=>[w,r.status])),{posts:'done',authors:'done',live:'failed',community:'done'});
    assert.match(runs.live.error,/boom/);
    const keys=Object.keys(remote.public_feed);
    assert.ok(['post:991','post:992','post:990'].every(k=>keys.includes(k)),'findings from every worker are kept');
    assert.deepEqual(remote.authors.map(a=>a.uid),['author-uid-0001']);
    // single-worker calls keep the old commit message and behaviour
    commits.length=0;
    await app.enqueueSnapshot({reported_open:[],other_candidates:[]},env,'posts','done',null,async()=>{});
    assert.deepEqual(commits,['Red Packet delivery: enqueue posts [skip ci]']);
    await assert.rejects(app.enqueueSnapshots([{worker:'nope',snapshot:{}}],env,async()=>{}),/Unknown search worker/);
  } finally {Object.assign(proto,saved);}
});

test('a worker whose findings cannot be applied is recorded as failed and the others still save',async()=>{
  const proto=app.GitHubState.prototype,saved={readLatest:proto.readLatest,request:proto.request};
  const remote={version:1,items:{},enabled_destination:null};let writes=0;
  proto.readLatest=async function(){this.sha='s';return clone(remote);};
  proto.request=async function(method,body){writes++;Object.assign(remote,clone(JSON.parse(Buffer.from(body.content,'base64').toString('utf8'))));return response(200,{content:{sha:'c'}});};
  try {
    const env={GITHUB_REPOSITORY:'o/r',GITHUB_REF_NAME:'main',GH_STATE_TOKEN:'ghs_testtoken0123456789',GITHUB_RUN_ID:'78',GITHUB_RUN_ATTEMPT:'1'};
    const poison={get reported_open(){throw new Error('corrupt findings');},other_candidates:[]};
    await app.enqueueSnapshots([
      {worker:'posts',status:'done',snapshot:{reported_open:[packet('993').post],other_candidates:[]}},
      {worker:'authors',status:'done',snapshot:poison},
      {worker:'live',status:'done',snapshot:{reported_open:[packet('994').post],other_candidates:[]}}],env,async()=>{});
    assert.equal(writes,1);
    const runs=remote.worker_runs['78:1'];
    assert.equal(runs.authors.status,'failed');assert.match(runs.authors.error,/corrupt findings/);
    assert.equal(runs.posts.status,'done');assert.equal(runs.live.status,'done');
    assert.ok(['post:993','post:994'].every(k=>k in remote.public_feed));
  } finally {Object.assign(proto,saved);}
});

test('importSearchResults saves four result files in one commit and marks a missing file failed',async()=>{
  const proto=app.GitHubState.prototype,saved={readLatest:proto.readLatest,request:proto.request};
  const remote={version:1,items:{},enabled_destination:null},commits=[];
  proto.readLatest=async function(){this.sha='s';return clone(remote);};
  proto.request=async function(method,body){commits.push(body.message);Object.assign(remote,clone(JSON.parse(Buffer.from(body.content,'base64').toString('utf8'))));return response(200,{content:{sha:'c'}});};
  const dir=fs.mkdtempSync(new URL('../',import.meta.url).pathname+'.tmp-results-');
  try {
    const env={GITHUB_REPOSITORY:'o/r',GITHUB_REF_NAME:'main',GH_STATE_TOKEN:'ghs_testtoken0123456789',GITHUB_RUN_ID:'80',
      GITHUB_RUN_ATTEMPT:'1',SQUARE_RESULT_DIR:dir};
    const file=(worker,id)=>fs.writeFileSync(dir+'/'+worker+'.json',JSON.stringify({version:1,worker,run_id:'80',run_attempt:1,status:'done',
      snapshot:{reported_open:[packet(id).post],other_candidates:[]}}));
    file('posts','995');file('authors','996');file('live','997');   // community.json is missing
    const result=await app.importSearchResults(env,async()=>{});
    assert.deepEqual(result.imported,['posts','authors','live']);assert.equal(result.errors.length,1);assert.equal(result.errors[0].worker,'community');
    assert.equal(commits.length,1);assert.match(commits[0],/enqueue workers/);
    const runs=remote.worker_runs['80:1'];
    assert.deepEqual(Object.fromEntries(Object.entries(runs).map(([w,r])=>[w,r.status])),{posts:'done',authors:'done',live:'done',community:'failed'});
    assert.ok(['post:995','post:996','post:997'].every(k=>k in remote.public_feed));
  } finally {Object.assign(proto,saved);fs.rmSync(dir,{recursive:true,force:true});}
});
