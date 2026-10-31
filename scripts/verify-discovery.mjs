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

// Read-only sample of original-post reward metadata. This determines whether detail
// responses expose remaining amount/places that are absent from feed cards.
const snapshot=await app.scan({SQUARE_STATE_SNAPSHOT:'.redpacket/delivery.json'},'posts');
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
