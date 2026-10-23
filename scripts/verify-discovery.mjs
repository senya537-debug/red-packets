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
const snapshot=await app.scan({SQUARE_STATE_SNAPSHOT:'.redpacket/delivery.json'},'posts');
console.log('FULL_SCAN '+JSON.stringify({all_sources_failed:snapshot.all_sources_failed,partial:snapshot.partial,
  discovery:snapshot.discovery_stats,eligible_candidates:app.publishCandidates(snapshot).length,
  sources:snapshot.sources.filter(s=>s.language_requested || s.tag==='square:feed-keywords' || /budget/.test(s.tag))}));
assert.equal(snapshot.all_sources_failed,false);
