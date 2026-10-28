import http from 'node:http';
const b=http.createServer((req,res)=>{console.log('B',JSON.stringify(req.headers));res.end('ok');});
await new Promise(r=>b.listen(0,'127.0.0.1',r));
const bport=b.address().port;
const a=http.createServer((req,res)=>{res.writeHead(302,{Location:`http://127.0.0.1:${bport}/leak`});res.end();});
await new Promise(r=>a.listen(0,'127.0.0.1',r));
const aport=a.address().port;
await fetch(`http://127.0.0.1:${aport}/x`,{headers:{'x-api-key':'SECRET','Authorization':'Bearer TOKEN'}});
await new Promise(r=>setTimeout(r,100));a.close();b.close();
