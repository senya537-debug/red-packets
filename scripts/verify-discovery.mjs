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
let detailAudit=[];
try {
  const feed=await app.fetchLatest(2,1,'en');
  const samples=feed.filter(post=>post?.redEnvelop && /^\d+$/.test(String(post.id||''))).slice(0,8);
  detailAudit=await Promise.all(samples.map(async post=>{
    const envelope=post.redEnvelop||{};
    const base={post_id:String(post.id),list:{
      currency:envelope.currency??null,amount:envelope.amount??null,
      availableAmount:envelope.availableAmount??null,availableNumber:envelope.availableNumber??null,
      isExpired:envelope.isExpired??null,isRunOut:envelope.isRunOut??null,
      expiredTime:envelope.expiredTime??null
    }};
    try {
      const original=await app.fetchOriginal(post.id),detail=original?.redEnvelop||{};
      return {...base,detail:{
        currency:detail.currency??null,amount:detail.amount??null,
        availableAmount:detail.availableAmount??null,availableNumber:detail.availableNumber??null,
        isExpired:detail.isExpired??null,isRunOut:detail.isRunOut??null,
        expiredTime:detail.expiredTime??null
      },detail_has_redEnvelop:!!original?.redEnvelop};
    } catch(error) {return {...base,detail_error:String(error.message||error).slice(0,160)};}
  }));
} catch(error) {
  detailAudit=[{audit_error:String(error.message||error).slice(0,160)}];
}
console.log('ORIGINAL_REWARD_METADATA_AUDIT '+JSON.stringify(detailAudit));

const snapshot=await app.scan({SQUARE_STATE_SNAPSHOT:'.redpacket/delivery.json'},'posts');
console.log('FULL_SCAN '+JSON.stringify({all_sources_failed:snapshot.all_sources_failed,partial:snapshot.partial,
  discovery:snapshot.discovery_stats,eligible_candidates:app.publishCandidates(snapshot).length,
  sources:snapshot.sources.filter(s=>s.language_requested || s.tag==='square:feed-keywords' || /budget/.test(s.tag))}));
assert.equal(snapshot.all_sources_failed,false);
