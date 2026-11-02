// Read-only probe: do extra hashtags carry OPEN red packets on page 1?
// "open" = listing has redEnvelop, not expired, not run out, not past expiredTime.
// No secrets, no Telegram, no state writes.
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H='https://www.binance.com/bapi/composite/v4/friendly/pgc/content/queryByHashtag';
const known=['redpacket','redpacketgiveawaycampaign','binanceredpacket','redpacketmission','redpacketquiz','红包','giveaway','binance'];
const extra=['redpackets','redpacketgiveaway','redpacketcampaign','redpacketreward','redpacketshare','redpacketcode',
  'cryptogifting','gift','airdrop','redpacketcrypto','binancesquare','squareredpacket','红包福利','红包雨'];
const seen=new Map();
for(const [group,tags] of [['known',known],['NEW',extra]]) for(const tag of tags){
  const url=H+'?'+new URLSearchParams({hashtag:'#'+tag,pageIndex:'1',pageSize:'50',orderBy:'LATEST'});
  try{
    const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':UA,clienttype:'web',
      Referer:'https://www.binance.com/en/square/hashtag/'+encodeURIComponent(tag)},signal:AbortSignal.timeout(15000)});
    const j=await r.json().catch(()=>null),arr=j?.data?.feedData;
    if(!Array.isArray(arr)){console.log(group,tag,'HTTP',r.status,String(j?.message||'').slice(0,50));continue;}
    const now=Date.now();
    const open=arr.filter(p=>{const e=p.redEnvelop;return e&&typeof e==='object'&&!e.isExpired&&!e.isRunOut&&
      !(Number(e.expiredTime)>0&&Number(e.expiredTime)<now);});
    const fresh=open.filter(p=>!seen.has(String(p.id)));
    open.forEach(p=>seen.set(String(p.id),tag));
    const amounts=open.map(p=>Number(p.redEnvelop.amount)).filter(Number.isFinite);
    console.log(group.padEnd(5),tag.padEnd(26),'items=',String(arr.length).padStart(2),'with_packet=',String(arr.filter(p=>p.redEnvelop).length).padStart(2),
      'OPEN=',String(open.length).padStart(2),'new_vs_earlier_tags=',String(fresh.length).padStart(2),'authors=',new Set(open.map(p=>p.squareAuthorId||p.authorName)).size,
      'max_amount=',amounts.length?Math.max(...amounts):'-');
  }catch(e){console.log(group,tag,'ERR',String(e.message).slice(0,60));}
}
