import fs from 'node:fs';
import assert from 'node:assert/strict';

// No main(), no publisher, no Telegram, no GitHub state writes or credentials.
const workflow=fs.readFileSync(new URL('../.github/workflows/square_access_check.yml',import.meta.url),'utf8');
const marker="          node --input-type=module <<'JS'\n",start=workflow.indexOf(marker)+marker.length;
assert.ok(start>=marker.length);
const end=workflow.indexOf('\n          JS',start);
assert.ok(end>start);
const runtime=workflow.slice(start,end).replace(/^          /gm,'').replace(/^await main\(\)\.catch\(.*$/m,'');
const app=await import('data:text/javascript;base64,'+Buffer.from(runtime).toString('base64'));
const languages=['en','ru','zh-CN','ar',...new Set([0,1,2].flatMap(round=>app.rotatingFeedLanguages(round*120000)))];
const tasks=languages.flatMap(language=>[
  {language,source:'latest',run:()=>app.fetchLatest(2,1,language)},
  {language,source:'recommended',run:()=>app.fetchRecommended(1,language)}]);
const results=[];
for(let offset=0;offset<tasks.length;offset+=4) {
  results.push(...await Promise.all(tasks.slice(offset,offset+4).map(async task=>{
    try {
      const posts=await task.run();
      return {...task,run:undefined,ok:true,ids:new Set(posts.map(post=>String(post.id||post.contentId))),
        posts:posts.length,packet_cards:posts.filter(p=>app.normalize(p,'probe')).length};
    } catch(error){return {...task,run:undefined,ok:false,error:String(error.message)};}
  })));
}
const baseline=new Set(results.filter(r=>r.language==='en' && r.ok).flatMap(r=>[...r.ids]));
for(const result of results)console.log(JSON.stringify({...result,ids:undefined,
  unique_outside_default:result.ids?[...result.ids].filter(id=>!baseline.has(id)).length:undefined}));
const added=results.filter(r=>!['en','ru','zh-CN','ar'].includes(r.language) && r.ok);
assert.ok(added.length,'none of the additional requested language sources is available');
assert.ok(added.some(result=>[...result.ids].some(id=>!baseline.has(id))),'additional sources only duplicate the default feed');

// Read-only author-yield probe. Mirrors what ingest() enrols into the author registry (a red-envelope card or marker text,
// open or already expired) for the current and for deeper/extra sources, so new authors per request can be compared against
// the registry offline. It only prints; it never asserts, publishes or writes state.
const probeTags=['redpacket','redpacketgiveawaycampaign','redpacketmission','红包','giveaway','binance',
  'redpacketgiveaway','cryptogiveaway','freecrypto'];
const probeTargets=[
  ...probeTags.flatMap(tag=>[1,2,3,4,5].map(page=>({src:'tag:'+tag,page,run:()=>app.fetchTag(tag,page)}))),
  ...['en','zh-CN'].flatMap(language=>[1,2,3,4,5].map(page=>({src:'recommended:'+language,page,run:()=>app.fetchRecommended(page,language)}))),
  ...[1,2,3,4,5,6,7,8].map(page=>({src:'latest:type2:en',page,run:()=>app.fetchLatest(2,page)}))];
for(let offset=0;offset<probeTargets.length;offset+=4) {
  await Promise.all(probeTargets.slice(offset,offset+4).map(async target=>{
    try {
      const posts=await target.run(),authors=new Set(),stamps=posts.map(p=>Number(p.date??p.firstReleaseTime??p.createTime)||0).filter(Boolean);
      let cards=0;
      for(const post of posts) {
        const item=app.normalize(post,'probe');
        if(item)cards++;
        if(!item && !app.searchMarkers(post).length)continue;
        const uid=item?.author_id||post?.squareAuthorId||post?.squareUid;
        if(uid)authors.add(String(uid));
      }
      console.log('COVERAGE_PROBE '+JSON.stringify({src:target.src,page:target.page,ok:true,posts:posts.length,packet_cards:cards,
        newest:stamps.length?new Date(Math.max(...stamps)).toISOString():null,oldest:stamps.length?new Date(Math.min(...stamps)).toISOString():null,authors:[...authors]}));
    } catch(error) {console.log('COVERAGE_PROBE '+JSON.stringify({src:target.src,page:target.page,ok:false,error:String(error.message||error).slice(0,120)}));}
  }));
}

// Read-only sample of original-post reward metadata. This determines whether detail
// responses expose remaining amount/places that are absent from feed cards.
// Read-only public news-feed endpoint probe; no credentials, state writes or publishing.
try {
  const response=await fetch('https://www.binance.com/bapi/composite/v4/friendly/pgc/feed/news/list?pageIndex=1&pageSize=20',{
    signal:AbortSignal.timeout(12000),headers:{Accept:'application/json','User-Agent':'Mozilla/5.0',
      Referer:'https://www.binance.com/zh-CN/square/trending'}});
  const data=await response.json().catch(()=>null),root=data?.data;
  const arrays=Array.isArray(root)?[{key:'data',items:root}]:
    Object.entries(root||{}).filter(([,value])=>Array.isArray(value)).map(([key,items])=>({key,items}));
  console.log('NEWS_FEED_SOURCE_AUDIT '+JSON.stringify({http_status:response.status,success:data?.success??null,
    top_keys:Object.keys(data||{}),data_keys:Object.keys(root||{}),
    arrays:arrays.map(({key,items})=>({key,posts:items.length,
      red_envelope_metadata:items.filter(p=>p?.redEnvelop && typeof p.redEnvelop==='object').length,
      marker_matches:items.filter(p=>app.searchMarkers(p).length).length,
      sample_keys:Object.keys(items[0]||{}).slice(0,30)}))}));
} catch(error) {console.log('NEWS_FEED_SOURCE_AUDIT '+JSON.stringify({ok:false,error:String(error.message||error).slice(0,180)}));}
// Read-only hashtag and keyword endpoint audit. These probes do not enter the publisher.
const candidateTags=['cryptobox','redpacketgiveaway','binanceairdrop','giveaway','红包活动',
  'binance','airdrop','cryptogiveaway','红包','抽奖','freecrypto'];
const tagProbes=await Promise.all(candidateTags.flatMap(tag=>[1,2,3].map(async page=>{
  try {
    const posts=await app.fetchTag(tag,page);
    const eligible=posts.map(p=>app.normalize(p,'tag-probe')).filter(p=>p && app.isEligiblePost(p));
    return {tag,page,ok:true,posts:posts.length,red_envelope_metadata:posts.filter(p=>p?.redEnvelop && typeof p.redEnvelop==='object').length,
      marker_matches:posts.filter(p=>app.searchMarkers(p).length).length,eligible_ids:eligible.map(p=>p.post_id)};
  } catch(error) {return {tag,page,ok:false,error:String(error.message||error).slice(0,160)};}
})));
console.log('HASHTAG_SOURCE_AUDIT '+JSON.stringify(tagProbes.map(({eligible_ids,...row})=>({...row,eligible_count:eligible_ids?.length||0}))));
const keywordProbes=await Promise.all(['Red Packet','Crypto Box'].map(async term=>{
  try {const posts=await app.fetchKeyword(term);return {term,ok:true,posts:posts.length,
    red_envelope_metadata:posts.filter(p=>p?.redEnvelop && typeof p.redEnvelop==='object').length,
    marker_matches:posts.filter(p=>app.searchMarkers(p).length).length};}
  catch(error){return {term,ok:false,error:String(error.message||error).slice(0,160)};}
}));
console.log('KEYWORD_SOURCE_AUDIT '+JSON.stringify(keywordProbes));
const snapshot=await app.scan({SQUARE_STATE_SNAPSHOT:'.redpacket/delivery.json'},'posts');
const existingCandidates=new Set(app.publishCandidates(snapshot).map(c=>String(c.post.post_id)));
const additionalHashtagCandidates=tagProbes.flatMap(row=>(row.eligible_ids||[]).map(id=>({tag:row.tag,page:row.page,post_id:id})))
  .filter(row=>!existingCandidates.has(row.post_id));
console.log('HASHTAG_INCREMENTAL_CANDIDATES '+JSON.stringify({existing_candidates:existingCandidates.size,
  additional_unique_candidates:additionalHashtagCandidates.length,items:additionalHashtagCandidates.slice(0,50)}));
const incrementalDetails=await Promise.all(additionalHashtagCandidates.map(async row=>{
  try {const raw=await app.fetchOriginal(row.post_id),post=app.normalize(raw,'hashtag:'+row.tag);
    const identities=post?app.candidateIdentityKeys({key:'post:'+row.post_id,post}):[];
    const historyMatches=identities.filter(identity=>Object.entries(snapshot.items||{}).some(([key,item])=>
      key.endsWith(':'+identity)||(item.identity_keys||[]).includes(identity)));
    return {tag:row.tag,page:row.page,post_id:row.post_id,verified:!!post&&app.isEligiblePost(post),
      status:post?.status||null,published_at:post?.published_at||null,expires_at:post?.expires_at||null,
      currency:post?.currency||null,packet_id:post?.packet_id||null,author:post?.author||null,
      already_in_delivery_history:historyMatches.length>0,matched_identity_keys:historyMatches};}
  catch(error){return {...row,verified:false,error:String(error.message||error).slice(0,180)};}
}));
console.log('HASHTAG_INCREMENTAL_ORIGINAL_CHECK '+JSON.stringify(incrementalDetails));
let detailAudit=[];
try {
  const candidates=app.publishCandidates(snapshot)
    .filter(candidate=>/^\d+$/.test(String(candidate.post?.post_id||''))).slice(0,8);
  detailAudit=await Promise.all(candidates.map(async candidate=>{
    const post=candidate.post||{};
    const base={post_id:String(post.post_id),list:{
      currency:post.currency??null,amount:post.amount??null,
      availableAmount:post.available_amount??null,availableNumber:post.available_receivers??null,
      status:post.status??null
    }};
    const relevantKey=/amount|number|count|receiver|packet|red|envelop|reward|remain|claim|currency|coin|total|expire|runout|type|share|quantity/i;
    const result={...base};
    try {
      const original=await app.fetchOriginal(post.post_id),detail=original?.redEnvelop||{};
      const nestedKeyMap=Object.fromEntries(Object.entries(original||{})
        .filter(([,value])=>value && typeof value==='object' && !Array.isArray(value))
        .map(([key,value])=>[key,Object.keys(value).filter(name=>relevantKey.test(name))]));
      result.regular_detail={
        currency:detail.currency??null,amount:detail.amount??null,
        availableAmount:detail.availableAmount??null,number:detail.number??null,
        availableNumber:detail.availableNumber??null,isExpired:detail.isExpired??null,
        isRunOut:detail.isRunOut??null,expiredTime:detail.expiredTime??null,
        keys:Object.keys(detail),original_relevant_keys:Object.keys(original||{}).filter(key=>relevantKey.test(key)),
        nested_relevant_keys:nestedKeyMap};
    } catch(error) {result.regular_detail_error=String(error.message||error).slice(0,160);}
    try {
      const special=await app.fetchSpecialDetail(post.post_id),detail=special?.redEnvelop||{};
      result.special_detail={
        currency:detail.currency??null,amount:detail.amount??null,
        availableAmount:detail.availableAmount??null,number:detail.number??null,
        availableNumber:detail.availableNumber??null,isExpired:detail.isExpired??null,
        isRunOut:detail.isRunOut??null,expiredTime:detail.expiredTime??null,
        keys:Object.keys(detail),top_level_keys:Object.keys(special||{}).filter(key=>relevantKey.test(key))};
    } catch(error) {result.special_detail_error=String(error.message||error).slice(0,160);}
    return result;
  }));
  if(!candidates.length)detailAudit=[{eligible_candidates:app.publishCandidates(snapshot).length,reason:'No eligible numeric post IDs to sample'}];
} catch(error) {
  detailAudit=[{audit_error:String(error.message||error).slice(0,160)}];
}
console.log('ORIGINAL_REWARD_METADATA_AUDIT '+JSON.stringify(detailAudit));
console.log('FULL_SCAN '+JSON.stringify({all_sources_failed:snapshot.all_sources_failed,partial:snapshot.partial,
  discovery:snapshot.discovery_stats,eligible_candidates:app.publishCandidates(snapshot).length,
  sources:snapshot.sources.filter(s=>s.language_requested || s.tag==='square:feed-keywords' || /budget/.test(s.tag))}));
assert.equal(snapshot.all_sources_failed,false);
