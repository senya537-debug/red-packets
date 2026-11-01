// Read-only probe: which anonymous Square endpoints work from a GitHub runner.
// No secrets, no Telegram, no state writes. Prints a short report.
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const base=term=>({'Accept':'application/json, text/plain, */*','Accept-Language':'en-US,en;q=0.9','Content-Type':'application/json',
  Origin:'https://www.binance.com',Referer:'https://www.binance.com/en/square/search?s='+encodeURIComponent(term),
  'User-Agent':UA,clienttype:'web',lang:'en','bnc-uuid':crypto.randomUUID(),'x-trace-id':crypto.randomUUID()});
const term='Red Packet Quiz';
const posts=(u,body,extra={})=>({name:u.split('/bapi/')[1]+' '+JSON.stringify(body).slice(0,90),url:u,
  init:{method:'POST',headers:{...base(term),...extra},body:JSON.stringify(body)}});
const gets=(u,q)=>({name:u.split('/bapi/')[1]+'?'+new URLSearchParams(q),url:u+'?'+new URLSearchParams(q),
  init:{headers:{...base(term),'Content-Type':undefined}}});
const B='https://www.binance.com/bapi/composite/';
const cases=[
  posts(B+'v2/friendly/pgc/feed/search/list',{scene:'web',pageIndex:1,pageSize:20,searchContent:term,type:1}),
  posts(B+'v2/friendly/pgc/feed/search/list',{scene:'web',pageIndex:1,pageSize:20,searchContent:term,type:2}),
  posts(B+'v2/friendly/pgc/feed/search/list',{scene:'web',pageIndex:1,pageSize:20,searchContent:term}),
  posts(B+'v1/friendly/pgc/feed/search/list',{scene:'web',pageIndex:1,pageSize:20,searchContent:term,type:1}),
  posts(B+'v3/friendly/pgc/feed/search/list',{scene:'web',pageIndex:1,pageSize:20,searchContent:term,type:1}),
  posts(B+'v1/public/pgc/search/post',{keyword:term,pageIndex:1,pageSize:20}),
  gets(B+'v1/friendly/pgc/feed/search/list',{searchContent:term,pageIndex:'1',pageSize:'20',type:'1'}),
  gets(B+'v3/friendly/pgc/content/article/list',{pageIndex:'1',pageSize:'20',type:'1'}),
  gets(B+'v1/friendly/pgc/hashtag/hot-list',{}),
  gets(B+'v1/friendly/pgc/feed/hashtag/list',{hashtag:'#redpacket',pageIndex:'3',pageSize:'50',orderBy:'LATEST'}),
  gets(B+'v1/friendly/pgc/feed/hashtag/list',{hashtag:'#redpacket',pageIndex:'10',pageSize:'50',orderBy:'LATEST'}),
  gets(B+'v1/friendly/pgc/feed/hashtag/list',{hashtag:'#redpacket',pageIndex:'1',pageSize:'50',orderBy:'HOT'}),
];
for(const c of cases){
  try{
    const r=await fetch(c.url,{...c.init,signal:AbortSignal.timeout(15000)});
    const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}
    const d=j?.data;
    const arr=d?.vos||d?.feedData||d?.list||(Array.isArray(d)?d:null);
    console.log(r.status,c.name,'| success=',j?.success,'| msg=',String(j?.message||'').slice(0,60),'| items=',arr?.length??'-',
      '| redEnvelop=',arr?arr.filter(p=>p.redEnvelop||p.redPacket).length:'-','| keys=',d&&!arr?Object.keys(d).slice(0,6).join(','):'');
  }catch(e){console.log('ERR',c.name,String(e.message).slice(0,80));}
}
